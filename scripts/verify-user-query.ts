/**
 * Verifies one specific user query end to end, against the real queue.
 *
 * Exists to answer the question empirically rather than by assertion: does the
 * system handle a MULTI-category, MULTI-city request with a website filter?
 *
 * Usage: npx tsx scripts/verify-user-query.ts
 */
import { formatMicros } from '@/config/pricing';
import { closeDatabase, db } from '@/modules/database/client';
import { closeRedis } from '@/lib/redis';
import { closeQueues } from '@/modules/jobs/queues';
import { executeSearch, getSearchStatus, parseSearchQuery } from '@/modules/search/service';
import type { TenantContext } from '@/modules/database/client';

const QUERY =
  'Find me the cafes and dental clinics which does not have a website listed on maps and should be located in bangalore, chennai, mumbai, delhi';

const TENANT: TenantContext = {
  organizationId: 'org_leadradar_default',
  userId: 'user_leadradar_dev',
};

function line(label: string, value: string | number): void {
  console.log(`  ${label.padEnd(30)} ${value}`);
}

async function waitFor(searchJobId: string, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  let stableFor = 0;

  while (Date.now() < deadline) {
    const status = await getSearchStatus(TENANT, searchJobId);
    const snapshot = `${status.status} ${status.progress}% d=${status.counts.discovered} f=${status.counts.filtered} e=${status.counts.enriched} q=${status.counts.qualified}`;

    if (snapshot !== last) {
      console.log(`  … ${snapshot}`);
      last = snapshot;
      stableFor = 0;
    } else {
      stableFor += 1;
    }

    if (status.status === 'COMPLETED' || status.status === 'FAILED') return status;
    /**
     * Treat a settled funnel as done — but only once discovery has actually
     * STARTED. Without the `cells.total > 0` guard, "0 of 0 cells complete" reads
     * as finished and the script reports success on a job that never ran.
     */
    if (
      stableFor >= 4 &&
      status.cells.total > 0 &&
      status.cells.completed >= status.cells.total &&
      status.counts.enriched >= status.counts.filtered
    ) {
      return status;
    }

    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }

  return getSearchStatus(TENANT, searchJobId);
}

async function main(): Promise<void> {
  console.log(`\nQuery:\n  "${QUERY}"\n`);

  console.log('=== 1. Parse ===');
  const parsed = await parseSearchQuery(TENANT, QUERY);
  line('categories', parsed.query.categories.join(' | '));
  line('locations', parsed.query.locations.join(' | '));
  line('websiteStatus', parsed.query.websiteStatus);
  line('minimumRating', String(parsed.query.minimumRating));
  line('minimumReviews', String(parsed.query.minimumReviews));
  line('unresolved locations', parsed.unresolvedLocations.join(', ') || '(none)');
  line('confidence', `${parsed.confidence} (${parsed.band})`);

  console.log('\n=== 2. Estimate ===');
  line('cities x categories', `${parsed.estimate.assumptions.cities} x ${parsed.estimate.assumptions.categories}`);
  line('geographic cells', parsed.estimate.assumptions.cells);
  line('google requests', parsed.estimate.googleRequests);
  line('estimated businesses', parsed.estimate.estimatedBusinesses);
  line('estimated cost', formatMicros(parsed.estimate.totalCostMicros));
  for (const warning of parsed.estimate.warnings) console.log(`  ! ${warning}`);

  console.log('\n=== 3. Execute ===');
  const { searchJobId } = await executeSearch(TENANT, QUERY, parsed.query, {
    acknowledgedCostMicros: parsed.estimate.totalCostMicros,
  });
  line('searchJobId', searchJobId);

  console.log('\n=== 4. Progress ===');
  const status = await waitFor(searchJobId);

  console.log('\n=== 5. Results by city and category ===');
  const leads = await db().business.findMany({
    where: {
      organizationId: TENANT.organizationId,
      searchResults: { some: { searchJobId, passedFilter: true } },
    },
    orderBy: { opportunityScore: { sort: 'desc', nulls: 'last' } },
    include: { recommendations: { where: { isCurrent: true }, orderBy: { strength: 'desc' }, take: 1 } },
  });

  const byCity = new Map<string, number>();
  const byCategory = new Map<string, number>();
  for (const lead of leads) {
    byCity.set(lead.city ?? '?', (byCity.get(lead.city ?? '?') ?? 0) + 1);
    byCategory.set(lead.primaryCategory ?? '?', (byCategory.get(lead.primaryCategory ?? '?') ?? 0) + 1);
  }

  console.log(`  cities covered:    ${[...byCity.entries()].map(([c, n]) => `${c}(${n})`).join(' ')}`);
  console.log(`  categories found:  ${[...byCategory.entries()].map(([c, n]) => `${c}(${n})`).join(' ')}`);

  console.log('\n  Leads:');
  for (const lead of leads) {
    console.log(
      `    ${(lead.leadPriority ?? '—').padEnd(7)} ${String(lead.opportunityScore ?? '—').padStart(3)}  ` +
        `${lead.displayName.padEnd(32).slice(0, 32)} ${(lead.city ?? '').padEnd(10)} ` +
        `${(lead.primaryCategory ?? '').padEnd(14)} ${lead.googleWebsiteStatus.padEnd(38)} ` +
        `${lead.recommendations[0]?.service ?? '—'}`,
    );
  }

  console.log('\n=== 6. Dropped, with reasons ===');
  const dropped = await db().searchResult.findMany({
    where: { searchJobId, passedFilter: false },
    include: { business: { select: { displayName: true, city: true, googleWebsiteStatus: true } } },
  });
  for (const entry of dropped) {
    console.log(
      `    ${entry.business.displayName.padEnd(34).slice(0, 34)} ${(entry.business.city ?? '').padEnd(10)} ${entry.filterReason ?? '—'}`,
    );
  }

  console.log('\n=== 7. Assertions ===');
  const checks: Array<[string, boolean]> = [
    ['parsed BOTH categories (cafe + dental clinic)', parsed.query.categories.length === 2],
    ['parsed ALL FOUR cities', parsed.query.locations.length === 4],
    ['every city resolved to the registry', parsed.unresolvedLocations.length === 0],
    ['understood "no website listed on maps"', parsed.query.websiteStatus === 'GOOGLE_WEBSITE_NOT_LISTED'],
    ['did not invent a rating filter', parsed.query.minimumRating === null],
    ['did not invent a review filter', parsed.query.minimumReviews === null],
    ['planned cells across all four cities', parsed.estimate.assumptions.cities === 4],
    ['search completed without error', status.status !== 'FAILED'],
    ['discovered businesses', status.counts.discovered > 0],
    ['returned leads from more than one city', byCity.size > 1],
    ['returned both categories', byCategory.size === 2],
    [
      'every returned lead lacks an owned website on Maps',
      leads.every(
        (l) =>
          l.googleWebsiteStatus === 'GOOGLE_WEBSITE_NOT_LISTED' ||
          l.googleWebsiteStatus === 'GOOGLE_WEBSITE_IS_THIRD_PARTY_LISTING',
      ),
    ],
    ['leads were scored', leads.some((l) => l.opportunityScore !== null)],
  ];

  let failed = 0;
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
    if (!ok) failed += 1;
  }

  console.log(failed === 0 ? '\nQuery fully supported.\n' : `\n${failed} check(s) failed.\n`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main()
  .catch((error: unknown) => {
    console.error('\nVerification failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.allSettled([closeQueues(), closeDatabase(), closeRedis()]);
  });
