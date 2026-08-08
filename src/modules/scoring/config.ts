/**
 * Scoring configuration.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT A SIMPLE ADDITIVE MODEL
 * ---------------------------------------------------------------------------
 *
 * The obvious design — award +30 for "no website", +25 for "no verified
 * website", +15 for a phone number, +10 for a good rating — is what most tools
 * do, and it mis-ranks leads badly.
 *
 * Under additive weights, a clinic rated 4.0 with 20 reviews and no website
 * scores 30 + 25 + 15 + 10 = 80, which is grade A. But 20 reviews means almost no
 * customers, which usually means almost no revenue, which means no budget for a
 * website. The score has confidently identified a business that cannot buy.
 *
 * The error is treating NEED and ABILITY TO PAY as interchangeable points on one
 * axis. They are independent conditions, and commercial opportunity requires all
 * of them at once:
 *
 *     opportunity = need x value x reach
 *
 *   NEED  — how badly the business lacks digital presence. No website at all is
 *           maximum need; a thin or parked site is high need; a good site is low.
 *   VALUE — how likely the business can pay. Review volume is the best available
 *           proxy for customer throughput, and rating for whether the business is
 *           healthy enough to invest.
 *   REACH — whether an agency can actually start a conversation. A lead with no
 *           phone and no contact channel is not workable however attractive.
 *
 * Multiplication makes any near-zero factor dominate, which is the intended
 * behaviour: a business with no way to contact it is not a 90 with a caveat, it is
 * not a lead.
 *
 * The UI still renders a familiar per-signal points breakdown, because "+30 no
 * website" is how salespeople think. The breakdown is a faithful view of the same
 * computation, not a second, disagreeing model.
 *
 * These numbers are starting estimates and are meant to be recalibrated against
 * real conversion data. `SIGNALS_VERSION` exists so recalibration recomputes every
 * score without re-spending a rupee of API budget.
 */

/** Bump on any change to weights or logic; scoring jobs key on it. */
export const SIGNALS_VERSION = '1.0.0';

export interface ScoringWeights {
  /** NEED: website absence and quality. */
  readonly need: {
    readonly noWebsiteAtAll: number;
    readonly onlyThirdPartyListing: number;
    readonly websiteUnverified: number;
    readonly websiteBroken: number;
    readonly websiteParked: number;
    readonly websiteThin: number;
    readonly websiteFreeHosting: number;
    readonly noHttps: number;
    readonly noContactFunnel: number;
    readonly noBooking: number;
    readonly goodWebsite: number;
  };
  /** VALUE: demand and ability to pay. */
  readonly value: {
    readonly reviewTiers: ReadonlyArray<{ min: number; factor: number }>;
    readonly ratingBonus: ReadonlyArray<{ min: number; add: number }>;
    readonly reviewVelocityBonus: number;
    readonly chainPenalty: number;
  };
  /** REACH: contactability. */
  readonly reach: {
    readonly hasPhone: number;
    readonly hasSocial: number;
    readonly hasWebsiteContact: number;
    readonly base: number;
  };
}

export const DEFAULT_WEIGHTS: ScoringWeights = {
  need: {
    // No web presence at all is the strongest possible need signal.
    noWebsiteAtAll: 1.0,
    // A Practo/Zomato/Instagram-only presence: the business has no owned site,
    // and it has already demonstrated willingness to invest in being findable.
    // Commercially this is often a BETTER lead than total absence.
    onlyThirdPartyListing: 0.95,
    // We searched and found nothing we could verify. Real need, lower certainty.
    websiteUnverified: 0.8,
    websiteBroken: 0.9,
    websiteParked: 0.85,
    websiteThin: 0.7,
    websiteFreeHosting: 0.6,
    noHttps: 0.05,
    noContactFunnel: 0.08,
    noBooking: 0.04,
    // A good site is not zero need — SEO and ads remain sellable — but the
    // headline website opportunity is gone.
    goodWebsite: 0.25,
  },
  value: {
    /**
     * Review-count tiers as a multiplier, not additive points.
     *
     * Steep at the bottom deliberately: the gap between 8 reviews and 150 is the
     * difference between a business that cannot pay and one that can, and it
     * matters far more than the gap between 500 and 1,200.
     */
    reviewTiers: [
      { min: 1_000, factor: 1.0 },
      { min: 500, factor: 0.95 },
      { min: 200, factor: 0.88 },
      { min: 100, factor: 0.8 },
      { min: 50, factor: 0.68 },
      { min: 20, factor: 0.5 },
      { min: 10, factor: 0.32 },
      { min: 1, factor: 0.15 },
      { min: 0, factor: 0.1 },
    ],
    /**
     * Rating adjusts value rather than driving it. A 4.8 with 12 reviews is not a
     * strong business; it is a new or quiet one.
     */
    ratingBonus: [
      { min: 4.5, add: 0.1 },
      { min: 4.0, add: 0.05 },
      { min: 3.5, add: 0.0 },
      // A poor rating signals a struggling business: less able to invest, and a
      // harder engagement even if it does.
      { min: 0, add: -0.15 },
    ],
    /**
     * Growing review counts mean an active, investing business. Available only
     * because Google data must be refreshed rather than hoarded — a compliance
     * constraint turned into signal no static scrape can produce.
     */
    reviewVelocityBonus: 0.12,
    /** Franchise outlets do not buy locally; the decision sits with HQ. */
    chainPenalty: 0.35,
  },
  reach: {
    // Base is non-zero: a business with a Maps listing is reachable in person
    // even with no phone on file.
    base: 0.45,
    hasPhone: 0.35,
    hasSocial: 0.12,
    hasWebsiteContact: 0.08,
  },
};

/**
 * Hard caps applied after the arithmetic.
 *
 * These encode commercial judgement that a smooth function cannot: a business
 * with 6 reviews is not an A-grade lead no matter how total its digital absence,
 * and presenting it as one destroys trust in the whole list.
 */
export interface ScoringCaps {
  /** Below this review count, the grade cannot exceed `lowReviewMaxGrade`. */
  readonly lowReviewThreshold: number;
  readonly lowReviewMaxScore: number;
  /** Permanently closed businesses are scored to the floor. */
  readonly closedMaxScore: number;
  /** Chains are capped: the local outlet cannot buy. */
  readonly chainMaxScore: number;
  /** Unverified identity limits confidence in the whole row. */
  readonly unverifiedMaxScore: number;
}

export const DEFAULT_CAPS: ScoringCaps = {
  lowReviewThreshold: 10,
  lowReviewMaxScore: 59, // grade C
  closedMaxScore: 5,
  chainMaxScore: 45,
  unverifiedMaxScore: 89, // cannot reach A+ on unverified identity
};

/** Grade bands. */
export const PRIORITY_BANDS = [
  { min: 90, priority: 'A_PLUS' as const, label: 'A+' },
  { min: 75, priority: 'A' as const, label: 'A' },
  { min: 60, priority: 'B' as const, label: 'B' },
  { min: 40, priority: 'C' as const, label: 'C' },
  { min: 0, priority: 'D' as const, label: 'D' },
];

export function priorityForScore(score: number): 'A_PLUS' | 'A' | 'B' | 'C' | 'D' {
  return PRIORITY_BANDS.find((band) => score >= band.min)!.priority;
}

export function priorityLabel(priority: string): string {
  return PRIORITY_BANDS.find((band) => band.priority === priority)?.label ?? priority;
}
