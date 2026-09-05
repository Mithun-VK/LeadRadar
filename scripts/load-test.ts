/**
 * Load validation.
 *
 * Builds a deterministic synthetic dataset and measures the operations a real
 * operator performs, at 1K / 5K / 10K leads.
 *
 * ---------------------------------------------------------------------------
 * ISOLATION
 * ---------------------------------------------------------------------------
 *
 * Everything is created inside a dedicated organization
 * (`__loadtest__<scale>`), never the seeded one. Two consequences that matter:
 * real leads are never read, written, or counted by this script, and cleanup is
 * a single cascade delete rather than a pile of hopeful `deleteMany` calls that
 * could match production rows.
 *
 * No email is sent. No provider is called. The generator writes rows directly,
 * because what is under test is the QUERY layer at volume — enrichment and
 * sending are already covered by verify:pipeline and verify:outreach, and
 * routing 10,000 leads through the real pipeline would measure the mock
 * provider's sleep timers rather than the database.
 *
 * ---------------------------------------------------------------------------
 * DETERMINISM
 * ---------------------------------------------------------------------------
 *
 * A seeded PRNG, not Math.random. Two runs at the same scale produce byte-identical
 * data, so a latency change between runs is a real change rather than a different
 * data shape. That is the whole point of a benchmark.
 *
 *   npm run load-test              # 1K, 5K, 10K
 *   npm run load-test -- 10000     # one scale
 *   npm run load-test -- 1000 --keep
 */
import 'dotenv/config';

import { performance } from 'node:perf_hooks';

import { db, closeDatabase, type TenantContext } from '@/modules/database/client';
import { closeRedis } from '@/lib/redis';
import { listLeads, leadWhere } from '@/modules/database/repositories';
import { overviewAnalytics } from '@/modules/analytics/service';
import { campaignRevenue, revenueMetrics, sourceAttribution } from '@/modules/analytics/revenue';
import { buildWorkQueue } from '@/modules/crm/work-queue';
import { listDeals, pipelineTotals } from '@/modules/crm/deals';

// ---------------------------------------------------------------------------
// Deterministic pseudo-randomness
// ---------------------------------------------------------------------------

/** mulberry32 — small, fast, and identical across runs and machines. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CITIES = ['Chennai', 'Bangalore', 'Hyderabad', 'Mumbai', 'Pune', 'Kochi'];
const CATEGORIES = ['dental clinic', 'restaurant', 'salon', 'jeweller', 'gym', 'clinic'];
const FLAGS = [
  'NO_WEBSITE',
  'POOR_MOBILE',
  'POOR_SEO',
  'NO_HTTPS',
  'MISSING_META_DESCRIPTION',
  'OUTDATED_WEBSITE',
  'NO_SOCIAL_MEDIA',
  'THIN_WEBSITE',
];
const LEAD_STATUSES = [
  'NEW',
  'QUALIFIED',
  'CONTACTED',
  'REPLIED',
  'SQL',
  'MEETING',
  'PROPOSAL',
  'WON',
  'LOST',
] as const;
const DEAL_STAGES = [
  'QUALIFICATION',
  'DISCOVERY',
  'MEETING',
  'PROPOSAL',
  'NEGOTIATION',
  'WON',
  'LOST',
] as const;

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

interface Sample {
  readonly label: string;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
  readonly runs: number;
  readonly rows: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

/**
 * Times an operation across several runs.
 *
 * The first run is discarded. It pays for connection setup and Postgres's cold
 * plan cache, and including it would report a number no user ever experiences
 * after the first page load of the day.
 */
async function measure<T>(
  label: string,
  runs: number,
  fn: () => Promise<T>,
): Promise<Sample & { last: T }> {
  await fn(); // warm-up, discarded

  const timings: number[] = [];
  let last!: T;

  for (let i = 0; i < runs; i += 1) {
    const start = performance.now();
    last = await fn();
    timings.push(performance.now() - start);
  }

  timings.sort((a, b) => a - b);

  const rows = Array.isArray(last)
    ? last.length
    : typeof last === 'object' && last !== null && 'rows' in last
      ? ((last as { rows?: unknown[] }).rows?.length ?? 0)
      : 0;

  return {
    label,
    p50: percentile(timings, 50),
    p95: percentile(timings, 95),
    p99: percentile(timings, 99),
    max: timings[timings.length - 1]!,
    runs,
    rows,
    last,
  };
}

// ---------------------------------------------------------------------------
// Dataset
// ---------------------------------------------------------------------------

const BATCH = 500;

async function buildDataset(scale: number): Promise<{ organizationId: string; ms: number }> {
  const started = performance.now();
  const random = rng(scale); // seeded by scale, so each size is reproducible
  const slug = `__loadtest__${scale}`;

  // A previous run's data, if any. Cascade handles every child table.
  await db().organization.deleteMany({ where: { slug } });

  const org = await db().organization.create({
    data: { name: `Load test ${scale}`, slug },
    select: { id: true },
  });

  // --- place identifiers, then businesses -----------------------------------
  const placeIds: string[] = [];
  for (let offset = 0; offset < scale; offset += BATCH) {
    const size = Math.min(BATCH, scale - offset);
    const rows = Array.from({ length: size }, (_, i) => ({
      googlePlaceId: `loadtest:${scale}:${offset + i}`,
    }));
    await db().placeIdentifier.createMany({ data: rows, skipDuplicates: true });
    placeIds.push(...rows.map((r) => r.googlePlaceId));
  }

  const identifiers = await db().placeIdentifier.findMany({
    where: { googlePlaceId: { in: placeIds } },
    select: { id: true, googlePlaceId: true },
  });
  const idByKey = new Map(identifiers.map((row) => [row.googlePlaceId, row.id]));

  for (let offset = 0; offset < scale; offset += BATCH) {
    const size = Math.min(BATCH, scale - offset);

    await db().business.createMany({
      data: Array.from({ length: size }, (_, i) => {
        const n = offset + i;
        const score = Math.floor(random() * 101);
        const hasEmail = random() > 0.35;
        const flagCount = 1 + Math.floor(random() * 4);

        return {
          organizationId: org.id,
          placeIdentifierId: idByKey.get(`loadtest:${scale}:${n}`)!,
          normalizedName: `load business ${n}`,
          displayName: `Load Business ${n}`,
          primaryCategory: CATEGORIES[n % CATEGORIES.length]!,
          categories: [],
          city: CITIES[n % CITIES.length]!,
          phone: `+9144${String(1000000 + n).slice(0, 7)}`,
          phoneDigits: String(441000000 + n),
          ...(hasEmail && { primaryEmail: `lead-${n}@loadtest-example.in` }),
          googleWebsiteStatus: random() > 0.4 ? 'GOOGLE_WEBSITE_PRESENT' : 'GOOGLE_WEBSITE_NOT_LISTED',
          independentWebsiteStatus:
            random() > 0.4 ? 'INDEPENDENT_WEBSITE_FOUND' : 'NO_INDEPENDENT_WEBSITE_FOUND',
          identityVerification: 'PROBABLE' as const,
          rating: Math.round((3 + random() * 2) * 10) / 10,
          reviewCount: Math.floor(random() * 800),
          opportunityScore: score,
          leadPriority: (score >= 90 ? 'A_PLUS' : score >= 75 ? 'A' : score >= 60 ? 'B' : score >= 40 ? 'C' : 'D') as never,
          websiteQualityScore: Math.floor(random() * 101),
          opportunityFlags: FLAGS.slice(0, flagCount),
          leadStatus: LEAD_STATUSES[n % LEAD_STATUSES.length]! as never,
          source: (n % 5 === 0 ? 'CSV_IMPORT' : 'WEB_DISCOVERY') as never,
          enrichedAt: new Date(),
          firstTouchAt: new Date(Date.now() - n * 60_000),
          lastTouchAt: new Date(),
        };
      }),
    });
  }

  const businesses = await db().business.findMany({
    where: { organizationId: org.id },
    select: { id: true, primaryEmail: true },
    orderBy: { createdAt: 'asc' },
  });

  // --- website analyses (one per lead with a site) --------------------------
  for (let offset = 0; offset < businesses.length; offset += BATCH) {
    const slice = businesses.slice(offset, offset + BATCH);
    await db().websiteAnalysis.createMany({
      data: slice.map((b, i) => ({
        businessId: b.id,
        url: `https://loadtest-${offset + i}.example.in`,
        domain: `loadtest-${offset + i}.example.in`,
        qualityScore: Math.floor(random() * 101),
        seoScore: Math.floor(random() * 26),
        mobileScore: Math.floor(random() * 21),
        securityScore: Math.floor(random() * 16),
        contentScore: Math.floor(random() * 26),
        trustScore: Math.floor(random() * 16),
        httpsEnabled: random() > 0.2,
        hasViewportMeta: random() > 0.3,
        hasTitle: true,
        hasMetaDescription: random() > 0.4,
        findings: [],
        analyzerVersion: '1.0.0',
        isCurrent: true,
      })),
    });
  }

  // --- email candidates -----------------------------------------------------
  const withEmail = businesses.filter((b) => b.primaryEmail);
  for (let offset = 0; offset < withEmail.length; offset += BATCH) {
    const slice = withEmail.slice(offset, offset + BATCH);
    await db().emailCandidate.createMany({
      data: slice.map((b) => ({
        businessId: b.id,
        email: b.primaryEmail!,
        domain: 'loadtest-example.in',
        source: 'PAGE_TEXT' as const,
        confidence: 0.8,
      })),
      skipDuplicates: true,
    });
  }

  // --- campaigns, enrolments, messages --------------------------------------
  const campaignCount = Math.max(2, Math.floor(scale / 1000));
  const campaigns: string[] = [];

  for (let c = 0; c < campaignCount; c += 1) {
    const campaign = await db().campaign.create({
      data: {
        organizationId: org.id,
        name: `Load campaign ${scale}-${c}`,
        status: c === 0 ? 'RUNNING' : 'COMPLETED',
        senderName: 'Load',
        companyName: 'Load Co',
      },
      select: { id: true },
    });
    campaigns.push(campaign.id);
  }

  // Roughly 60% of leads with an address get enrolled and mailed.
  const mailable = withEmail.slice(0, Math.floor(withEmail.length * 0.6));

  for (let offset = 0; offset < mailable.length; offset += BATCH) {
    const slice = mailable.slice(offset, offset + BATCH);
    const campaignId = campaigns[(offset / BATCH) % campaigns.length]!;

    await db().campaignLead.createMany({
      data: slice.map((b) => ({
        campaignId,
        businessId: b.id,
        status: 'SENT' as const,
        resolvedEmail: b.primaryEmail,
        sentAt: new Date(),
      })),
      skipDuplicates: true,
    });

    await db().emailMessage.createMany({
      data: slice.map((b, i) => ({
        organizationId: org.id,
        campaignId,
        businessId: b.id,
        toEmail: b.primaryEmail!,
        fromEmail: 'sender@loadtest-example.in',
        subject: 'Load test message',
        body: 'Synthetic load-test body.',
        status: 'SENT' as const,
        sentAt: new Date(),
        unsubscribeToken: `loadtest-${scale}-${offset + i}`,
        mocked: true,
        attempts: 1,
      })),
      skipDuplicates: true,
    });
  }

  // --- deals, activities ----------------------------------------------------
  const dealLeads = businesses.slice(0, Math.floor(scale * 0.12));
  for (let offset = 0; offset < dealLeads.length; offset += BATCH) {
    const slice = dealLeads.slice(offset, offset + BATCH);
    await db().deal.createMany({
      data: slice.map((b, i) => {
        const stage = DEAL_STAGES[(offset + i) % DEAL_STAGES.length]!;
        // A deliberate slice of unvalued deals: revenue must exclude them rather
        // than treat them as zero, and that path needs data to exercise it.
        const valued = random() > 0.2;
        return {
          organizationId: org.id,
          businessId: b.id,
          name: `Deal ${offset + i}`,
          stage: stage as never,
          ...(valued && { valueMinor: 2_500_000 + Math.floor(random() * 20_000_000) }),
          currency: 'INR',
          probability: Math.floor(random() * 101),
          ...(stage === 'WON' && { closedAt: new Date() }),
        };
      }),
    });
  }

  const activityLeads = businesses.slice(0, Math.floor(scale * 0.25));
  for (let offset = 0; offset < activityLeads.length; offset += BATCH) {
    const slice = activityLeads.slice(offset, offset + BATCH);
    await db().salesActivity.createMany({
      data: slice.map((b, i) => ({
        organizationId: org.id,
        businessId: b.id,
        type: (['EMAIL', 'CALL', 'NOTE', 'FOLLOW_UP', 'TASK'] as const)[(offset + i) % 5]!,
        title: `Activity ${offset + i}`,
        status: ((offset + i) % 3 === 0 ? 'OPEN' : 'COMPLETED') as never,
        ...((offset + i) % 3 === 0 && {
          dueAt: new Date(Date.now() + ((offset + i) % 14) * 86_400_000 - 7 * 86_400_000),
        }),
      })),
    });
  }

  return { organizationId: org.id, ms: performance.now() - started };
}

// ---------------------------------------------------------------------------
// The measured operations
// ---------------------------------------------------------------------------

async function runScale(scale: number, keep: boolean): Promise<void> {
  console.log(`\n${'='.repeat(72)}`);
  console.log(`SCALE: ${scale.toLocaleString('en-IN')} leads`);
  console.log('='.repeat(72));

  const { organizationId, ms } = await buildDataset(scale);
  const tenant: TenantContext = { organizationId };

  const counts = await Promise.all([
    db().business.count({ where: { organizationId } }),
    db().emailMessage.count({ where: { organizationId } }),
    db().deal.count({ where: { organizationId } }),
    db().salesActivity.count({ where: { organizationId } }),
    db().websiteAnalysis.count({ where: { business: { organizationId } } }),
  ]);

  console.log(
    `\nDataset built in ${(ms / 1000).toFixed(1)}s — ` +
      `leads=${counts[0]} messages=${counts[1]} deals=${counts[2]} ` +
      `activities=${counts[3]} analyses=${counts[4]}`,
  );

  const runs = scale >= 10_000 ? 5 : 10;
  const samples: Sample[] = [];

  // --- the lead table, which is the screen an operator lives in -------------
  samples.push(
    await measure('leads: first page (50)', runs, () =>
      listLeads(tenant, { pageSize: 50, page: 1 }),
    ),
  );

  samples.push(
    await measure('leads: deep page (offset ~80%)', runs, () =>
      listLeads(tenant, { pageSize: 50, page: Math.max(1, Math.floor((scale * 0.8) / 50)) }),
    ),
  );

  samples.push(
    await measure('leads: filtered (score>=70, hasEmail, flags)', runs, () =>
      listLeads(tenant, {
        pageSize: 50,
        filters: { minScore: 70, hasEmail: true, flags: ['POOR_SEO'] },
      }),
    ),
  );

  samples.push(
    await measure('leads: name search', runs, () =>
      listLeads(tenant, { pageSize: 50, filters: { search: 'Business 9' } }),
    ),
  );

  samples.push(
    await measure('leads: count only (pagination total)', runs, () =>
      db().business.count({ where: leadWhere(tenant, { minScore: 70 }) }),
    ),
  );

  // --- analytics, the heaviest read path ------------------------------------
  samples.push(await measure('analytics: overview', runs, () => overviewAnalytics(tenant)));
  samples.push(await measure('analytics: revenue metrics', runs, () => revenueMetrics(tenant)));
  samples.push(await measure('analytics: campaign revenue', runs, () => campaignRevenue(tenant)));
  samples.push(await measure('analytics: source attribution', runs, () => sourceAttribution(tenant)));

  // --- CRM ------------------------------------------------------------------
  samples.push(await measure('crm: work queue', runs, () => buildWorkQueue(tenant)));

  samples.push(
    await measure('crm: deals by stage (kanban)', runs, () =>
      db().deal.findMany({
        where: { organizationId, stage: 'PROPOSAL' },
        take: 50,
        orderBy: { updatedAt: 'desc' },
      }),
    ),
  );

  // Unbounded by construction — reads every deal and aggregates in JS. Measured
  // rather than assumed to be a problem.
  samples.push(await measure('crm: pipeline totals (all deals)', runs, () => pipelineTotals(tenant)));

  samples.push(await measure('crm: list deals', runs, () => listDeals(tenant, {})));

  // --- lead detail ----------------------------------------------------------
  const sample = await db().business.findFirst({
    where: { organizationId },
    select: { id: true },
  });

  if (sample) {
    samples.push(
      await measure('lead detail: full profile', runs, () =>
        db().business.findFirst({
          where: { id: sample.id, organizationId },
          include: {
            websiteAnalyses: { where: { isCurrent: true }, take: 1 },
            emailCandidates: true,
            emailMessages: { take: 20, orderBy: { createdAt: 'desc' } },
            campaignLeads: { include: { campaign: { select: { name: true } } } },
            deals: true,
            activities: { take: 20, orderBy: { createdAt: 'desc' } },
          },
        }),
      ),
    );
  }

  // --- report ---------------------------------------------------------------
  console.log(
    `\n${'operation'.padEnd(46)}${'p50'.padStart(9)}${'p95'.padStart(9)}${'p99'.padStart(9)}${'max'.padStart(9)}`,
  );
  console.log('-'.repeat(82));

  for (const s of samples) {
    const flag = s.p95 > 1000 ? '  ← SLOW' : s.p95 > 400 ? '  ← watch' : '';
    console.log(
      s.label.padEnd(46) +
        `${s.p50.toFixed(0)}ms`.padStart(9) +
        `${s.p95.toFixed(0)}ms`.padStart(9) +
        `${s.p99.toFixed(0)}ms`.padStart(9) +
        `${s.max.toFixed(0)}ms`.padStart(9) +
        flag,
    );
  }

  const mem = process.memoryUsage();
  console.log(
    `\nheap used ${(mem.heapUsed / 1024 / 1024).toFixed(0)} MB · ` +
      `rss ${(mem.rss / 1024 / 1024).toFixed(0)} MB · ${runs} runs per operation`,
  );

  const slow = samples.filter((s) => s.p95 > 1000);
  if (slow.length > 0) {
    console.log(`\n${slow.length} operation(s) above 1s at p95:`);
    for (const s of slow) console.log(`  - ${s.label}: p95 ${s.p95.toFixed(0)}ms`);
  }

  if (!keep) {
    await db().organization.delete({ where: { id: organizationId } });
    console.log('\nsynthetic data removed');
  } else {
    console.log(`\n--keep: data retained in organization ${organizationId}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const keep = process.argv.includes('--keep');
  const scales = args.length > 0 ? args.map(Number) : [1_000, 5_000, 10_000];

  for (const scale of scales) {
    if (!Number.isFinite(scale) || scale < 1) throw new Error(`Bad scale: ${scale}`);
    await runScale(scale, keep);
  }
}

main()
  .catch((error) => {
    console.error('\nLoad test failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.allSettled([closeDatabase(), closeRedis()]);
  });
