/**
 * Pre-flight cost estimation.
 *
 * Shown to the user BEFORE a search runs, because a search is a spending decision
 * and surprising someone with a bill is worse than making them click twice.
 *
 * The estimate is honest about being an estimate: it exposes the assumptions it
 * used, so a wildly wrong prediction is diagnosable rather than mysterious. All
 * assumptions live in ProviderPricingConfig and are meant to be re-tuned against
 * observed funnel data — they are starting estimates, not measurements.
 */
import {
  DEFAULT_PRICING,
  FIRECRAWL_OPERATIONS,
  GOOGLE_SKUS,
  firecrawlCreditMicros,
  groqCallMicros,
  type FunnelAssumptions,
  type PricingConfig,
} from '@/config/pricing';
import type { StructuredQuery } from '@/types/domain';

import { MAX_SUBDIVISION_DEPTH, cellCountAtDepth, resolveCity } from './geography';

/** Provider ceiling: at most 3 pages per cell before subdivision takes over. */
const MAX_PAGES_PER_CELL = 3;

export interface CostEstimate {
  /** Businesses we expect to discover, after cross-cell dedupe. */
  readonly estimatedBusinesses: number;
  readonly estimatedQualifiedLeads: number;

  readonly googleRequests: number;
  readonly firecrawlCredits: number;
  readonly firecrawlSearches: number;
  readonly firecrawlScrapes: number;
  readonly groqCalls: number;

  readonly googleCostMicros: number;
  readonly firecrawlCostMicros: number;
  readonly groqCostMicros: number;
  readonly totalCostMicros: number;

  /** Micros per qualified lead — the metric that actually matters. */
  readonly costPerQualifiedLeadMicros: number;

  readonly estimatedDurationSeconds: number;

  /** Every assumption used, so the number can be argued with. */
  readonly assumptions: {
    readonly cities: number;
    readonly categories: number;
    readonly cells: number;
    readonly pagesPerCell: number;
    readonly funnel: FunnelAssumptions;
    readonly firecrawlPlan: string;
    readonly groqModel: string;
    readonly googleSku: string;
    readonly unresolvedLocations: readonly string[];
  };

  /** Caveats worth showing next to the number. */
  readonly warnings: readonly string[];
}

export interface EstimateOptions {
  readonly pricing?: PricingConfig;
  /**
   * Expected saturation depth. Common categories in metros saturate to depth 2;
   * niche categories rarely subdivide at all.
   */
  readonly assumedDepth?: number;
  /** Hard ceiling from configuration, applied before spend. */
  readonly maxResults?: number;
}

/**
 * How deeply a category is likely to subdivide.
 *
 * Density is the dominant cost driver and is category-dependent: "cafe" in Mumbai
 * saturates every cell, while "veterinary clinic" fits in one request. Guessing a
 * single depth for all categories would badly misestimate both.
 */
function assumedDepthFor(category: string): number {
  const dense = ['cafe', 'restaurant', 'salon', 'beauty', 'pharmacy', 'bakery', 'gym', 'clinic', 'store'];
  const sparse = ['veterinary', 'architect', 'law firm', 'chartered', 'diagnostic', 'physiotherapy'];

  const lower = category.toLowerCase();
  if (sparse.some((needle) => lower.includes(needle))) return 1;
  if (dense.some((needle) => lower.includes(needle))) return MAX_SUBDIVISION_DEPTH;
  return 2;
}

/**
 * Pages a cell is expected to consume.
 *
 * Not always 3: a cell that saturates gets subdivided rather than paginated to
 * exhaustion, so assuming maximum pagination everywhere would double-count.
 */
function assumedPagesPerCell(depth: number): number {
  return depth >= MAX_SUBDIVISION_DEPTH ? MAX_PAGES_PER_CELL : 2;
}

export function estimateSearchCost(
  query: StructuredQuery,
  options: EstimateOptions = {},
): CostEstimate {
  const pricing = options.pricing ?? DEFAULT_PRICING;
  const funnel = pricing.funnel;
  const warnings: string[] = [];

  const resolved = query.locations
    .map((location) => ({ location, city: resolveCity(location) }))
    .filter((entry) => entry.city !== null);
  const unresolved = query.locations.filter((location) => resolveCity(location) === null);

  if (unresolved.length > 0) {
    warnings.push(
      `${unresolved.length} location(s) are not in the city registry and will be skipped: ${unresolved.join(', ')}.`,
    );
  }

  /**
   * Nothing resolves, so nothing will run.
   *
   * Returned as a genuine zero rather than falling through: the downstream maths
   * would otherwise still charge for the one query-parse call and report a
   * non-zero cost for a search that cannot discover a single business. That is
   * exactly the kind of small dishonesty that makes a cost estimate untrustworthy.
   */
  if (resolved.length === 0) {
    warnings.push('No recognised locations, so this search would discover nothing.');
    return {
      estimatedBusinesses: 0,
      estimatedQualifiedLeads: 0,
      googleRequests: 0,
      firecrawlCredits: 0,
      firecrawlSearches: 0,
      firecrawlScrapes: 0,
      groqCalls: 0,
      googleCostMicros: 0,
      firecrawlCostMicros: 0,
      groqCostMicros: 0,
      totalCostMicros: 0,
      costPerQualifiedLeadMicros: 0,
      estimatedDurationSeconds: 0,
      assumptions: {
        cities: 0,
        categories: query.categories.length,
        cells: 0,
        pagesPerCell: 0,
        funnel,
        firecrawlPlan: pricing.firecrawlPlan,
        groqModel: pricing.groqModel,
        googleSku: GOOGLE_SKUS[pricing.googleTextSearchSku].label,
        unresolvedLocations: unresolved,
      },
      warnings,
    };
  }

  let googleRequests = 0;
  let cells = 0;
  let pagesPerCellTotal = 0;

  for (const entry of resolved) {
    for (const category of query.categories) {
      const depth = options.assumedDepth ?? assumedDepthFor(category);
      const cellCount = cellCountAtDepth(entry.city!, depth);
      const pages = assumedPagesPerCell(depth);

      cells += cellCount;
      pagesPerCellTotal += pages;
      googleRequests += cellCount * pages;
    }
  }

  // Cross-cell overlap plus partial pages: the funnel assumption already encodes
  // observed unique businesses per billed request, which is well below the
  // theoretical 20.
  let estimatedBusinesses = Math.round(googleRequests * funnel.businessesPerSearchRequest);

  const ceiling = options.maxResults ?? query.maxResults ?? null;
  if (ceiling !== null && estimatedBusinesses > ceiling) {
    // The ceiling caps discovery, so it caps requests too — otherwise the estimate
    // would charge for pages the job will never fetch.
    const ratio = ceiling / estimatedBusinesses;
    googleRequests = Math.max(resolved.length * query.categories.length, Math.ceil(googleRequests * ratio));
    estimatedBusinesses = ceiling;
    warnings.push(`Discovery is capped at ${ceiling} businesses by the configured result limit.`);
  }

  const filtered = Math.round(estimatedBusinesses * funnel.filterPassRate);
  const firecrawlSearches = Math.round(filtered * funnel.webSearchRate);
  const homepageScrapes = Math.round(filtered * funnel.homepageScrapeRate);
  const secondPages = Math.round(homepageScrapes * funnel.secondPageRate);
  const firecrawlScrapes = homepageScrapes + secondPages;

  const firecrawlCredits =
    firecrawlSearches * FIRECRAWL_OPERATIONS.search.creditsPerUnit +
    firecrawlScrapes * FIRECRAWL_OPERATIONS.scrape.creditsPerUnit;

  const adjudications = Math.round(filtered * funnel.aiAdjudicationRate);
  const classifications = homepageScrapes;
  const narratives = Math.round(filtered * funnel.aiNarrativeRate);
  // One parse per search, not per business.
  const groqCalls = adjudications + classifications + narratives + 1;

  const googleSku = GOOGLE_SKUS[pricing.googleTextSearchSku];
  const googleCostMicros = Math.round((googleSku.per1000Micros / 1000) * googleRequests);

  const firecrawlCostMicros = Math.round(
    firecrawlCredits * firecrawlCreditMicros(pricing.firecrawlPlan),
  );

  const groqCostMicros =
    (adjudications + classifications) *
      groqCallMicros(
        pricing.groqModel,
        funnel.tokensPerClassification.input,
        funnel.tokensPerClassification.output,
      ) +
    (narratives + 1) *
      groqCallMicros(
        pricing.groqModel,
        funnel.tokensPerNarrative.input,
        funnel.tokensPerNarrative.output,
      );

  const totalCostMicros = googleCostMicros + firecrawlCostMicros + groqCostMicros;
  const estimatedQualifiedLeads = Math.max(
    1,
    Math.round(estimatedBusinesses * funnel.qualifiedLeadRate),
  );

  // Duration is dominated by provider rate limits, not compute: Firecrawl at ~6
  // requests/second is the binding constraint on a large job.
  const firecrawlSeconds = (firecrawlSearches + firecrawlScrapes) / 6;
  const googleSeconds = googleRequests / 10;
  const groqSeconds = groqCalls / 2;
  const estimatedDurationSeconds = Math.ceil(
    Math.max(googleSeconds, firecrawlSeconds, groqSeconds) * 1.3,
  );

  if (query.categories.length * resolved.length > 20) {
    warnings.push(
      `${query.categories.length} categories x ${resolved.length} cities is ${
        query.categories.length * resolved.length
      } separate scans; consider narrowing to control cost.`,
    );
  }
  if (googleRequests > 1_000) {
    warnings.push(
      'This search exceeds the 1,000 free monthly Google Enterprise requests on its own.',
    );
  }

  return {
    estimatedBusinesses,
    estimatedQualifiedLeads,
    googleRequests,
    firecrawlCredits,
    firecrawlSearches,
    firecrawlScrapes,
    groqCalls,
    googleCostMicros,
    firecrawlCostMicros,
    groqCostMicros,
    totalCostMicros,
    costPerQualifiedLeadMicros: Math.round(totalCostMicros / estimatedQualifiedLeads),
    estimatedDurationSeconds,
    assumptions: {
      cities: resolved.length,
      categories: query.categories.length,
      cells,
      pagesPerCell:
        resolved.length * query.categories.length > 0
          ? Number((pagesPerCellTotal / (resolved.length * query.categories.length)).toFixed(2))
          : 0,
      funnel,
      firecrawlPlan: pricing.firecrawlPlan,
      groqModel: pricing.groqModel,
      googleSku: googleSku.label,
      unresolvedLocations: unresolved,
    },
    warnings,
  };
}
