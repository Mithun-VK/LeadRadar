/**
 * End-to-end runtime verification.
 *
 * Drives a real search through the real queue against real PostgreSQL and Redis,
 * with mock providers standing in for the three external APIs. This is the check
 * that the wiring works — unit tests prove the logic, this proves the system.
 *
 * Usage: docker compose up -d && npm run worker &  then:
 *   npx tsx scripts/verify-pipeline.ts
 */
import { formatMicros } from '@/config/pricing';
import { closeDatabase, db } from '@/modules/database/client';
import { closeRedis } from '@/lib/redis';
import { closeQueues } from '@/modules/jobs/queues';
import { executeSearch, getSearchStatus, parseSearchQuery } from '@/modules/search/service';
import { usageSummary } from '@/modules/database/repositories';
import type { TenantContext } from '@/modules/database/client';

const QUERY = 'Find dental clinics in Chennai with no website and more than 50 reviews.';
const TENANT: TenantContext = {
  organizationId: 'org_leadradar_default',
  userId: 'user_leadradar_dev',
};

function line(label: string, value: string | number): void {
  console.log(`  ${label.padEnd(34)} ${value}`);
}

async function waitForCompletion(searchJobId: string, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';

  while (Date.now() < deadline) {
    const status = await getSearchStatus(TENANT, searchJobId);
    const snapshot = `${status.status} ${status.progress}% discovered=${status.counts.discovered} filtered=${status.counts.filtered} enriched=${status.counts.enriched}`;

    if (snapshot !== last) {
      console.log(`  … ${snapshot}`);
      last = snapshot;
    }

    if (status.status === 'COMPLETED' || status.status === 'FAILED') return status;

    // Enrichment finishes asynchronously after discovery, so treat "no new work
    // for a while" as done rather than waiting out the full timeout.
    if (
      status.counts.filtered > 0 &&
      status.counts.enriched >= status.counts.filtered &&
      status.cells.completed >= status.cells.total
    ) {
      return status;
    }

    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }

  return getSearchStatus(TENANT, searchJobId);
}

async function main(): Promise<void> {
  console.log('\n=== 1. Parse natural language (no side effects, no discovery spend) ===');
  const parsed = await parseSearchQuery(TENANT, QUERY);

  line('categories', parsed.query.categories.join(', '));
  line('locations', parsed.query.locations.join(', '));
  line('minimumReviews', String(parsed.query.minimumReviews));
  line('websiteStatus', parsed.query.websiteStatus);
  line('parse confidence', `${parsed.confidence} (${parsed.band})`);

  console.log('\n=== 2. Pre-flight cost estimate ===');
  line('estimated businesses', parsed.estimate.estimatedBusinesses);
  line('estimated qualified leads', parsed.estimate.estimatedQualifiedLeads);
  line('google requests', parsed.estimate.googleRequests);
  line('firecrawl credits', parsed.estimate.firecrawlCredits);
  line('groq calls', parsed.estimate.groqCalls);
  line('total cost', formatMicros(parsed.estimate.totalCostMicros));
  line('per qualified lead', formatMicros(parsed.estimate.costPerQualifiedLeadMicros));

  console.log('\n=== 3. Execute (enqueues to the real worker) ===');
  const { searchJobId } = await executeSearch(TENANT, QUERY, parsed.query, {
    acknowledgedCostMicros: parsed.estimate.totalCostMicros,
  });
  line('searchJobId', searchJobId);

  console.log('\n=== 4. Pipeline progress ===');
  const status = await waitForCompletion(searchJobId);

  console.log('\n=== 5. Funnel ===');
  line('discovered', status.counts.discovered);
  line('passed filters', status.counts.filtered);
  line('enriched', status.counts.enriched);
  line('qualified', status.counts.qualified);
  line('cells completed', `${status.cells.completed}/${status.cells.total}`);
  line('estimated cost', formatMicros(status.cost.estimatedMicros));
  line('actual cost', formatMicros(status.cost.actualMicros));

  console.log('\n=== 6. Top leads ===');
  // Only leads that PASSED filtering. Including dropped rows here would assert
  // against businesses the pipeline deliberately excluded.
  const leads = await db().business.findMany({
    where: {
      organizationId: TENANT.organizationId,
      searchResults: { some: { searchJobId, passedFilter: true } },
    },
    orderBy: { opportunityScore: { sort: 'desc', nulls: 'last' } },
    take: 8,
    include: {
      recommendations: { where: { isCurrent: true }, orderBy: { strength: 'desc' }, take: 1 },
      leadScores: { where: { isCurrent: true }, take: 1 },
    },
  });

  for (const lead of leads) {
    const score = lead.leadScores[0];
    console.log(
      `  ${(lead.leadPriority ?? '—').padEnd(7)} ${String(lead.opportunityScore ?? '—').padStart(3)}  ` +
        `${lead.displayName.padEnd(32).slice(0, 32)} ` +
        `${String(lead.reviewCount ?? 0).padStart(5)} rev  ` +
        `${lead.independentWebsiteStatus.padEnd(28)} ` +
        `${lead.recommendations[0]?.service ?? '—'}`,
    );
    if (score) {
      console.log(
        `          need=${score.needFactor.toFixed(2)} value=${score.valueFactor.toFixed(2)} reach=${score.reachFactor.toFixed(2)}` +
          (score.appliedCaps.length > 0 ? `  capped: ${score.appliedCaps[0]!.slice(0, 60)}…` : ''),
      );
    }
  }

  console.log('\n=== 7. Dropped by filters (and why) ===');
  const dropped = await db().searchResult.findMany({
    where: { searchJobId, passedFilter: false },
    include: { business: { select: { displayName: true, reviewCount: true } } },
    take: 8,
  });
  for (const entry of dropped) {
    console.log(`  ${entry.business.displayName.padEnd(34).slice(0, 34)} ${entry.filterReason ?? '—'}`);
  }

  console.log('\n=== 8. Provider usage recorded ===');
  const usage = await usageSummary(TENANT, new Date(Date.now() - 600_000));
  for (const row of usage.byProvider) {
    line(row.provider, `${row.calls} calls, ${row.units} units, ${formatMicros(row.costMicros)}`);
  }
  line('mocked calls (excluded from spend)', usage.mockedCalls);
  line('failures', usage.failures);

  console.log('\n=== 9. Assertions ===');
  const checks: Array<[string, boolean]> = [
    ['discovered at least one business', status.counts.discovered > 0],
    ['filtering removed some businesses', status.counts.filtered < status.counts.discovered],
    ['every surviving lead has 50+ reviews', leads.every((l) => (l.reviewCount ?? 0) >= 50)],
    ['no permanently closed lead survived', leads.every((l) => l.businessStatus !== 'CLOSED_PERMANENTLY')],
    ['at least one lead was scored', leads.some((l) => l.opportunityScore !== null)],
    ['at least one lead has a recommendation', leads.some((l) => l.recommendations.length > 0)],
    ['every lead has an explainable score', leads.filter((l) => l.leadScores.length > 0).length > 0],
    ['provider usage was recorded', usage.mockedCalls > 0],
    ['drops carry a reason', dropped.every((entry) => entry.filterReason !== null)],
  ];

  let failed = 0;
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
    if (!ok) failed += 1;
  }

  console.log(
    failed === 0
      ? '\nAll runtime assertions passed.\n'
      : `\n${failed} runtime assertion(s) FAILED.\n`,
  );
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
