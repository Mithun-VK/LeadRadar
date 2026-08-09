/**
 * Digital Opportunity Score.
 *
 * Deterministic and fully explainable: given the same inputs it always produces
 * the same number, and every point can be traced to a named signal with a
 * rationale. The AI layer contributes classifications that feed in as inputs; it
 * never produces or adjusts the score.
 *
 * See ./config.ts for why this is multiplicative rather than additive.
 */
import type {
  DataProvenance,
  DigitalPresenceLevel,
  GoogleWebsiteStatus,
  IndependentWebsiteStatus,
  LeadPriority,
  ScoreBreakdown,
  ScoreSignal,
  SocialPlatform,
  VerificationLevel,
} from '@/types/domain';
import type { WebsiteQualitySignals } from '@/modules/enrichment/verification';

import {
  DEFAULT_CAPS,
  DEFAULT_WEIGHTS,
  SIGNALS_VERSION,
  priorityForScore,
  type ScoringCaps,
  type ScoringWeights,
} from './config';

export interface ScoringInput {
  readonly businessStatus: 'OPERATIONAL' | 'CLOSED_TEMPORARILY' | 'CLOSED_PERMANENTLY' | 'UNKNOWN';
  readonly googleWebsiteStatus: GoogleWebsiteStatus;
  readonly independentWebsiteStatus: IndependentWebsiteStatus;
  readonly rating: number | null;
  readonly reviewCount: number | null;
  /** Reviews added per month, when two snapshots exist. */
  readonly reviewVelocityPerMonth: number | null;
  readonly hasPhone: boolean;
  readonly socialPlatforms: readonly SocialPlatform[];
  readonly isChain: boolean;
  readonly identityVerification: VerificationLevel;
  /** Present when a verified website was fetched and assessed. */
  readonly websiteQuality: WebsiteQualitySignals | null;
}

export interface ScoringOptions {
  readonly weights?: ScoringWeights;
  readonly caps?: ScoringCaps;
}

export interface OpportunityResult extends ScoreBreakdown {
  readonly digitalPresence: DigitalPresenceLevel;
}

/** Points shown in the UI breakdown, scaled from each factor's contribution. */
const DISPLAY_BUDGET = { need: 55, value: 30, reach: 15 } as const;

/**
 * NEED: how badly this business lacks a working web presence.
 *
 * The website state machine matters here. "No website listed on Google" and "we
 * searched the web and found nothing" are different confidence levels about the
 * same need, and a listed URL that turns out to be a Practo page is not a website
 * at all.
 */
function computeNeed(
  input: ScoringInput,
  weights: ScoringWeights,
): { factor: number; signals: ScoreSignal[] } {
  const w = weights.need;
  const signals: ScoreSignal[] = [];
  let factor: number;
  let label: string;
  let rationale: string;
  let provenance: DataProvenance;

  switch (input.independentWebsiteStatus) {
    case 'INDEPENDENT_WEBSITE_FOUND': {
      const quality = input.websiteQuality;
      if (!quality) {
        factor = w.goodWebsite;
        label = 'Verified website';
        rationale = 'A website was verified as belonging to this business';
        provenance = 'APPLICATION_GENERATED';
        break;
      }
      if (quality.isParked) {
        factor = w.websiteParked;
        label = 'Website is parked or placeholder';
        rationale = 'The domain resolves but shows a placeholder rather than a real site';
      } else if (quality.isThin) {
        factor = w.websiteThin;
        label = 'Website is a single thin page';
        rationale = 'Verified site has almost no content, so it does little commercial work';
      } else if (quality.isFreeHosting) {
        factor = w.websiteFreeHosting;
        label = 'Website is on free hosting';
        rationale = 'Site runs on a free subdomain rather than an owned domain';
      } else {
        factor = w.goodWebsite;
        label = 'Functional website';
        rationale = 'Verified site has real content; the opportunity is optimisation, not a build';
      }
      provenance = 'PUBLIC_WEB';

      // Modifiers only apply once a real site exists.
      if (!quality.httpsEnabled) factor = Math.min(1, factor + w.noHttps);
      if (!quality.hasContactPage) factor = Math.min(1, factor + w.noContactFunnel);
      if (!quality.hasBookingIndicator) factor = Math.min(1, factor + w.noBooking);
      break;
    }

    case 'WEBSITE_BROKEN':
      factor = w.websiteBroken;
      label = 'Website is broken';
      rationale = 'A website exists on paper but does not load — actively losing customers';
      provenance = 'PUBLIC_WEB';
      break;

    case 'WEBSITE_MISMATCH':
    case 'NO_INDEPENDENT_WEBSITE_FOUND':
      // We looked and found nothing. Strongest evidence of genuine absence.
      factor =
        input.googleWebsiteStatus === 'GOOGLE_WEBSITE_IS_THIRD_PARTY_LISTING'
          ? w.onlyThirdPartyListing
          : w.noWebsiteAtAll;
      label =
        input.googleWebsiteStatus === 'GOOGLE_WEBSITE_IS_THIRD_PARTY_LISTING'
          ? 'Only a directory or social listing'
          : 'No website found anywhere';
      rationale =
        input.googleWebsiteStatus === 'GOOGLE_WEBSITE_IS_THIRD_PARTY_LISTING'
          ? 'Presence is limited to a third-party listing; the business owns no site of its own'
          : 'A web search found no site belonging to this business';
      provenance = 'APPLICATION_GENERATED';
      break;

    case 'WEBSITE_UNVERIFIED':
      factor = w.websiteUnverified;
      label = 'Website could not be verified';
      rationale = 'Candidates were found but none could be confirmed as this business';
      provenance = 'APPLICATION_GENERATED';
      break;

    case 'NOT_CHECKED':
    default:
      // Fall back to the Google-only view, and say so rather than implying more
      // certainty than we have.
      if (input.googleWebsiteStatus === 'GOOGLE_WEBSITE_NOT_LISTED') {
        factor = w.websiteUnverified;
        label = 'No website listed on Google';
        rationale = 'Not yet independently checked, so absence is not confirmed';
      } else if (input.googleWebsiteStatus === 'GOOGLE_WEBSITE_IS_THIRD_PARTY_LISTING') {
        factor = w.onlyThirdPartyListing;
        label = 'Listed website is a directory page';
        rationale = 'The listed URL is a directory or social profile, not an owned site';
      } else {
        factor = w.goodWebsite;
        label = 'Website listed on Google';
        rationale = 'A website is listed but has not been inspected yet';
      }
      provenance = 'GOOGLE_DERIVED';
      break;
  }

  signals.push({
    key: 'need.website',
    label,
    points: Math.round(factor * DISPLAY_BUDGET.need),
    factor: 'need',
    rationale,
    provenance,
  });

  return { factor: Math.max(0, Math.min(1, factor)), signals };
}

/** VALUE: can this business plausibly pay? */
function computeValue(
  input: ScoringInput,
  weights: ScoringWeights,
): { factor: number; signals: ScoreSignal[] } {
  const w = weights.value;
  const signals: ScoreSignal[] = [];

  const reviews = input.reviewCount ?? 0;
  const tier = w.reviewTiers.find((entry) => reviews >= entry.min) ?? w.reviewTiers.at(-1)!;
  let factor = tier.factor;

  signals.push({
    key: 'value.reviews',
    label:
      reviews === 0
        ? 'No reviews'
        : `${reviews.toLocaleString('en-IN')} review${reviews === 1 ? '' : 's'}`,
    points: Math.round(tier.factor * DISPLAY_BUDGET.value * 0.7),
    factor: 'value',
    rationale:
      reviews >= 200
        ? 'High review volume indicates strong customer throughput and budget'
        : reviews >= 50
          ? 'Moderate review volume suggests an established business'
          : 'Low review volume suggests limited throughput and limited budget',
    provenance: 'GOOGLE_DERIVED',
  });

  const rating = input.rating;
  if (rating !== null) {
    const bonus = w.ratingBonus.find((entry) => rating >= entry.min);
    if (bonus) {
      factor += bonus.add;
      signals.push({
        key: 'value.rating',
        label: `${rating.toFixed(1)} rating`,
        points: Math.round(bonus.add * DISPLAY_BUDGET.value),
        factor: 'value',
        rationale:
          bonus.add > 0
            ? 'A strong rating indicates a healthy business able to invest'
            : bonus.add < 0
              ? 'A weak rating suggests a struggling business and a harder engagement'
              : 'An average rating is neutral',
        provenance: 'GOOGLE_DERIVED',
      });
    }
  }

  // Growth beats size: an active, investing business is a better prospect than a
  // large static one.
  if (input.reviewVelocityPerMonth !== null && input.reviewVelocityPerMonth >= 3) {
    factor += w.reviewVelocityBonus;
    signals.push({
      key: 'value.velocity',
      label: `Gaining ~${Math.round(input.reviewVelocityPerMonth)} reviews/month`,
      points: Math.round(w.reviewVelocityBonus * DISPLAY_BUDGET.value),
      factor: 'value',
      rationale: 'Review growth indicates an actively trading, investing business',
      provenance: 'APPLICATION_GENERATED',
    });
  }

  if (input.isChain) {
    factor *= w.chainPenalty;
    signals.push({
      key: 'value.chain',
      label: 'Chain or franchise outlet',
      points: -Math.round((1 - w.chainPenalty) * DISPLAY_BUDGET.value),
      factor: 'value',
      rationale: 'Purchasing decisions are made at head office, not at this location',
      provenance: 'APPLICATION_GENERATED',
    });
  }

  return { factor: Math.max(0, Math.min(1, factor)), signals };
}

/** REACH: can an agency actually start a conversation? */
function computeReach(
  input: ScoringInput,
  weights: ScoringWeights,
): { factor: number; signals: ScoreSignal[] } {
  const w = weights.reach;
  const signals: ScoreSignal[] = [];
  let factor = w.base;

  if (input.hasPhone) {
    factor += w.hasPhone;
    signals.push({
      key: 'reach.phone',
      label: 'Phone number available',
      points: Math.round(w.hasPhone * DISPLAY_BUDGET.reach),
      factor: 'reach',
      rationale: 'Direct phone contact is the primary outreach channel for local business',
      provenance: 'GOOGLE_DERIVED',
    });
  } else {
    signals.push({
      key: 'reach.phone',
      label: 'No phone number',
      points: 0,
      factor: 'reach',
      rationale: 'Without a phone number this lead is materially harder to work',
      provenance: 'GOOGLE_DERIVED',
    });
  }

  if (input.socialPlatforms.length > 0) {
    factor += w.hasSocial;
    signals.push({
      key: 'reach.social',
      label: `Active on ${input.socialPlatforms.join(', ')}`,
      points: Math.round(w.hasSocial * DISPLAY_BUDGET.reach),
      factor: 'reach',
      rationale: 'Social channels give a second route in and prove digital willingness',
      provenance: 'PUBLIC_WEB',
    });
  }

  if (input.websiteQuality?.hasContactPage) {
    factor += w.hasWebsiteContact;
    signals.push({
      key: 'reach.websiteContact',
      label: 'Website has a contact page',
      points: Math.round(w.hasWebsiteContact * DISPLAY_BUDGET.reach),
      factor: 'reach',
      rationale: 'A contact page usually carries an email address for outreach',
      provenance: 'PUBLIC_WEB',
    });
  }

  return { factor: Math.max(0, Math.min(1, factor)), signals };
}

/** Digital presence, derived from the same inputs so the two never disagree. */
export function classifyDigitalPresence(input: ScoringInput): DigitalPresenceLevel {
  const quality = input.websiteQuality;
  const hasRealSite =
    input.independentWebsiteStatus === 'INDEPENDENT_WEBSITE_FOUND' &&
    quality !== null &&
    !quality.isParked &&
    !quality.isThin;

  const socials = input.socialPlatforms.length;

  if (!hasRealSite && socials === 0) return 'MINIMAL';
  if (!hasRealSite) return 'WEAK';
  if (quality!.isFreeHosting || !quality!.hasContactPage) return 'MODERATE';
  if (socials >= 2 && quality!.hasBookingIndicator && quality!.httpsEnabled) return 'EXCELLENT';
  return 'GOOD';
}

/**
 * Computes the score.
 *
 * Multiplication then caps, in that order: caps encode commercial judgement that
 * must override the arithmetic, not be averaged into it.
 */
export function scoreOpportunity(
  input: ScoringInput,
  options: ScoringOptions = {},
): OpportunityResult {
  const weights = options.weights ?? DEFAULT_WEIGHTS;
  const caps = options.caps ?? DEFAULT_CAPS;

  const need = computeNeed(input, weights);
  const value = computeValue(input, weights);
  const reach = computeReach(input, weights);

  const raw = need.factor * value.factor * reach.factor;

  /**
   * Normalisation.
   *
   * A perfect lead scores need=1.0, value=1.0, reach=1.0 → 1.0, but reach's base
   * of 0.45 means a realistic excellent lead lands near 0.92. Without correction
   * nothing would ever reach A+, so the product is scaled by the best realistically
   * attainable value rather than the theoretical maximum.
   */
  const bestRealistic = 1.0 * 1.0 * (weights.reach.base + weights.reach.hasPhone + weights.reach.hasSocial);
  let score = Math.round((raw / bestRealistic) * 100);

  /**
   * Caps encode commercial judgement the arithmetic cannot.
   *
   * The reason is recorded whenever the CONDITION holds, not only when the ceiling
   * actually bites. A user looking at a business with no website at all and asking
   * why it is not grade A needs the answer either way — "it only has 6 reviews" is
   * the useful information, regardless of whether the clamp changed the number.
   */
  const applicable: Array<{ limit: number; reason: string }> = [];

  if (input.businessStatus === 'CLOSED_PERMANENTLY') {
    applicable.push({
      limit: caps.closedMaxScore,
      reason: 'Permanently closed: cannot buy anything',
    });
  }
  if ((input.reviewCount ?? 0) < caps.lowReviewThreshold) {
    applicable.push({
      limit: caps.lowReviewMaxScore,
      reason:
        `Fewer than ${caps.lowReviewThreshold} reviews: capped at grade C regardless of the ` +
        'website gap, because low customer volume usually means no budget',
    });
  }
  if (input.isChain) {
    applicable.push({
      limit: caps.chainMaxScore,
      reason: 'Chain or franchise outlet: the purchasing decision sits with head office',
    });
  }
  if (input.identityVerification === 'UNVERIFIED') {
    applicable.push({
      limit: caps.unverifiedMaxScore,
      reason: 'Identity not independently verified: cannot reach the top band',
    });
  }

  const appliedCaps = applicable.map((cap) => cap.reason);

  // The tightest applicable ceiling wins.
  for (const cap of applicable) {
    score = Math.min(score, cap.limit);
  }

  score = Math.max(0, Math.min(100, score));

  return {
    total: score,
    priority: priorityForScore(score) as LeadPriority,
    signals: [...need.signals, ...value.signals, ...reach.signals],
    factors: {
      need: Number(need.factor.toFixed(3)),
      value: Number(value.factor.toFixed(3)),
      reach: Number(reach.factor.toFixed(3)),
    },
    signalsVersion: SIGNALS_VERSION,
    appliedCaps,
    digitalPresence: classifyDigitalPresence(input),
  };
}

/** Signal descriptions handed to the narrative task. Facts only, no prose. */
export function signalSummaries(result: OpportunityResult): string[] {
  return result.signals
    .filter((signal) => signal.points !== 0)
    .map((signal) => `${signal.label} (${signal.points > 0 ? '+' : ''}${signal.points})`);
}
