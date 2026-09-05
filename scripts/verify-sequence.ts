/**
 * Runtime verification of the follow-up sequence engine.
 *
 * `verify:outreach` proves a single send. This proves the harder case: a
 * multi-step sequence spread over days, where the interesting questions are all
 * about what happens BETWEEN steps.
 *
 * Runs against REAL PostgreSQL with the mock email provider, so the unique
 * constraint, the transactions, and the guard chain are genuinely exercised —
 * only the SMTP conversation is faked. The unique constraint in particular
 * cannot be tested any other way: it is the database that enforces it.
 *
 * The valuable assertions here are the negative ones. Proving step 2 sends is
 * easy. The proof that matters is that step 2 does NOT send after a reply, that
 * two workers racing the same step produce exactly one message, and that a
 * campaign with no steps still behaves as a single send.
 *
 * Time is simulated by rewriting `nextStepAt` rather than by waiting, so a
 * four-step sequence spanning ten days verifies in seconds. What is being tested
 * is the scheduling decision, not the passage of time.
 *
 *   npm run verify:sequence
 */
import 'dotenv/config';

import { randomUUID } from 'node:crypto';

import { db, closeDatabase, type TenantContext } from '@/modules/database/client';
import { closeRedis } from '@/lib/redis';
import { closeQueues } from '@/modules/jobs/queues';
import { activateCampaign, enrolLeads, setCampaignStatus } from '@/modules/email/campaigns';
import { sendCampaignEmail } from '@/modules/email/send';
import { suppress } from '@/modules/email/suppression';
import { stopCampaignsForLead } from '@/modules/email/inbox-sync';
import { storeTokens } from '@/modules/email/gmail-account';
import { activeSteps, dueLeads, nextStep } from '@/modules/email/sequence';
import { DEFAULT_TEMPLATE } from '@/modules/email/templates';
import { setControl } from '@/modules/ops/controls';
import { providers } from '@/modules/providers/registry';

const results: Array<{ label: string; pass: boolean; detail?: string }> = [];

function assert(label: string, pass: boolean, detail?: string): void {
  results.push({ label, pass, ...(detail !== undefined && { detail }) });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail && !pass ? ` — ${detail}` : ''}`);
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

async function main(): Promise<void> {
  const registry = providers();

  if (!registry.email) throw new Error('No email provider. Set MOCK_EXTERNAL_APIS=true.');
  if (!registry.email.isMock) {
    // A guard, not a nicety: this script sends, and a live provider would send
    // to whatever addresses are in the database.
    throw new Error('Refusing to run: the email provider is NOT a mock.');
  }

  const provider = registry.email;
  const run = randomUUID().slice(0, 8);
  const created: { campaigns: string[]; businesses: string[]; templates: string[] } = {
    campaigns: [],
    businesses: [],
    templates: [],
  };

  section('1. Setup');

  const org = await db().organization.findFirst({ select: { id: true } });
  if (!org) throw new Error('No organization. Run `npm run db:seed` first.');
  const tenant: TenantContext = { organizationId: org.id };

  const account = await storeTokens(tenant, {
    emailAddress: `seq-sender-${run}@leadradar.test`,
    displayName: 'Sequence Verifier',
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
      name: `Sequence verify ${run}`,
      subject: DEFAULT_TEMPLATE.subject,
      body: DEFAULT_TEMPLATE.body,
      variables: [],
    },
    select: { id: true },
  });
  created.templates.push(template.id);

  /** A lead on the reserved domain, so the mock never fails it at random. */
  const makeLead = async (suffix: string): Promise<string> => {
    const place = await db().placeIdentifier.upsert({
      where: { googlePlaceId: `verify-seq:${run}:${suffix}` },
      update: {},
      create: { googlePlaceId: `verify-seq:${run}:${suffix}` },
      select: { id: true },
    });

    const business = await db().business.create({
      data: {
        organizationId: org.id,
        placeIdentifierId: place.id,
        normalizedName: `seq ${suffix} ${run}`,
        displayName: `Seq ${suffix} Clinic ${run}`,
        primaryCategory: 'dental clinic',
        categories: [],
        city: 'Chennai',
        primaryEmail: `seq-${suffix}-${run}@verify-example.in`,
        googleWebsiteStatus: 'GOOGLE_WEBSITE_NOT_LISTED',
        independentWebsiteStatus: 'NO_INDEPENDENT_WEBSITE_FOUND',
        identityVerification: 'UNVERIFIED',
        rating: 4.5,
        reviewCount: 120,
      },
      select: { id: true },
    });
    created.businesses.push(business.id);
    return business.id;
  };

  const makeCampaign = async (name: string, steps: Array<{ delayDays: number }>) => {
    const campaign = await db().campaign.create({
      data: {
        organizationId: org.id,
        name: `${name} ${run}`,
        templateId: template.id,
        gmailAccountId: account.id,
        senderName: 'Verifier',
        companyName: 'LeadRadar Verify',
        dailyLimit: 500,
        delaySeconds: 5,
        status: 'DRAFT',
      },
      select: { id: true },
    });
    created.campaigns.push(campaign.id);

    for (const [index, step] of steps.entries()) {
      await db().campaignStep.create({
        data: {
          campaignId: campaign.id,
          stepNumber: index + 1,
          delayDays: index === 0 ? 0 : step.delayDays,
          templateId: template.id,
          active: true,
        },
      });
    }

    return campaign.id;
  };

  /** Sends whatever step the lead is currently owed. */
  const sendDueStep = async (campaignId: string, businessId: string) => {
    const steps = await activeSteps(campaignId);
    const lead = await db().campaignLead.findFirst({
      where: { campaignId, businessId },
      select: { currentStepNumber: true },
    });
    const step = nextStep(steps, lead?.currentStepNumber ?? 0);

    return sendCampaignEmail(tenant, {
      campaignId,
      businessId,
      ...(step && { stepId: step.id, stepNumber: step.stepNumber }),
      provider,
    });
  };

  /** Simulates the passage of time by making the next step due now. */
  const makeDue = async (campaignId: string, businessId: string) => {
    await db().campaignLead.updateMany({
      where: { campaignId, businessId },
      data: { nextStepAt: new Date(Date.now() - 1_000) },
    });
  };

  /**
   * Counts messages in ANY status, not just SENT.
   *
   * A reply promotes the message SENT → REPLIED (see `stopCampaignsForLead`), so
   * filtering on SENT would report zero for a lead that answered. Counting every
   * row is also the stronger assertion: "no second message was created at all"
   * catches a duplicate left in SENDING or FAILED, which a status filter would
   * quietly miss.
   */
  const messageCount = (campaignId: string, businessId: string) =>
    db().emailMessage.count({ where: { campaignId, businessId } });

  console.log(`  organization                       ${org.id}`);
  console.log(`  mailbox                            ${account.id}`);

  // -------------------------------------------------------------------------
  section('2. A four-step sequence runs to completion');

  const seqCampaign = await makeCampaign('Seq four-step', [
    { delayDays: 0 },
    { delayDays: 2 },
    { delayDays: 3 },
    { delayDays: 5 },
  ]);
  const seqLead = await makeLead('full');

  await enrolLeads(tenant, seqCampaign, [seqLead], { ai: null });
  await activateCampaign(tenant, seqCampaign);

  const first = await sendDueStep(seqCampaign, seqLead);
  assert('step 1 sends on activation', first.sent, first.detail ?? undefined);

  const afterFirst = await db().campaignLead.findFirst({
    where: { campaignId: seqCampaign, businessId: seqLead },
    select: { currentStepNumber: true, nextStepAt: true, status: true },
  });
  assert('the lead advances to step 1', afterFirst?.currentStepNumber === 1);
  assert('a follow-up is scheduled', afterFirst?.nextStepAt !== null);
  assert(
    'the lead waits as QUEUED rather than being marked SENT',
    afterFirst?.status === 'QUEUED',
    `status=${afterFirst?.status}`,
  );

  const scheduledGapDays =
    afterFirst?.nextStepAt && afterFirst.nextStepAt.getTime() > Date.now()
      ? Math.round((afterFirst.nextStepAt.getTime() - Date.now()) / 86_400_000)
      : -1;
  assert('the follow-up is two days out, per the step delay', scheduledGapDays === 2,
    `gap=${scheduledGapDays}d`);

  assert(
    'no further step is due until that time arrives',
    (await dueLeads(seqCampaign, new Date(), 5)).length === 0,
  );

  for (const expected of [2, 3, 4]) {
    await makeDue(seqCampaign, seqLead);
    const outcome = await sendDueStep(seqCampaign, seqLead);
    assert(`step ${expected} sends when due`, outcome.sent, outcome.detail ?? undefined);
  }

  const finished = await db().campaignLead.findFirst({
    where: { campaignId: seqCampaign, businessId: seqLead },
    select: { status: true, currentStepNumber: true, nextStepAt: true },
  });
  assert('the sequence completes at step 4', finished?.currentStepNumber === 4);
  assert('the lead is marked SENT once exhausted', finished?.status === 'SENT');
  assert('nothing further is scheduled', finished?.nextStepAt === null);
  assert('exactly four messages were sent', (await messageCount(seqCampaign, seqLead)) === 4);

  // -------------------------------------------------------------------------
  section('3. A reply stops the sequence');

  const replyCampaign = await makeCampaign('Seq reply', [{ delayDays: 0 }, { delayDays: 2 }]);
  const replyLead = await makeLead('reply');

  await enrolLeads(tenant, replyCampaign, [replyLead], { ai: null });
  await activateCampaign(tenant, replyCampaign);
  await sendDueStep(replyCampaign, replyLead);

  // The real reply handler, not a shortcut — this is what inbox-sync calls.
  await stopCampaignsForLead(tenant, replyLead, replyCampaign);
  await makeDue(replyCampaign, replyLead);

  const afterReply = await sendDueStep(replyCampaign, replyLead);
  assert('step 2 is refused after a reply', !afterReply.sent);
  assert(
    'and the reason names the sequence stop, not a generic block',
    afterReply.blocked === 'SEQUENCE_STOPPED',
    `blocked=${afterReply.blocked}`,
  );
  assert(
    'only the first message was ever sent',
    (await messageCount(replyCampaign, replyLead)) === 1,
  );

  // -------------------------------------------------------------------------
  section('4. Suppression between steps stops the sequence');

  const suppCampaign = await makeCampaign('Seq suppress', [{ delayDays: 0 }, { delayDays: 2 }]);
  const suppLead = await makeLead('supp');
  const suppEmail = `seq-supp-${run}@verify-example.in`;

  await enrolLeads(tenant, suppCampaign, [suppLead], { ai: null });
  await activateCampaign(tenant, suppCampaign);
  await sendDueStep(suppCampaign, suppLead);

  // Someone unsubscribes AFTER step 1 — the case a cached eligibility check misses.
  await suppress(tenant, { email: suppEmail, reason: 'UNSUBSCRIBED', detail: 'verify' });
  await makeDue(suppCampaign, suppLead);

  const afterSupp = await sendDueStep(suppCampaign, suppLead);
  assert('step 2 is refused after an unsubscribe', !afterSupp.sent);
  assert(
    'suppression is re-checked at send time, not cached from enrolment',
    afterSupp.blocked === 'SUPPRESSED' || afterSupp.blocked === 'SEQUENCE_STOPPED',
    `blocked=${afterSupp.blocked}`,
  );
  assert('only one message reached the address', (await messageCount(suppCampaign, suppLead)) === 1);

  // -------------------------------------------------------------------------
  section('5. Idempotency and concurrency');

  const idemCampaign = await makeCampaign('Seq idempotent', [
    { delayDays: 0 },
    { delayDays: 2 },
  ]);
  const idemLead = await makeLead('idem');

  await enrolLeads(tenant, idemCampaign, [idemLead], { ai: null });
  await activateCampaign(tenant, idemCampaign);
  await sendDueStep(idemCampaign, idemLead);

  // A worker retry of a step already sent.
  const steps = await activeSteps(idemCampaign);
  const stepOne = steps[0]!;
  const replay = await sendCampaignEmail(tenant, {
    campaignId: idemCampaign,
    businessId: idemLead,
    stepId: stepOne.id,
    stepNumber: stepOne.stepNumber,
    provider,
  });
  assert('a replayed step 1 is refused', !replay.sent);
  assert('and is reported as already sent', replay.blocked === 'ALREADY_SENT');
  assert('no second message exists', (await messageCount(idemCampaign, idemLead)) === 1);

  /**
   * Two workers racing the same step. The unique constraint on
   * (campaignId, businessId, campaignStepId) is what decides this — one INSERT
   * wins and the other never reaches the provider.
   */
  await makeDue(idemCampaign, idemLead);
  const stepTwo = steps[1]!;
  const raced = await Promise.all([
    sendCampaignEmail(tenant, {
      campaignId: idemCampaign,
      businessId: idemLead,
      stepId: stepTwo.id,
      stepNumber: stepTwo.stepNumber,
      provider,
    }),
    sendCampaignEmail(tenant, {
      campaignId: idemCampaign,
      businessId: idemLead,
      stepId: stepTwo.id,
      stepNumber: stepTwo.stepNumber,
      provider,
    }),
  ]);

  const sentCount = raced.filter((r) => r.sent).length;
  assert('exactly one of two concurrent workers sends', sentCount === 1, `sent=${sentCount}`);
  assert(
    'the loser reports already-sent rather than crashing',
    raced.some((r) => !r.sent && r.blocked === 'ALREADY_SENT'),
  );
  assert(
    'exactly two messages exist after the race',
    (await messageCount(idemCampaign, idemLead)) === 2,
  );

  // -------------------------------------------------------------------------
  section('6. Campaign and organization controls');

  const ctrlCampaign = await makeCampaign('Seq control', [{ delayDays: 0 }, { delayDays: 2 }]);
  const ctrlLead = await makeLead('ctrl');

  await enrolLeads(tenant, ctrlCampaign, [ctrlLead], { ai: null });
  await activateCampaign(tenant, ctrlCampaign);
  await sendDueStep(ctrlCampaign, ctrlLead);

  await setCampaignStatus(tenant, ctrlCampaign, 'PAUSED');
  await makeDue(ctrlCampaign, ctrlLead);
  const whilePaused = await sendDueStep(ctrlCampaign, ctrlLead);
  assert('a paused campaign sends no follow-up', !whilePaused.sent);
  assert('and says so', whilePaused.blocked === 'CAMPAIGN_NOT_RUNNING');

  await setCampaignStatus(tenant, ctrlCampaign, 'RUNNING');
  await setControl(tenant, { name: 'outbound', paused: true, reason: 'sequence verification' });
  const whileKilled = await sendDueStep(ctrlCampaign, ctrlLead);
  assert('the outbound kill switch stops a follow-up', !whileKilled.sent);
  assert('and names the kill switch', whileKilled.blocked === 'OUTBOUND_PAUSED');
  await setControl(tenant, { name: 'outbound', paused: false });

  const afterResume = await sendDueStep(ctrlCampaign, ctrlLead);
  assert('clearing the kill switch resumes the sequence', afterResume.sent);

  // -------------------------------------------------------------------------
  section('7. A campaign with no steps is still a single send');

  const legacyCampaign = await makeCampaign('Seq legacy', []);
  const legacyLead = await makeLead('legacy');

  await enrolLeads(tenant, legacyCampaign, [legacyLead], { ai: null });
  await activateCampaign(tenant, legacyCampaign);

  const legacyFirst = await sendDueStep(legacyCampaign, legacyLead);
  assert('a step-less campaign sends once', legacyFirst.sent);

  const legacyLeadRow = await db().campaignLead.findFirst({
    where: { campaignId: legacyCampaign, businessId: legacyLead },
    select: { status: true, nextStepAt: true },
  });
  assert('the lead is marked SENT, as before sequences existed', legacyLeadRow?.status === 'SENT');
  assert('and nothing is scheduled', legacyLeadRow?.nextStepAt === null);

  const legacySecond = await sendDueStep(legacyCampaign, legacyLead);
  assert('a second attempt is refused', !legacySecond.sent);
  assert('by the original already-sent guard', legacySecond.blocked === 'ALREADY_SENT');
  assert(
    'exactly one message exists',
    (await messageCount(legacyCampaign, legacyLead)) === 1,
  );

  // -------------------------------------------------------------------------
  section('8. Missing entities fail safely');

  const missing = await sendCampaignEmail(tenant, {
    campaignId: seqCampaign,
    businessId: 'does-not-exist',
    provider,
  });
  assert('a missing lead is refused rather than throwing', !missing.sent);
  assert('and reports it is not enrolled', missing.blocked === 'CAMPAIGN_NOT_RUNNING');

  // -------------------------------------------------------------------------
  section('9. Cleanup');

  await db().emailMessage.deleteMany({ where: { campaignId: { in: created.campaigns } } });
  await db().campaignStep.deleteMany({ where: { campaignId: { in: created.campaigns } } });
  await db().campaignLead.deleteMany({ where: { campaignId: { in: created.campaigns } } });
  await db().campaign.deleteMany({ where: { id: { in: created.campaigns } } });
  await db().business.deleteMany({ where: { id: { in: created.businesses } } });
  await db().emailTemplate.deleteMany({ where: { id: { in: created.templates } } });
  await db().suppressionEntry.deleteMany({
    where: { organizationId: org.id, email: { contains: run } },
  });
  await db().gmailAccount.delete({ where: { id: account.id } }).catch(() => undefined);
  console.log('  test data removed');
}

main()
  .catch((error) => {
    console.error('\nVerification crashed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    const failed = results.filter((r) => !r.pass);
    console.log(
      failed.length === 0
        ? `\nAll ${results.length} sequence assertions passed.`
        : `\n${failed.length} of ${results.length} assertions FAILED.`,
    );
    if (failed.length > 0) process.exitCode = 1;

    await Promise.allSettled([closeQueues(), closeDatabase(), closeRedis()]);
  });
