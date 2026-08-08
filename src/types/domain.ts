/**
 * Domain vocabulary.
 *
 * These types are provider-agnostic on purpose: nothing here mentions Google,
 * Firecrawl, or Groq. Provider adapters translate into these types at their
 * boundary, which is what allows a provider to be swapped without touching
 * scoring, filtering, or the UI.
 */

// ---------------------------------------------------------------------------
// Provenance — the load-bearing distinction in this product
// ---------------------------------------------------------------------------

/**
 * Where a field came from. This governs retention and export, so it is part of
 * the domain model rather than a database detail.
 *
 * - GOOGLE_DERIVED: obtained from the Places API. Subject to provider caching
 *   and attribution rules; held with a TTL; excluded from exports by default.
 * - PLACE_IDENTIFIER: the Place ID itself, which providers permit storing
 *   indefinitely. Kept separate precisely because its rules differ.
 * - PUBLIC_WEB: gathered by our own crawl of the business's own site or a
 *   public search result. Ours to keep.
 * - APPLICATION_GENERATED: computed by LeadRadar (scores, classifications,
 *   verification verdicts). Ours to keep.
 */
export type DataProvenance =
  | 'GOOGLE_DERIVED'
  | 'PLACE_IDENTIFIER'
  | 'PUBLIC_WEB'
  | 'APPLICATION_GENERATED';

/**
 * How much a stated fact should be trusted. Every lead field that could be
 * wrong carries one of these — the product never presents an inference as a
 * fact.
 */
export type VerificationLevel = 'VERIFIED' | 'PROBABLE' | 'UNVERIFIED' | 'UNKNOWN';

/** A value plus its provenance and trust level. */
export interface Attributed<T> {
  readonly value: T;
  readonly provenance: DataProvenance;
  readonly verification: VerificationLevel;
  /** 0–1 where meaningful; absent for deterministic facts. */
  readonly confidence?: number;
  readonly observedAt: Date;
}

// ---------------------------------------------------------------------------
// Website status
// ---------------------------------------------------------------------------

/**
 * What the discovery provider claims about a website.
 *
 * THIRD_PARTY_LISTING exists because it is the single most common data-quality
 * trap in this product: a large share of small businesses list a Zomato,
 * Practo, Justdial, Facebook, or Linktree URL in the website field. Treating
 * that as "has a website" discards an excellent web-development lead, and
 * treating it as "no website" loses real information. It is its own state.
 */
export type GoogleWebsiteStatus =
  | 'GOOGLE_WEBSITE_PRESENT'
  | 'GOOGLE_WEBSITE_NOT_LISTED'
  | 'GOOGLE_WEBSITE_IS_THIRD_PARTY_LISTING';

/**
 * What LeadRadar independently established. "Not listed on Google" is not the
 * same claim as "has no website", and the product must never conflate them.
 */
export type IndependentWebsiteStatus =
  | 'NOT_CHECKED'
  | 'INDEPENDENT_WEBSITE_FOUND'
  | 'NO_INDEPENDENT_WEBSITE_FOUND'
  | 'WEBSITE_UNVERIFIED'
  | 'WEBSITE_BROKEN'
  | 'WEBSITE_MISMATCH';

/** Verdict of matching a candidate website against a business identity. */
export type WebsiteMatchStatus =
  | 'MATCH'
  | 'PROBABLE_MATCH'
  | 'PROBABLE_MISMATCH'
  | 'MISMATCH'
  | 'UNKNOWN';

/** How a website candidate was discovered. */
export type WebsiteCandidateSource =
  | 'GOOGLE_PLACES_FIELD'
  | 'WEB_SEARCH_NAME_CITY'
  | 'WEB_SEARCH_NAME_PHONE'
  | 'WEB_SEARCH_NAME_ADDRESS'
  | 'SOCIAL_PROFILE_LINK'
  | 'MANUAL';

export type WebsiteCandidateStatus =
  | 'PENDING'
  | 'VERIFYING'
  | 'ACCEPTED'
  | 'REJECTED'
  | 'UNREACHABLE';

// ---------------------------------------------------------------------------
// Digital presence and opportunity
// ---------------------------------------------------------------------------

export type DigitalPresenceLevel = 'EXCELLENT' | 'GOOD' | 'MODERATE' | 'WEAK' | 'MINIMAL';

/** Grade bands for the opportunity score. */
export type LeadPriority = 'A_PLUS' | 'A' | 'B' | 'C' | 'D';

export type SocialPlatform =
  | 'INSTAGRAM'
  | 'FACEBOOK'
  | 'LINKEDIN'
  | 'YOUTUBE'
  | 'X'
  | 'WHATSAPP_BUSINESS';

export type SocialProfileStatus = 'DISCOVERED' | 'VERIFIED' | 'PROBABLE' | 'REJECTED';

/** Services an agency could sell to this business. */
export type ServiceOpportunity =
  | 'WEBSITE_DEVELOPMENT'
  | 'WEBSITE_REDESIGN'
  | 'SEO'
  | 'LOCAL_SEO'
  | 'SOCIAL_MEDIA_MARKETING'
  | 'CONTENT_MARKETING'
  | 'PAID_ADVERTISING'
  | 'BRANDING'
  | 'AI_AUTOMATION';

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * One contribution to a score, with the evidence that produced it. Every score
 * in LeadRadar is explainable down to this level; nothing is a bare number.
 */
export interface ScoreSignal {
  readonly key: string;
  readonly label: string;
  /** Points contributed, positive or negative. */
  readonly points: number;
  /** Which of the three factors this signal feeds. */
  readonly factor: 'need' | 'value' | 'reach';
  /** Human-readable justification shown in the UI. */
  readonly rationale: string;
  readonly provenance: DataProvenance;
}

export interface ScoreBreakdown {
  readonly total: number;
  readonly priority: LeadPriority;
  readonly signals: readonly ScoreSignal[];
  /**
   * Sub-factors, before combination. Opportunity is Need x Value x Reach:
   * a business can need a website badly (need=1) yet be a poor prospect
   * because nobody can reach it (reach low) or it has no revenue signal
   * (value low). A purely additive score hides that.
   */
  readonly factors: {
    readonly need: number;
    readonly value: number;
    readonly reach: number;
  };
  /** Bumps when weights change, so scores recompute without re-spending API budget. */
  readonly signalsVersion: string;
  /** Any cap that overrode the raw arithmetic, e.g. a review-count floor. */
  readonly appliedCaps: readonly string[];
}

// ---------------------------------------------------------------------------
// Business identity
// ---------------------------------------------------------------------------

export type BusinessStatus = 'OPERATIONAL' | 'CLOSED_TEMPORARILY' | 'CLOSED_PERMANENTLY' | 'UNKNOWN';

export interface GeoPoint {
  readonly latitude: number;
  readonly longitude: number;
}

/**
 * A normalised business as the pipeline sees it. Google-derived numbers
 * (rating, reviewCount) live here for processing but are persisted in the
 * TTL'd snapshot table, not on the durable business row — see
 * docs/google-maps-compliance.md.
 */
export interface NormalizedBusiness {
  /** Stable provider identity. Retained indefinitely. */
  readonly placeId: string;
  /** Lowercased, punctuation-stripped name used for dedupe and matching. */
  readonly normalizedName: string;
  readonly displayName: string;
  readonly primaryCategory: string | null;
  readonly categories: readonly string[];
  readonly formattedAddress: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly country: string | null;
  readonly postalCode: string | null;
  readonly location: GeoPoint | null;
  /** E.164 where parseable, else the provider string. */
  readonly phone: string | null;
  readonly rating: number | null;
  readonly reviewCount: number | null;
  readonly businessStatus: BusinessStatus;
  readonly googleMapsUri: string | null;
  readonly websiteUri: string | null;
  readonly googleWebsiteStatus: GoogleWebsiteStatus;
  /** When this snapshot was taken; drives TTL and refresh. */
  readonly observedAt: Date;
}

// ---------------------------------------------------------------------------
// Structured search
// ---------------------------------------------------------------------------

/**
 * The only shape the pipeline will execute. The AI query parser produces a
 * candidate of this shape and it is Zod-validated before anything runs; the
 * model cannot introduce a field, an operator, or a filter that isn't here.
 */
export interface StructuredQuery {
  readonly categories: readonly string[];
  readonly locations: readonly string[];
  readonly minimumRating: number | null;
  readonly maximumRating: number | null;
  readonly minimumReviews: number | null;
  readonly maximumReviews: number | null;
  readonly websiteStatus: GoogleWebsiteStatus | 'ANY';
  readonly requireSocialPresence: boolean | null;
  readonly excludeChains: boolean;
  readonly maxResults: number | null;
}

export type JobStatus =
  | 'PENDING'
  | 'ESTIMATING'
  | 'AWAITING_CONFIRMATION'
  | 'RUNNING'
  | 'PAUSED_BUDGET'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

/** Confidence routing thresholds; see docs/ai-architecture.md. */
export const CONFIDENCE_THRESHOLDS = {
  /** At or above: accept without further checks. */
  autoAccept: 0.9,
  /** At or above (and below autoAccept): run a secondary deterministic check. */
  secondaryCheck: 0.7,
} as const;

export function confidenceBand(confidence: number): 'accept' | 'secondary' | 'manual' {
  if (confidence >= CONFIDENCE_THRESHOLDS.autoAccept) return 'accept';
  if (confidence >= CONFIDENCE_THRESHOLDS.secondaryCheck) return 'secondary';
  return 'manual';
}
