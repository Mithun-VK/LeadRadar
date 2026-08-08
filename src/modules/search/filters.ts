/**
 * Deterministic filtering — the cheapest and most valuable stage.
 *
 * Every business dropped here is a business LeadRadar does not pay Firecrawl to
 * scrape or Groq to classify. At the funnel rates in the cost model this stage
 * removes ~55% of discovered businesses for zero marginal cost, which is a larger
 * saving than every other optimisation combined.
 *
 * Pure functions, no I/O, no AI. Rating and review thresholds have exact answers;
 * asking a model would be slower, costlier, and occasionally wrong.
 */
import type { NormalizedBusiness, StructuredQuery } from '@/types/domain';

export type FilterReason =
  | 'CLOSED_PERMANENTLY'
  | 'CLOSED_TEMPORARILY'
  | 'RATING_BELOW_MINIMUM'
  | 'RATING_ABOVE_MAXIMUM'
  | 'RATING_MISSING'
  | 'REVIEWS_BELOW_MINIMUM'
  | 'REVIEWS_ABOVE_MAXIMUM'
  | 'REVIEWS_MISSING'
  | 'WEBSITE_STATUS_MISMATCH'
  | 'CHAIN_EXCLUDED'
  | 'CATEGORY_MISMATCH'
  | 'CITY_MISMATCH';

export interface FilterOutcome {
  readonly passed: boolean;
  readonly reason?: FilterReason;
  /** Human-readable explanation shown in the UI when a lead was dropped. */
  readonly detail?: string;
}

export interface FilterContext {
  readonly query: StructuredQuery;
  /** Cities the search targeted, for locality sanity-checking. */
  readonly expectedCities?: readonly string[];
  /** Chain detection result, computed at normalization. */
  readonly isChain?: boolean;
}

/**
 * Applies the query's filters to one business.
 *
 * Returns the first failing reason rather than all of them: the reason exists to
 * explain a drop to a user, and the first one is the actionable one.
 */
export function applyFilters(
  business: NormalizedBusiness,
  context: FilterContext,
): FilterOutcome {
  const { query } = context;

  // Closed first: it is the cheapest check and the most complete disqualifier.
  // A permanently closed business cannot buy anything.
  if (business.businessStatus === 'CLOSED_PERMANENTLY') {
    return { passed: false, reason: 'CLOSED_PERMANENTLY', detail: 'Permanently closed on Google' };
  }
  if (business.businessStatus === 'CLOSED_TEMPORARILY') {
    return { passed: false, reason: 'CLOSED_TEMPORARILY', detail: 'Temporarily closed on Google' };
  }

  if (query.minimumRating !== null) {
    if (business.rating === null) {
      // Unrated is not zero-rated. It is excluded from a rating filter because
      // the filter cannot be evaluated, and the distinction is reported honestly.
      return { passed: false, reason: 'RATING_MISSING', detail: 'No rating available' };
    }
    if (business.rating < query.minimumRating) {
      return {
        passed: false,
        reason: 'RATING_BELOW_MINIMUM',
        detail: `Rating ${business.rating} is below ${query.minimumRating}`,
      };
    }
  }

  if (query.maximumRating !== null && business.rating !== null && business.rating > query.maximumRating) {
    return {
      passed: false,
      reason: 'RATING_ABOVE_MAXIMUM',
      detail: `Rating ${business.rating} is above ${query.maximumRating}`,
    };
  }

  if (query.minimumReviews !== null) {
    if (business.reviewCount === null) {
      return { passed: false, reason: 'REVIEWS_MISSING', detail: 'No review count available' };
    }
    if (business.reviewCount < query.minimumReviews) {
      return {
        passed: false,
        reason: 'REVIEWS_BELOW_MINIMUM',
        detail: `${business.reviewCount} reviews is below ${query.minimumReviews}`,
      };
    }
  }

  if (
    query.maximumReviews !== null &&
    business.reviewCount !== null &&
    business.reviewCount > query.maximumReviews
  ) {
    return {
      passed: false,
      reason: 'REVIEWS_ABOVE_MAXIMUM',
      detail: `${business.reviewCount} reviews is above ${query.maximumReviews}`,
    };
  }

  /**
   * Website filtering, with one deliberate asymmetry.
   *
   * A user asking for "no website" is asking for businesses without an owned web
   * presence. A third-party listing URL (Practo, Zomato, Instagram, Linktree)
   * means exactly that, so those businesses PASS a GOOGLE_WEBSITE_NOT_LISTED
   * filter even though Google technically has a URL for them.
   *
   * Treating them as "has a website" would discard the best web-development leads
   * in the dataset, which is the mistake every Maps scraper makes.
   */
  if (query.websiteStatus !== 'ANY') {
    const actual = business.googleWebsiteStatus;
    const wanted = query.websiteStatus;

    const satisfies =
      actual === wanted ||
      (wanted === 'GOOGLE_WEBSITE_NOT_LISTED' && actual === 'GOOGLE_WEBSITE_IS_THIRD_PARTY_LISTING');

    if (!satisfies) {
      return {
        passed: false,
        reason: 'WEBSITE_STATUS_MISMATCH',
        detail: `Website status is ${actual}, wanted ${wanted}`,
      };
    }
  }

  if (query.excludeChains && context.isChain) {
    return {
      passed: false,
      reason: 'CHAIN_EXCLUDED',
      detail: 'Appears to be a chain or franchise outlet',
    };
  }

  // Locality sanity check. Google occasionally returns a business just outside a
  // restricted rectangle; enriching it wastes budget on a lead in the wrong city.
  if (context.expectedCities?.length && business.city) {
    const actual = business.city.toLowerCase();
    const matches = context.expectedCities.some(
      (city) => actual.includes(city.toLowerCase()) || city.toLowerCase().includes(actual),
    );
    if (!matches) {
      return {
        passed: false,
        reason: 'CITY_MISMATCH',
        detail: `${business.city} is outside the searched cities`,
      };
    }
  }

  return { passed: true };
}

export interface PartitionedResults {
  readonly passed: NormalizedBusiness[];
  readonly dropped: Array<{ business: NormalizedBusiness; outcome: FilterOutcome }>;
  readonly reasonCounts: Record<string, number>;
}

/**
 * Partitions a batch, keeping the dropped set and its reasons.
 *
 * Dropped businesses are retained rather than discarded so the UI can show what a
 * search excluded and why. "Found 4,000, qualified 1,800" with reasons is far
 * more trustworthy than a bare list, and it is how a user discovers their filters
 * were too strict.
 */
export function partitionByFilters(
  businesses: readonly NormalizedBusiness[],
  context: FilterContext,
  isChainOf?: (business: NormalizedBusiness) => boolean,
): PartitionedResults {
  const passed: NormalizedBusiness[] = [];
  const dropped: Array<{ business: NormalizedBusiness; outcome: FilterOutcome }> = [];
  const reasonCounts: Record<string, number> = {};

  for (const business of businesses) {
    const outcome = applyFilters(business, {
      ...context,
      isChain: isChainOf?.(business) ?? context.isChain,
    });

    if (outcome.passed) {
      passed.push(business);
    } else {
      dropped.push({ business, outcome });
      const key = outcome.reason ?? 'UNKNOWN';
      reasonCounts[key] = (reasonCounts[key] ?? 0) + 1;
    }
  }

  return { passed, dropped, reasonCounts };
}

/**
 * Whether a business still needs website discovery.
 *
 * Both "no website listed" and "the listed website is a directory" need it. Only a
 * genuine owned-domain URL can skip discovery — and even then the site itself is
 * still inspected, because a live URL and a working business website are not the
 * same thing.
 */
export function needsWebsiteDiscovery(business: {
  googleWebsiteStatus: string;
}): boolean {
  return (
    business.googleWebsiteStatus === 'GOOGLE_WEBSITE_NOT_LISTED' ||
    business.googleWebsiteStatus === 'GOOGLE_WEBSITE_IS_THIRD_PARTY_LISTING'
  );
}
