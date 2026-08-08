/**
 * Provider contracts.
 *
 * The pipeline depends only on these interfaces. Google Places, Firecrawl, and
 * Groq are implementation details behind them, each with a live adapter and a
 * mock adapter. Two consequences that matter:
 *
 *   - A provider can be replaced (Places -> Overture/OSM, Firecrawl -> another
 *     crawler, Groq -> another OpenAI-compatible endpoint) without touching
 *     scoring, filtering, or UI code.
 *   - The whole product runs with no credentials, because mock adapters satisfy
 *     the same contracts.
 *
 * Every method returns a Result rather than throwing: provider failure is an
 * expected operating condition, not an exception.
 *
 * Every method also reports usage, so cost tracking cannot be forgotten at a
 * call site — it is part of the return type.
 */
import type { Result } from '@/lib/result';
import type {
  NormalizedBusiness,
  SocialPlatform,
  StructuredQuery,
  WebsiteMatchStatus,
} from '@/types/domain';

// ---------------------------------------------------------------------------
// Usage accounting, common to all providers
// ---------------------------------------------------------------------------

/**
 * What one provider call consumed. Returned alongside every result so the
 * caller can persist an ApiUsage row; there is no way to make a billable call
 * through these interfaces without receiving the cost of it.
 */
export interface UsageRecord {
  readonly provider: 'google-places' | 'firecrawl' | 'groq';
  readonly operation: string;
  /** Billable events (Google), credits (Firecrawl), or calls (Groq). */
  readonly units: number;
  /** Unit label for reporting, e.g. 'text-search:enterprise', 'credits'. */
  readonly unitKind: string;
  readonly estimatedCostMicros: number;
  readonly durationMs: number;
  /** Present for Groq. */
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  /** Present when the provider was bypassed. */
  readonly cacheHit?: boolean;
  readonly mocked: boolean;
}

/** A provider result paired with its usage. */
export interface WithUsage<T> {
  readonly data: T;
  readonly usage: readonly UsageRecord[];
}

// ---------------------------------------------------------------------------
// Business discovery
// ---------------------------------------------------------------------------

/** A rectangular area to restrict a search to. */
export interface BoundingBox {
  readonly south: number;
  readonly west: number;
  readonly north: number;
  readonly east: number;
}

export interface DiscoveryRequest {
  /** Free-text query, e.g. 'dental clinic'. */
  readonly textQuery: string;
  /** Provider-neutral category hint; adapters map to their own taxonomy. */
  readonly includedType?: string;
  readonly strictTypeFiltering?: boolean;
  /** Restrict (hard boundary) — preferred, because it makes cells disjoint. */
  readonly locationRestriction?: BoundingBox;
  /** Bias (soft) — used only where restriction is unsupported for the query. */
  readonly locationBias?: BoundingBox;
  readonly minRating?: number;
  /** Provider maximum is enforced by the adapter. */
  readonly pageSize?: number;
  readonly pageToken?: string;
  readonly regionCode?: string;
  readonly languageCode?: string;
}

export interface DiscoveryPage {
  readonly businesses: readonly NormalizedBusiness[];
  readonly nextPageToken: string | null;
  /**
   * True when the provider returned its hard result ceiling, meaning the area
   * is saturated and there are almost certainly more businesses inside it than
   * we can see. The geographic planner splits saturated cells and only
   * saturated cells — splitting unsaturated ones produces thin pages, and
   * because search is billed per request, that raises cost per business.
   */
  readonly saturated: boolean;
  /** Attribution text the provider requires us to display, if any. */
  readonly attributions: readonly string[];
}

export interface BusinessDiscoveryProvider {
  readonly name: string;
  readonly isMock: boolean;
  /**
   * One page of results. Callers paginate explicitly rather than the adapter
   * looping internally, because each page is a separate billable request and
   * the decision to fetch another one is a spending decision.
   */
  search(request: DiscoveryRequest): Promise<Result<WithUsage<DiscoveryPage>>>;
  /**
   * Refreshes place identities cheaply, confirming existence without paying for
   * data fields. Used to age out stale identifiers.
   */
  refreshPlaceIds(placeIds: readonly string[]): Promise<Result<WithUsage<Record<string, boolean>>>>;
}

// ---------------------------------------------------------------------------
// Web discovery
// ---------------------------------------------------------------------------

export interface WebSearchRequest {
  readonly query: string;
  readonly limit?: number;
  /** ISO country code to localise results. */
  readonly country?: string;
}

export interface WebSearchResult {
  readonly url: string;
  readonly title: string | null;
  readonly description: string | null;
  readonly position: number;
}

export interface PageFetchRequest {
  readonly url: string;
  /** Ask the provider for markdown plus links; never a whole-site crawl. */
  readonly includeLinks?: boolean;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

export interface FetchedPage {
  readonly url: string;
  /** Final URL after redirects, so callers can detect a parked-domain bounce. */
  readonly finalUrl: string;
  readonly statusCode: number | null;
  readonly title: string | null;
  readonly description: string | null;
  /** Cleaned text/markdown. Treated as UNTRUSTED throughout the codebase. */
  readonly content: string;
  readonly links: readonly string[];
  readonly httpsEnabled: boolean;
  readonly byteLength: number;
  readonly fetchedAt: Date;
}

export interface WebDiscoveryProvider {
  readonly name: string;
  readonly isMock: boolean;
  search(request: WebSearchRequest): Promise<Result<WithUsage<readonly WebSearchResult[]>>>;
  /** Single page. There is deliberately no whole-site crawl method here. */
  fetchPage(request: PageFetchRequest): Promise<Result<WithUsage<FetchedPage>>>;
}

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

/**
 * The complete set of AI tasks. Adding a task means adding a schema and a
 * prompt — the model is never handed an open-ended instruction, and there is no
 * generic "ask the model anything" method.
 */
export type AiTask =
  | 'QUERY_PARSE'
  | 'CATEGORY_NORMALIZE'
  | 'WEBSITE_MATCH'
  | 'DIGITAL_PRESENCE_CLASSIFY'
  | 'SERVICE_RECOMMEND'
  | 'LEAD_NARRATIVE';

/**
 * An AI verdict. Note what is absent: the model returns a constrained verdict
 * and a confidence, never a fact, a URL, a phone number, or a score. Facts are
 * extracted deterministically and the model only judges them, which is what
 * bounds the damage from a prompt-injected page to "one wrong verdict on one
 * lead".
 */
export interface AiVerdict<T> {
  readonly task: AiTask;
  readonly model: string;
  readonly result: T;
  readonly confidence: number;
  /** Quoted spans from the input that justify the verdict. Never free-form claims. */
  readonly evidence: readonly string[];
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface WebsiteMatchInput {
  /** Facts about the business, from our own records. */
  readonly business: {
    readonly name: string;
    readonly city: string | null;
    readonly category: string | null;
    readonly phoneDigits: string | null;
    readonly addressTokens: readonly string[];
  };
  /** Facts extracted deterministically from the candidate page. */
  readonly candidate: {
    readonly domain: string;
    readonly title: string | null;
    readonly description: string | null;
    readonly phoneDigitsFound: readonly string[];
    readonly cityMentions: readonly string[];
    /** Untrusted page text, already truncated and stripped. */
    readonly contentExcerpt: string;
  };
  /** What deterministic matching already concluded, and why it was inconclusive. */
  readonly deterministicScore: number;
  readonly unresolvedReason: string;
}

export interface WebsiteMatchVerdict {
  readonly status: WebsiteMatchStatus;
  readonly matchedName: boolean;
  readonly matchedPhone: boolean;
  readonly matchedCity: boolean;
  readonly matchedCategory: boolean;
}

export interface DigitalPresenceInput {
  readonly hasVerifiedWebsite: boolean;
  readonly httpsEnabled: boolean | null;
  readonly pageCount: number | null;
  readonly hasContactPage: boolean;
  readonly hasBookingIndicator: boolean;
  readonly socialPlatforms: readonly SocialPlatform[];
  readonly reviewCount: number | null;
  readonly rating: number | null;
  readonly contentExcerpt: string;
}

export interface AiProvider {
  readonly name: string;
  readonly model: string;
  readonly isMock: boolean;

  /** Natural language to a validated StructuredQuery. */
  parseQuery(text: string): Promise<Result<WithUsage<AiVerdict<StructuredQuery>>>>;

  /** Maps a free-text category to the provider-neutral taxonomy. */
  normalizeCategory(
    text: string,
    allowed: readonly string[],
  ): Promise<Result<WithUsage<AiVerdict<{ category: string }>>>>;

  /** Adjudicates a website match that deterministic rules could not settle. */
  matchWebsite(
    input: WebsiteMatchInput,
  ): Promise<Result<WithUsage<AiVerdict<WebsiteMatchVerdict>>>>;

  /** Classifies digital maturity when rules are inconclusive. */
  classifyDigitalPresence(
    input: DigitalPresenceInput,
  ): Promise<Result<WithUsage<AiVerdict<{ level: string; reasons: readonly string[] }>>>>;

  /** Optional qualitative summary for high-value leads only. */
  summariseOpportunity(input: {
    readonly businessName: string;
    readonly signals: readonly string[];
  }): Promise<Result<WithUsage<AiVerdict<{ summary: string }>>>>;
}

// ---------------------------------------------------------------------------
// Website verification (internal, not a third party)
// ---------------------------------------------------------------------------

export interface VerificationEvidence {
  readonly field: 'name' | 'phone' | 'address' | 'city' | 'category' | 'domain';
  readonly matched: boolean;
  readonly points: number;
  /** Exact span or normalised value that produced the decision. */
  readonly detail: string;
}

export interface VerificationOutcome {
  readonly status: WebsiteMatchStatus;
  readonly confidence: number;
  readonly deterministicScore: number;
  readonly evidence: readonly VerificationEvidence[];
  /** True when the verdict required an AI call. */
  readonly usedAi: boolean;
}

export interface WebsiteVerificationProvider {
  readonly name: string;
  verify(input: {
    readonly business: NormalizedBusiness;
    readonly page: FetchedPage;
  }): Promise<Result<WithUsage<VerificationOutcome>>>;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** The set of providers a request or job operates with; injected, never imported. */
export interface ProviderRegistry {
  readonly discovery: BusinessDiscoveryProvider;
  readonly web: WebDiscoveryProvider;
  readonly ai: AiProvider;
  readonly mode: 'live' | 'mock';
}

/** Re-exported for adapters that only need the query shape. */
export type { StructuredQuery };
