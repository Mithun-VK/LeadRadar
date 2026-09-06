/**
 * Concurrency correctness suite.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS FOR, AND WHAT IT IS NOT FOR
 * ---------------------------------------------------------------------------
 *
 * The existing load test drives 10,000 leads through the system one client at a
 * time. It answers "is it fast enough?" It cannot answer "is it *correct* when
 * two things happen at once?", because nothing in it ever overlaps.
 *
 * That is the gap this closes, and the gap is where the expensive bugs live. A
 * duplicate email is not a performance problem — it is the same prospect
 * receiving the same pitch twice, from a system whose entire value proposition
 * is not doing that.
 *
 * So this suite measures latency only as a by-product. Every section asserts an
 * INVARIANT: a count that must be exactly one, a state that must be legal, a
 * tenant that must not have moved. **No capacity claim should be drawn from
 * these numbers** — they are produced by a single Node process on a developer
 * machine against a containerised database, and they say nothing about
 * production throughput.
 *
 * ---------------------------------------------------------------------------
 * SAFETY
 * ---------------------------------------------------------------------------
 *
 * Two throwaway organizations under exact reserved slugs, deleted at the end.
 * Mock email provider only, enforced. No pre-existing organization is written.
 *
 *   npm run test:concurrency
 *   CONCURRENCY=50 npm run test:concurrency
 */
import 'dotenv/config';

import { randomUUID } from 'node:crypto';

import { db, closeDatabase, type TenantContext } from '@/modules/database/client';
import { closeRedis } from '@/lib/redis';
import { closeQueues, getQueue, QUEUE_NAMES } from '@/modules/jobs/queues';
import { providers } from '@/modules/providers/registry';
import { sendCampaignEmail } from '@/modules/email/send';
import { storeTokens } from '@/modules/email/gmail-account';
import { enrolLeads } from '@/modules/email/campaigns';
import { DEFAULT_TEMPLATE } from '@/modules/email/templates';
import { checkSuppression, suppress } from '@/modules/email/suppression';
import { changeLeadStatus } from '@/modules/crm/leads';
import { canTransition, type LeadStatus } from '@/modules/crm/lead-status';
import { createDeal, moveDealStage, canMoveStage, type DealStage } from '@/modules/crm/deals';
import { listLeads } from '@/modules/database/repositories';
import { SIGNALS_VERSION } from '@/modules/scoring/config';

const CONCURRENCY = Number(process.env.CONCURRENCY ?? 25);
const SLUG_A = '__concurrency__a';
const SLUG_B = '__concurrency__b';

// ---------------------------------------------------------------------------

interface Result {
  readonly label: string;
  readonly pass: boolean;
  readonly detail?: string;
  readonly invariant?: boolean;
}

const results: Result[] = [];
let invariantViolations = 0;

function assert(label: string, pass: boolean, detail?: string): void {
  results.push({ label, pass, ...(detail !== undefined && { detail }) });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

/** An assertion whose failure means the system produced incorrect data. */
function invariant(label: string, pass: boolean, detail?: string): void {
  if (!pass) invariantViolations += 1;
  results.push({ label, pass, invariant: true, ...(detail !== undefined && { detail }) });
  console.log(`  ${pass ? 'PASS' : 'VIOLATION'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

interface Stats {
  readonly count: number;
  readonly errors: number;
  readonly durationMs: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

/**
 * Runs `fn` `n` times concurrently, recording per-call latency and whether it
 * threw. Rejections are captured rather than propagated: in a concurrency test a
 * thrown error is frequently the *correct* outcome (a lost race on a unique
 * constraint), and a suite that aborts on the first one cannot tell the two
 * apart.
 */
async function race<T>(
  n: number,
  fn: (i: number) => Promise<T>,
): Promise<{ stats: Stats; values: T[]; errors: unknown[] }> {
  const latencies: number[] = [];
  const values: T[] = [];
  const errors: unknown[] = [];

  const started = Date.now();
  const settled = await Promise.allSettled(
    Array.from({ length: n }, async (_unused, i) => {
      const t0 = performance.now();
      try {
        return await fn(i);
      } finally {
        latencies.push(performance.now() - t0);
      }
    }),
  );
  const durationMs = Date.now() - started;

  for (const outcome of settled) {
    if (outcome.status === 'fulfilled') values.push(outcome.value);
    else errors.push(outcome.reason);
  }

  latencies.sort((a, b) => a - b);
  const at = (q: number): number =>
    latencies.length === 0 ? 0 : Math.round(latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))]!);

  return {
    stats: {
      count: n,
      errors: errors.length,
      durationMs,
      p50: at(0.5),
      p95: at(0.95),
      p99: at(0.99),
      max: latencies.length ? Math.round(latencies.at(-1)!) : 0,
    },
    values,
    errors,
  };
}

function report(label: string, stats: Stats): void {
  console.log(
    `  ${label}: ${stats.count} ops in ${stats.durationMs}ms · ` +
      `p50 ${stats.p50}ms p95 ${stats.p95}ms p99 ${stats.p99}ms max ${stats.max}ms · ` +
      `${stats.errors} rejected (${((stats.errors / stats.count) * 100).toFixed(1)}%)`,
  );
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const run = randomUUID().slice(0, 8);

interface Org {
  readonly tenant: TenantContext;
  readonly templateId: string;
  readonly gmailAccountId: string;
}

async function makeOrg(slug: string, name: string): Promise<Org> {
  const org = await db().organization.create({ data: { name, slug }, select: { id: true } });
  const tenant: TenantContext = { organizationId: org.id };

  const account = await storeTokens(tenant, {
    emailAddress: `conc-${slug}-${run}@leadradar.test`,
    displayName: 'Concurrency Sender',
    tokens: {
      accessToken: 'mock-access-token',
      refreshToken: 'mock-refresh-token',
      expiresAt: new Date(Date.now() + 3_600_000),
      scopes: ['https://www.googleapis.com/auth/gmail.send'],
    },
  });

  const template = await db().emailTemplate.create({
    data: {
      organizationId: org.id,
      name: `Concurrency ${run}`,
      // The shipped default, not a hand-written one. Personalisation variables
      // are snake_case (`{{business_name}}`, `{{sales_angle}}`), so a template
      // referencing a name the personaliser does not produce is skipped as
      // TEMPLATE_INCOMPLETE — the send path working correctly against a fixture
      // that could never occur in production.
      subject: DEFAULT_TEMPLATE.subject,
      body: DEFAULT_TEMPLATE.body,
      variables: [],
    },
    select: { id: true },
  });

  return { tenant, templateId: template.id, gmailAccountId: account.id };
}

/** A lead on the reserved verify domain, so the mock never fails it at random. */
async function makeLead(org: Org, suffix: string): Promise<string> {
  const place = await db().placeIdentifier.create({
    data: { googlePlaceId: `conc-${run}-${suffix}` },
    select: { id: true },
  });

  const business = await db().business.create({
    data: {
      organizationId: org.tenant.organizationId,
      placeIdentifierId: place.id,
      normalizedName: `conc ${suffix} ${run}`,
      displayName: `Conc ${suffix} Clinic ${run}`,
      primaryCategory: 'dental clinic',
      city: 'Chennai',
      primaryEmail: `conc-${suffix}-${run}@verify-example.in`,
      googleWebsiteStatus: 'GOOGLE_WEBSITE_NOT_LISTED',
      independentWebsiteStatus: 'NO_INDEPENDENT_WEBSITE_FOUND',
      rating: 4.5,
      reviewCount: 120,
      opportunityScore: 70,
    },
    select: { id: true },
  });
  return business.id;
}

async function makeCampaign(org: Org, name: string, steps: number): Promise<string> {
  const campaign = await db().campaign.create({
    data: {
      organizationId: org.tenant.organizationId,
      name: `${name} ${run}`,
      templateId: org.templateId,
      gmailAccountId: org.gmailAccountId,
      senderName: 'Concurrency',
      companyName: 'LeadRadar Concurrency',
      dailyLimit: 10_000,
      delaySeconds: 0,
      status: 'DRAFT',
    },
    select: { id: true },
  });

  for (let i = 1; i <= steps; i += 1) {
    await db().campaignStep.create({
      data: {
        campaignId: campaign.id,
        stepNumber: i,
        delayDays: i === 1 ? 0 : 3,
        templateId: org.templateId,
        active: true,
      },
    });
  }

  return campaign.id;
}

/**
 * Enrols leads and activates the campaign.
 *
 * Deliberately `enrolLeads` rather than a hand-built `campaignLead` row.
 * Enrolment is what populates `resolvedEmail`, renders the preview, and applies
 * the skip rules — a fixture that inserts the row directly leaves
 * `resolvedEmail` null and every send is refused with INVALID_EMAIL, which is
 * the send path working correctly against a fixture that never happens in
 * production.
 */
async function enrolAndRun(org: Org, campaignId: string, businessIds: readonly string[]) {
  const summary = await enrolLeads(org.tenant, campaignId, businessIds);
  await db().campaign.update({
    where: { id: campaignId },
    data: { status: 'RUNNING', activatedAt: new Date() },
  });
  return summary;
}

async function destroyFixtures(): Promise<void> {
  // Exact slugs, never a `startsWith` pattern: Prisma compiles `startsWith` to
  // SQL `LIKE`, where `_` matches any single character, so `'__concurrency__'`
  // would also match organizations this script does not own.
  const orgs = await db().organization.findMany({
    where: { slug: { in: [SLUG_A, SLUG_B] } },
    select: { id: true },
  });
  if (orgs.length === 0) return;

  await db().organization.deleteMany({ where: { id: { in: orgs.map((o) => o.id) } } });
  await db().placeIdentifier.deleteMany({ where: { googlePlaceId: { startsWith: 'conc-' } } });
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const registry = providers();
  if (!registry.email?.isMock) {
    throw new Error('Refusing to run: the email provider is not a mock. This script sends.');
  }
  const provider = registry.email;

  console.log(`Concurrency level: ${CONCURRENCY}`);
  const heapBefore = process.memoryUsage().heapUsed;

  await destroyFixtures();
  const a = await makeOrg(SLUG_A, 'Concurrency A');
  const b = await makeOrg(SLUG_B, 'Concurrency B');

  // -------------------------------------------------------------------------
  section('A. Concurrent lead reads');

  const readLeads = await Promise.all(
    Array.from({ length: 12 }, (_u, i) => makeLead(a, `read-${i}`)),
  );

  const reads = await race(CONCURRENCY, () => listLeads(a.tenant, { pageSize: 20 }));
  report('reads', reads.stats);

  assert('every concurrent read succeeded', reads.stats.errors === 0, `${reads.stats.errors} failed`);
  const counts = new Set(reads.values.map((r) => r.total));
  invariant(
    'concurrent reads all observed the same row count',
    counts.size === 1 && counts.has(readLeads.length),
    `distinct totals: ${[...counts].join(', ')} (expected ${readLeads.length})`,
  );

  // -------------------------------------------------------------------------
  section('B. Concurrent lead writes to the SAME row');

  const contended = readLeads[0]!;
  const targets: LeadStatus[] = ['QUALIFIED', 'CONTACTED', 'REPLIED', 'SQL'];

  const writes = await race(CONCURRENCY, (i) =>
    changeLeadStatus(a.tenant, {
      businessId: contended,
      to: targets[i % targets.length]!,
      source: 'SYSTEM',
      reason: 'concurrency probe',
    }),
  );
  report('writes', writes.stats);

  const finalLead = await db().business.findUniqueOrThrow({
    where: { id: contended },
    select: { leadStatus: true },
  });
  const history = await db().leadStatusHistory.findMany({
    where: { businessId: contended },
    orderBy: { createdAt: 'asc' },
    select: { fromStatus: true, toStatus: true },
  });

  // The point is not that every write wins — most must lose. The point is that
  // the row never lands in a state no legal path could have produced.
  const illegal = history.filter(
    (h) => h.fromStatus !== h.toStatus && !canTransition(h.fromStatus as LeadStatus, h.toStatus as LeadStatus),
  );
  invariant(
    'no illegal lead transition was recorded under contention',
    illegal.length === 0,
    illegal.map((h) => `${h.fromStatus}→${h.toStatus}`).join(', '),
  );
  invariant(
    'the final lead status is one of the attempted targets',
    targets.includes(finalLead.leadStatus as LeadStatus),
    `final ${finalLead.leadStatus}`,
  );
  invariant(
    'no history row records a self-transition',
    history.every((h) => h.fromStatus !== h.toStatus),
    `${history.filter((h) => h.fromStatus === h.toStatus).length} self-transitions`,
  );

  // -------------------------------------------------------------------------
  section('C. Concurrent scoring of the same lead');

  const scoreQueue = getQueue(QUEUE_NAMES.scoring);
  const scoreLead = readLeads[1]!;

  // Same job id from every caller: the queue must collapse them to one job.
  const enqueues = await race(CONCURRENCY, () =>
    scoreQueue.add(
      'score',
      {
        organizationId: a.tenant.organizationId,
        businessId: scoreLead,
        signalsVersion: SIGNALS_VERSION,
        withNarrative: false,
      },
      { jobId: `conc~score~${run}` },
    ),
  );
  report('score enqueues', enqueues.stats);

  const distinctJobIds = new Set(enqueues.values.map((j) => j.id));
  invariant(
    'concurrent enqueues of one job id produced exactly one job',
    distinctJobIds.size === 1,
    `${distinctJobIds.size} distinct ids`,
  );

  // -------------------------------------------------------------------------
  section('D. Concurrent campaign job enqueueing');

  const emailQueue = getQueue(QUEUE_NAMES.email);
  const dCampaign = await makeCampaign(a, 'D enqueue', 1);
  const dLeads = await Promise.all(
    Array.from({ length: 10 }, (_u, i) => makeLead(a, `enq-${i}`)),
  );

  // Distinct ids this time: every one must survive, so a lost enqueue is visible.
  const campaignEnqueues = await race(dLeads.length * 3, (i) => {
    const lead = dLeads[i % dLeads.length]!;
    return emailQueue.add(
      'send',
      { organizationId: a.tenant.organizationId, campaignId: dCampaign, businessId: lead },
      // `~` not `:` — BullMQ rejects a custom id containing a colon, and that
      // rejection silently broke campaign sending for 89 scheduler cycles.
      { jobId: `conc~send~${dCampaign}~${lead}`, delay: 3_600_000 },
    );
  });
  report('campaign enqueues', campaignEnqueues.stats);

  const uniqueSendJobs = new Set(campaignEnqueues.values.map((j) => j.id));
  invariant(
    'three concurrent enqueues per lead collapsed to one job each',
    uniqueSendJobs.size === dLeads.length,
    `${uniqueSendJobs.size} jobs for ${dLeads.length} leads`,
  );
  assert('no enqueue was rejected', campaignEnqueues.stats.errors === 0);

  // Delayed by an hour so nothing sends; removed immediately regardless.
  for (const id of uniqueSendJobs) {
    if (id) await emailQueue.remove(id);
  }

  // -------------------------------------------------------------------------
  section('E. Concurrent SAME-STEP sends — the duplicate-email invariant');

  const eCampaign = await makeCampaign(a, 'E same-step', 2);
  const eSteps = await db().campaignStep.findMany({
    where: { campaignId: eCampaign },
    orderBy: { stepNumber: 'asc' },
    select: { id: true, stepNumber: true },
  });
  const eLead = await makeLead(a, 'same-step');
  const eEnrolment = await enrolAndRun(a, eCampaign, [eLead]);
  assert(
    'the lead enrolled with a deliverable address',
    eEnrolment.enrolled === 1,
    JSON.stringify(eEnrolment),
  );

  const sends = await race(CONCURRENCY, () =>
    sendCampaignEmail(a.tenant, {
      campaignId: eCampaign,
      businessId: eLead,
      stepId: eSteps[0]!.id,
      stepNumber: eSteps[0]!.stepNumber,
      provider,
    }),
  );
  report('same-step sends', sends.stats);

  // Every message in ANY status, not just SENT: a reply promotes SENT→REPLIED,
  // and counting only SENT would hide a duplicate that had been promoted.
  const messages = await db().emailMessage.findMany({
    where: { campaignId: eCampaign, businessId: eLead },
    select: { id: true, status: true, campaignStepId: true },
  });

  invariant(
    `${CONCURRENCY} concurrent same-step sends produced exactly ONE message`,
    messages.length === 1,
    `${messages.length} messages: ${messages.map((m) => m.status).join(', ')}`,
  );

  const blockReasons = new Map<string, number>();
  for (const outcome of sends.values) {
    if (outcome.sent) continue;
    const key = `${outcome.blocked ?? 'UNKNOWN'}: ${outcome.detail ?? ''}`;
    blockReasons.set(key, (blockReasons.get(key) ?? 0) + 1);
  }
  if (blockReasons.size > 0) {
    for (const [reason, n] of blockReasons) console.log(`  blocked ×${n} — ${reason}`);
  }

  const sentOutcomes = sends.values.filter((o) => o.sent);
  invariant(
    'exactly one caller was told the send succeeded',
    sentOutcomes.length === 1,
    `${sentOutcomes.length} callers saw SENT`,
  );

  const mockSends = provider.isMock ? messages.filter((m) => m.status === 'SENT').length : 0;
  assert('the provider was asked to send at most once', mockSends <= 1, `${mockSends}`);

  // -------------------------------------------------------------------------
  section('F. Concurrent suppression');

  const fEmail = `conc-suppress-${run}@verify-example.in`;

  const suppressions = await race(CONCURRENCY, () =>
    suppress(a.tenant, { email: fEmail, reason: 'MANUAL', detail: 'concurrency probe' }),
  );
  report('suppress', suppressions.stats);

  const rows = await db().suppressionEntry.count({
    where: { organizationId: a.tenant.organizationId, email: fEmail },
  });
  invariant('concurrent suppression of one address created exactly one row', rows === 1, `${rows} rows`);
  invariant(
    'exactly one caller was told it added the entry',
    suppressions.values.filter((r) => r.added).length === 1,
    `${suppressions.values.filter((r) => r.added).length} reported added`,
  );

  const checks = await race(CONCURRENCY, () => checkSuppression(a.tenant, fEmail));
  report('checkSuppression', checks.stats);
  invariant(
    'every concurrent check saw the address as suppressed',
    checks.values.every((c) => c.suppressed),
    `${checks.values.filter((c) => !c.suppressed).length} said not suppressed`,
  );

  // The real question: can a send slip through while suppression is being written?
  const fCampaign = await makeCampaign(a, 'F suppression race', 1);
  const fStep = await db().campaignStep.findFirstOrThrow({
    where: { campaignId: fCampaign },
    select: { id: true, stepNumber: true },
  });
  const fLeads = await Promise.all(
    Array.from({ length: 10 }, (_u, i) => makeLead(a, `sup-${i}`)),
  );
  const fEnrolment = await enrolAndRun(a, fCampaign, fLeads);
  assert(
    'all suppression-race leads enrolled with deliverable addresses',
    fEnrolment.enrolled === fLeads.length,
    JSON.stringify(fEnrolment),
  );
  const fEmails = await db().business.findMany({
    where: { id: { in: fLeads } },
    select: { id: true, primaryEmail: true },
  });

  // Suppress and send at the same instant, interleaved.
  await Promise.allSettled([
    ...fEmails.map((l) =>
      suppress(a.tenant, { email: l.primaryEmail!, reason: 'UNSUBSCRIBED', detail: 'race' }),
    ),
    ...fEmails.map((l) =>
      sendCampaignEmail(a.tenant, {
        campaignId: fCampaign,
        businessId: l.id,
        stepId: fStep.id,
        stepNumber: fStep.stepNumber,
        provider,
      }),
    ),
  ]);

  const suppressedAfter = await db().suppressionEntry.findMany({
    where: { organizationId: a.tenant.organizationId, email: { in: fEmails.map((l) => l.primaryEmail!) } },
    select: { email: true, createdAt: true },
  });
  const sentToSuppressed = await db().emailMessage.findMany({
    where: { campaignId: fCampaign, status: 'SENT' },
    select: { toEmail: true, sentAt: true },
  });

  /**
   * INFORMATIONAL ONLY — deliberately not an invariant.
   *
   * When a suppression is written at the same instant a send is dispatched, one
   * of them is simply first, and no design can prevent the send that read the
   * table before the row committed. Worse, the timestamps cannot settle it:
   * `sentAt` is written AFTER the provider call, so it lands after
   * `createdAt` even when the suppression check ran first. An earlier version of
   * this script asserted on that comparison and reported a violation for a
   * correctly-handled race.
   *
   * The testable claim is the one below: once suppression is committed, no send
   * gets through. That is what "fails closed" actually means.
   */
  console.log(
    `  (informational: ${sentToSuppressed.length}/${fEmails.length} sends won the race against a simultaneous suppression;` +
      ` ${suppressedAfter.length} suppressions committed. Neither number is a defect.)`,
  );

  // Now the claim that IS testable: suppression already committed, then send.
  const settledLeads = await Promise.all(
    Array.from({ length: 10 }, (_u, i) => makeLead(a, `sup2-${i}`)),
  );
  const settledCampaign = await makeCampaign(a, 'F suppression settled', 1);
  const settledStep = await db().campaignStep.findFirstOrThrow({
    where: { campaignId: settledCampaign },
    select: { id: true, stepNumber: true },
  });
  const settledEmails = await db().business.findMany({
    where: { id: { in: settledLeads } },
    select: { id: true, primaryEmail: true },
  });

  // Enrol BEFORE suppressing, so enrolment cannot be what excludes them — the
  // send-time guard has to be the thing that refuses.
  await enrolAndRun(a, settledCampaign, settledLeads);
  for (const lead of settledEmails) {
    await suppress(a.tenant, { email: lead.primaryEmail!, reason: 'UNSUBSCRIBED', detail: 'settled' });
  }

  const settledSends = await race(settledEmails.length, (i) =>
    sendCampaignEmail(a.tenant, {
      campaignId: settledCampaign,
      businessId: settledEmails[i]!.id,
      stepId: settledStep.id,
      stepNumber: settledStep.stepNumber,
      provider,
    }),
  );
  report('sends against committed suppressions', settledSends.stats);

  const leaked = await db().emailMessage.count({
    where: { campaignId: settledCampaign, status: 'SENT' },
  });
  invariant(
    'no send succeeds once suppression is committed, even under concurrency',
    leaked === 0,
    `${leaked} messages sent to suppressed addresses`,
  );
  invariant(
    'every blocked send names suppression as the reason',
    settledSends.values.every((o) => !o.sent && o.blocked === 'SUPPRESSED'),
    settledSends.values.map((o) => o.blocked ?? 'SENT').join(', '),
  );

  // -------------------------------------------------------------------------
  section('G. Concurrent CRM state transitions');

  const gLead = await makeLead(a, 'deal');
  const deal = await createDeal(a.tenant, { businessId: gLead, name: `Conc deal ${run}`, valueMinor: 500_000 });

  const stages: DealStage[] = ['DISCOVERY', 'MEETING', 'PROPOSAL', 'NEGOTIATION', 'WON', 'LOST'];
  const moves = await race(CONCURRENCY, (i) =>
    moveDealStage(a.tenant, {
      dealId: deal.id,
      to: stages[i % stages.length]!,
      reason: 'concurrency probe',
      lostReason: 'concurrency probe',
    }),
  );
  report('deal moves', moves.stats);

  const dealAfter = await db().deal.findUniqueOrThrow({
    where: { id: deal.id },
    select: { stage: true },
  });
  const stageHistory = await db().dealStageHistory.findMany({
    where: { dealId: deal.id },
    orderBy: { createdAt: 'asc' },
    select: { fromStage: true, toStage: true },
  });

  // `fromStage` is null on a deal's first history row, which has no origin to
  // validate against.
  const illegalMoves = stageHistory.filter(
    (h) => h.fromStage !== null && !canMoveStage(h.fromStage as DealStage, h.toStage as DealStage),
  );
  invariant(
    'no illegal deal stage transition was recorded under contention',
    illegalMoves.length === 0,
    illegalMoves.map((h) => `${h.fromStage}→${h.toStage}`).join(', '),
  );
  invariant(
    'the deal landed in a stage that is reachable',
    stages.includes(dealAfter.stage as DealStage),
    `final ${dealAfter.stage}`,
  );
  console.log(
    `  (${moves.stats.errors} of ${CONCURRENCY} moves were correctly rejected as illegal from their observed stage)`,
  );

  // -------------------------------------------------------------------------
  section('H. Queue workers processing concurrently');

  const { workerStatus } = await import('@/modules/ops/heartbeat');
  const workersBefore = await workerStatus();

  if (!workersBefore.alive) {
    assert('a worker is running to process the queue', false, 'no live heartbeat — start a worker');
  } else {
    const beforeProcessed = workersBefore.workers.reduce((sum, w) => sum + w.processed, 0);
    const hLeads = await Promise.all(
      Array.from({ length: 30 }, (_u, i) => makeLead(a, `qw-${i}`)),
    );

    const before = await scoreQueue.getCompletedCount();
    const failedBefore = await scoreQueue.getFailedCount();
    for (const [i, lead] of hLeads.entries()) {
      await scoreQueue.add(
        'score',
        {
          organizationId: a.tenant.organizationId,
          businessId: lead,
          signalsVersion: SIGNALS_VERSION,
          withNarrative: false,
        },
        { jobId: `conc~qw~${run}~${i}` },
      );
    }

    // A generous deadline: two containerised workers each score 30 leads from
    // stored signals, and a laptop running a Docker VM alongside a build is not
    // a fast machine. The assertion is about completeness, not speed, so a tight
    // deadline would only produce a flake that says nothing.
    const deadline = Date.now() + 180_000;
    let completed = 0;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      completed = (await scoreQueue.getCompletedCount()) - before;
      if (completed >= hLeads.length) break;
    }

    // The heartbeat is rewritten every 15s, so reading it the instant the last
    // job completes shows a counter from before the batch. Poll past one full
    // interval before concluding anything.
    let workersAfter = await workerStatus();
    let afterProcessed = workersAfter.workers.reduce((sum, w) => sum + w.processed, 0);
    const beatDeadline = Date.now() + 40_000;
    while (afterProcessed - beforeProcessed < hLeads.length && Date.now() < beatDeadline) {
      await new Promise((r) => setTimeout(r, 2_000));
      workersAfter = await workerStatus();
      afterProcessed = workersAfter.workers.reduce((sum, w) => sum + w.processed, 0);
    }

    assert(
      `all ${hLeads.length} queued jobs completed`,
      completed >= hLeads.length,
      `${completed} completed`,
    );
    // A delta, not an absolute: the scoring queue is shared and may already hold
    // failures from an earlier run that this suite did not cause.
    const failedAfter = await scoreQueue.getFailedCount();
    assert(
      'this batch added no failed jobs',
      failedAfter <= failedBefore,
      `failed ${failedBefore} → ${failedAfter}`,
    );
    /**
     * EXACTLY, not "at least".
     *
     * `>=` hid a real defect: the counters were attached to `QueueEvents`, a
     * queue-wide stream, so every worker counted every other worker's jobs and a
     * 30-job batch across two workers measured 60. A weak assertion passed and
     * the heartbeat kept reporting a number that meant nothing.
     */
    const rise = afterProcessed - beforeProcessed;
    invariant(
      'the summed worker counters equal the job count exactly — no double counting',
      rise === hLeads.length,
      `counters rose by ${rise} for ${hLeads.length} jobs across ${workersAfter.workers.length} worker(s)`,
    );
    console.log(
      `  ${workersAfter.workers.length} worker(s) participated: ${workersAfter.workers
        .map((w) => w.workerId)
        .join(', ')}`,
    );

    // Re-adding a completed job id must not re-run it.
    const scoresBefore = await db().leadScore.count({ where: { businessId: { in: hLeads } } });
    for (const [i, lead] of hLeads.entries()) {
      await scoreQueue.add(
        'score',
        {
          organizationId: a.tenant.organizationId,
          businessId: lead,
          signalsVersion: SIGNALS_VERSION,
          withNarrative: false,
        },
        { jobId: `conc~qw~${run}~${i}` },
      );
    }
    await new Promise((r) => setTimeout(r, 3_000));
    const scoresAfter = await db().leadScore.count({ where: { businessId: { in: hLeads } } });
    invariant(
      'replaying completed job ids created no duplicate business effect',
      scoresAfter === scoresBefore,
      `lead scores ${scoresBefore} → ${scoresAfter}`,
    );
  }

  // -------------------------------------------------------------------------
  section('I. Concurrent traffic from two tenants');

  const bLeads = await Promise.all(Array.from({ length: 8 }, (_u, i) => makeLead(b, `t-${i}`)));
  const aCountBefore = await db().business.count({ where: { organizationId: a.tenant.organizationId } });
  const bCountBefore = bLeads.length;

  const mixed = await race(CONCURRENCY * 2, async (i) => {
    const org = i % 2 === 0 ? a : b;
    const page = await listLeads(org.tenant, { pageSize: 50 });
    return { org: org.tenant.organizationId, total: page.total, rows: page.rows };
  });
  report('interleaved tenant reads', mixed.stats);

  assert('no interleaved read failed', mixed.stats.errors === 0);

  const aResults = mixed.values.filter((v) => v.org === a.tenant.organizationId);
  const bResults = mixed.values.filter((v) => v.org === b.tenant.organizationId);

  invariant(
    "org A's reads never returned an org B row",
    aResults.every((r) => r.rows.every((row) => !bLeads.includes(row.id))),
  );
  invariant(
    "org B's reads never returned an org A row",
    bResults.every((r) => r.rows.every((row) => !readLeads.includes(row.id))),
  );
  invariant(
    'each tenant saw a stable count of its own rows',
    new Set(aResults.map((r) => r.total)).size === 1 && new Set(bResults.map((r) => r.total)).size === 1,
    `A totals ${[...new Set(aResults.map((r) => r.total))].join(',')} · B totals ${[...new Set(bResults.map((r) => r.total))].join(',')}`,
  );
  invariant(
    "org B's writes did not change org A's count",
    aResults.every((r) => r.total === aCountBefore),
    `expected ${aCountBefore}`,
  );
  invariant(
    "org A's writes did not change org B's count",
    bResults.every((r) => r.total === bCountBefore),
    `expected ${bCountBefore}`,
  );

  // -------------------------------------------------------------------------
  section('Resource usage');

  const heapAfter = process.memoryUsage();
  console.log(`  heap: ${(heapBefore / 1024 ** 2).toFixed(1)}MB → ${(heapAfter.heapUsed / 1024 ** 2).toFixed(1)}MB`);
  console.log(`  rss: ${(heapAfter.rss / 1024 ** 2).toFixed(1)}MB`);
  console.log(
    '\n  These figures come from ONE Node process on a developer machine against a\n' +
      '  containerised database. They are evidence of correctness under contention,\n' +
      '  NOT a production capacity measurement.',
  );

  await scoreQueue.clean(0, 5_000, 'completed').catch(() => undefined);
}

main()
  .catch((error: unknown) => {
    console.error(`\nAborted: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await destroyFixtures().catch((error) => {
      console.error('CLEANUP FAILED — remove __concurrency__ organizations manually:', error);
      process.exitCode = 1;
    });

    const failed = results.filter((r) => !r.pass);
    console.log(`\n${'='.repeat(72)}`);
    console.log(`${results.length - failed.length}/${results.length} assertions passed`);
    console.log(`invariant violations: ${invariantViolations}`);
    if (failed.length > 0) {
      console.log('\nFailures:');
      for (const f of failed) {
        console.log(`  - ${f.invariant ? '[INVARIANT] ' : ''}${f.label}${f.detail ? ` — ${f.detail}` : ''}`);
      }
      process.exitCode = 1;
    }

    await Promise.allSettled([closeQueues(), closeRedis(), closeDatabase()]);
  });
