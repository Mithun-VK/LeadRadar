/**
 * Funnel calibration.
 *
 * The assumptions in `ProviderPricingConfig.DEFAULT_FUNNEL` are the least certain
 * numbers in the system. They were estimated before a single real search ran, and
 * every pre-flight cost estimate depends on them — so an estimate that is
 * systematically 3x low is not a rounding error, it is a user being told a search
 * costs $2 when it costs $6.
 *
 * This computes the OBSERVED rates from jobs that have actually run and prints a
 * drop-in replacement block. It does not edit the config: recalibrating is a
 * judgement call about whether the sample is representative, and that judgement
 * belongs to a person.
 *
 * Usage:
 *   npm run calibrate                 # all completed searches
 *   npm run calibrate -- --days 30    # a recent window
 *   npm run calibrate -- --min-jobs 5 # refuse to report below a sample size
 */
import { DEFAULT_FUNNEL, formatMicros, microsToUsd } from '@/config/pricing';
import { closeDatabase, db } from '@/modules/database/client';

interface Options {
  readonly days: number | null;
  readonly minJobs: number;
  readonly organizationId: string | null;
}

function parseArgs(argv: readonly string[]): Options {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index !== -1 ? argv[index + 1] : undefined;
  };

  const days = get('--days');
  const minJobs = get('--min-jobs');

  return {
    days: days ? Number(days) : null,
    minJobs: minJobs ? Number(minJobs) : 3,
    organizationId: get('--org') ?? null,
  };
}

/** Formats an observed-vs-assumed pair with the direction of the error. */
function compare(label: string, assumed: number, observed: number | null, unit = ''): string {
  if (observed === null) {
    return `  ${label.padEnd(30)} ${String(assumed).padEnd(10)} (no data)`;
  }

  const ratio = assumed === 0 ? null : observed / assumed;
  const drift =
    ratio === null
      ? ''
      : ratio > 1.15
        ? `  UNDERESTIMATED by ${((ratio - 1) * 100).toFixed(0)}%`
        : ratio < 0.85
          ? `  overestimated by ${((1 - ratio) * 100).toFixed(0)}%`
          : '  ok';

  return `  ${label.padEnd(30)} ${String(assumed).padEnd(10)} ${observed.toFixed(3)}${unit}${drift}`;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const since = options.days ? new Date(Date.now() - options.days * 86_400_000) : undefined;

  const jobs = await db().searchJob.findMany({
    where: {
      status: 'COMPLETED',
      ...(since && { createdAt: { gte: since } }),
      ...(options.organizationId && { organizationId: options.organizationId }),
      // A job that discovered nothing tells us nothing about conversion rates.
      discoveredCount: { gt: 0 },
    },
    select: {
      id: true,
      discoveredCount: true,
      filteredCount: true,
      enrichedCount: true,
      qualifiedCount: true,
      estimatedCostMicros: true,
      actualCostMicros: true,
      estimatedGoogleRequests: true,
      organizationId: true,
    },
  });

  console.log('\n=== Funnel calibration ===\n');
  console.log(`  Completed searches analysed: ${jobs.length}`);
  if (since) console.log(`  Window: since ${since.toISOString().slice(0, 10)}`);

  if (jobs.length < options.minJobs) {
    console.log(
      `\n  Not enough data. Need at least ${options.minJobs} completed searches; ` +
        `found ${jobs.length}.\n` +
        '  Run some real searches first — calibrating on one job would replace an\n' +
        '  honest estimate with an overfitted one.\n',
    );
    return;
  }

  const jobIds = jobs.map((job) => job.id);

  // Provider counts come from ApiUsage rather than the job row, because that is
  // where actual billable calls are recorded — the job counters track business
  // volume, not requests.
  const usage = await db().apiUsage.groupBy({
    by: ['provider'],
    where: { searchJobId: { in: jobIds }, mocked: false },
    _sum: { units: true, costMicros: true },
    _count: { _all: true },
  });

  const googleRequests =
    usage.find((row) => row.provider === 'GOOGLE_PLACES')?._count._all ?? 0;
  const firecrawlCredits = usage.find((row) => row.provider === 'FIRECRAWL')?._sum.units ?? 0;
  const groqCalls = usage.find((row) => row.provider === 'GROQ')?._count._all ?? 0;

  const totals = jobs.reduce(
    (accumulator, job) => ({
      discovered: accumulator.discovered + job.discoveredCount,
      filtered: accumulator.filtered + job.filteredCount,
      enriched: accumulator.enriched + job.enrichedCount,
      qualified: accumulator.qualified + job.qualifiedCount,
      estimated: accumulator.estimated + job.estimatedCostMicros,
      actual: accumulator.actual + job.actualCostMicros,
    }),
    { discovered: 0, filtered: 0, enriched: 0, qualified: 0, estimated: 0, actual: 0 },
  );

  const safeRatio = (numerator: number, denominator: number): number | null =>
    denominator > 0 ? numerator / denominator : null;

  const observed = {
    businessesPerSearchRequest: safeRatio(totals.discovered, googleRequests),
    filterPassRate: safeRatio(totals.filtered, totals.discovered),
    qualifiedLeadRate: safeRatio(totals.qualified, totals.discovered),
    // Credits per FILTERED business is the meaningful denominator: enrichment only
    // ever runs on businesses that survived filtering.
    creditsPerFilteredBusiness: safeRatio(firecrawlCredits, totals.filtered),
    groqCallsPerFilteredBusiness: safeRatio(groqCalls, totals.filtered),
  };

  console.log('\n--- Volumes ---');
  console.log(`  Businesses discovered:        ${totals.discovered.toLocaleString('en-IN')}`);
  console.log(`  Passed filters:               ${totals.filtered.toLocaleString('en-IN')}`);
  console.log(`  Enriched:                     ${totals.enriched.toLocaleString('en-IN')}`);
  console.log(`  Qualified (A/B):              ${totals.qualified.toLocaleString('en-IN')}`);
  console.log(`  Google requests billed:       ${googleRequests.toLocaleString('en-IN')}`);
  console.log(`  Firecrawl credits:            ${firecrawlCredits.toLocaleString('en-IN')}`);
  console.log(`  Groq calls:                   ${groqCalls.toLocaleString('en-IN')}`);

  console.log('\n--- Assumption vs observed ---');
  console.log('  (assumed values are DEFAULT_FUNNEL in src/config/pricing.ts)\n');
  console.log(`  ${'metric'.padEnd(30)} ${'assumed'.padEnd(10)} observed`);
  console.log(
    compare(
      'businessesPerSearchRequest',
      DEFAULT_FUNNEL.businessesPerSearchRequest,
      observed.businessesPerSearchRequest,
    ),
  );
  console.log(compare('filterPassRate', DEFAULT_FUNNEL.filterPassRate, observed.filterPassRate));
  console.log(
    compare('qualifiedLeadRate', DEFAULT_FUNNEL.qualifiedLeadRate, observed.qualifiedLeadRate),
  );

  console.log('\n--- Cost accuracy ---');
  const costRatio = totals.estimated > 0 ? totals.actual / totals.estimated : null;
  console.log(`  Estimated total:              ${formatMicros(totals.estimated)}`);
  console.log(`  Actual total:                 ${formatMicros(totals.actual)}`);
  if (costRatio !== null) {
    console.log(`  Actual / estimated:           ${(costRatio * 100).toFixed(0)}%`);
    console.log(
      costRatio > 1.3
        ? '  → Estimates are running LOW. Users are being under-quoted.'
        : costRatio < 0.7
          ? '  → Estimates are running high. Safe, but discourages larger searches.'
          : '  → Estimates are tracking actual spend.',
    );
  }

  if (totals.qualified > 0) {
    console.log(
      `  Cost per qualified lead:      ${formatMicros(Math.round(totals.actual / totals.qualified))}`,
    );
  }

  console.log('\n--- Suggested DEFAULT_FUNNEL ---');
  console.log('  Paste into src/config/pricing.ts ONLY if this sample is representative.');
  console.log('  A sample dominated by one city or one category will not generalise.\n');

  const suggest = (assumed: number, value: number | null, decimals = 2): string =>
    value === null ? String(assumed) : value.toFixed(decimals);

  console.log('export const DEFAULT_FUNNEL: FunnelAssumptions = {');
  console.log(
    `  businessesPerSearchRequest: ${suggest(DEFAULT_FUNNEL.businessesPerSearchRequest, observed.businessesPerSearchRequest, 0)},`,
  );
  console.log(
    `  filterPassRate: ${suggest(DEFAULT_FUNNEL.filterPassRate, observed.filterPassRate)},`,
  );
  console.log(`  webSearchRate: ${DEFAULT_FUNNEL.webSearchRate}, // not separately measured yet`);
  console.log(
    `  homepageScrapeRate: ${DEFAULT_FUNNEL.homepageScrapeRate}, // implied by credits below`,
  );
  console.log(`  secondPageRate: ${DEFAULT_FUNNEL.secondPageRate},`);
  console.log(`  aiAdjudicationRate: ${DEFAULT_FUNNEL.aiAdjudicationRate},`);
  console.log(`  aiNarrativeRate: ${DEFAULT_FUNNEL.aiNarrativeRate},`);
  console.log(
    `  qualifiedLeadRate: ${suggest(DEFAULT_FUNNEL.qualifiedLeadRate, observed.qualifiedLeadRate)},`,
  );
  console.log(`  tokensPerClassification: ${JSON.stringify(DEFAULT_FUNNEL.tokensPerClassification)},`);
  console.log(`  tokensPerNarrative: ${JSON.stringify(DEFAULT_FUNNEL.tokensPerNarrative)},`);
  console.log('};');

  if (observed.creditsPerFilteredBusiness !== null) {
    const assumedCredits =
      DEFAULT_FUNNEL.webSearchRate * 2 +
      DEFAULT_FUNNEL.homepageScrapeRate * (1 + DEFAULT_FUNNEL.secondPageRate);
    console.log('\n--- Firecrawl credit intensity ---');
    console.log(`  Assumed credits per filtered business:  ${assumedCredits.toFixed(2)}`);
    console.log(
      `  Observed credits per filtered business: ${observed.creditsPerFilteredBusiness.toFixed(2)}`,
    );
    console.log(
      '  If observed is materially higher, either webSearchRate or secondPageRate is',
    );
    console.log('  too low — check the enrichment decision trail on a few leads to see which.');
  }

  if (observed.groqCallsPerFilteredBusiness !== null) {
    const assumedGroq =
      DEFAULT_FUNNEL.aiAdjudicationRate +
      DEFAULT_FUNNEL.homepageScrapeRate +
      DEFAULT_FUNNEL.aiNarrativeRate;
    console.log('\n--- Groq call intensity ---');
    console.log(`  Assumed calls per filtered business:  ${assumedGroq.toFixed(2)}`);
    console.log(
      `  Observed calls per filtered business: ${observed.groqCallsPerFilteredBusiness.toFixed(2)}`,
    );
    console.log(
      `  At ${formatMicros(Math.round(microsToUsd(1) * 1))}/call this is rarely worth optimising —`,
    );
    console.log('  Groq is the cheapest network call in the stack. Check it only if it is');
    console.log('  wildly high, which would indicate deterministic matching is failing.');
  }

  console.log('');
}

main()
  .catch((error: unknown) => {
    console.error('Calibration failed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDatabase();
  });
