/**
 * ProviderPricingConfig — the single source of truth for what an external call
 * costs. Prices appear here and nowhere else, so a provider price change is a
 * one-file edit rather than a codebase audit.
 *
 * All money is USD. Amounts are held as `micros` (millionths of a dollar)
 * because per-call costs are far below a cent and floating-point accumulation
 * over a 100,000-business job drifts visibly.
 *
 * ---------------------------------------------------------------------------
 * PRICES VERIFIED 2026-08-08 against provider documentation. Re-verify before
 * relying on cost reports; providers change pricing without notice, and the
 * March 2025 Google restructure invalidated every pre-2025 estimate.
 * ---------------------------------------------------------------------------
 *
 * Two facts drive the entire pipeline design and are worth stating here, next
 * to the numbers that justify them:
 *
 * 1. Text Search is billed PER REQUEST and returns up to 20 places, so one
 *    Enterprise Text Search costs ~$0.00175 per business. Place Details is
 *    billed PER PLACE at $0.020. Acquiring rating/reviews/website/phone via
 *    Place Details is therefore ~11x more expensive than via Text Search, and
 *    the "free IDs-only search, then details" pattern is a cost trap. The free
 *    IDs-only SKU is for Place ID refresh and existence checks only.
 *
 * 2. A Groq classification (~$0.000285) is CHEAPER than one Firecrawl page
 *    scrape ($0.00083) and ~6x cheaper than one web search ($0.00166). AI is
 *    not the expensive layer; per-record Google SKUs and page fetches are. Use
 *    deterministic logic for correctness and explainability — not to save money
 *    that isn't there.
 */

export type Provider = 'google-places' | 'firecrawl' | 'groq';

/** Millionths of one US dollar. */
export type Micros = number;

export const MICROS_PER_USD = 1_000_000;

export function usdToMicros(usd: number): Micros {
  return Math.round(usd * MICROS_PER_USD);
}

export function microsToUsd(micros: Micros): number {
  return micros / MICROS_PER_USD;
}

/** Formats micros for display, with enough precision to be meaningful. */
export function formatMicros(micros: Micros, currency = 'USD'): string {
  const usd = microsToUsd(micros);
  const fractionDigits = usd !== 0 && Math.abs(usd) < 0.01 ? 6 : 2;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(usd);
}

// ---------------------------------------------------------------------------
// Google Places API (New)
// ---------------------------------------------------------------------------

/**
 * Field-mask tiers. Requesting a single field from a higher tier promotes the
 * whole request to that tier's SKU, so the field mask is a pricing decision.
 */
export type GooglePlacesTier = 'essentials-ids-only' | 'essentials' | 'pro' | 'enterprise' | 'enterprise-atmosphere';

export type GooglePlacesOperation = 'text-search' | 'nearby-search' | 'place-details';

export interface GoogleSku {
  readonly id: string;
  readonly label: string;
  readonly operation: GooglePlacesOperation;
  readonly tier: GooglePlacesTier;
  /** Cost per 1,000 billable events, in micros. */
  readonly per1000Micros: Micros;
  /** Free billable events per month, per SKU (post-March-2025 model). */
  readonly freeMonthlyEvents: number;
  /** True when one request can return many places (affects per-business cost). */
  readonly billedPerRequest: boolean;
}

export const GOOGLE_SKUS = {
  'text-search:essentials-ids-only': {
    id: '635D-A9DD-C520',
    label: 'Places API Text Search Essentials (IDs Only)',
    operation: 'text-search',
    tier: 'essentials-ids-only',
    per1000Micros: 0,
    freeMonthlyEvents: Number.POSITIVE_INFINITY,
    billedPerRequest: true,
  },
  'text-search:pro': {
    id: '4FDA-34B1-A910',
    label: 'Places API Text Search Pro',
    operation: 'text-search',
    tier: 'pro',
    per1000Micros: usdToMicros(32),
    freeMonthlyEvents: 5_000,
    billedPerRequest: true,
  },
  'text-search:enterprise': {
    id: 'E967-44BC-B44D',
    label: 'Places API Text Search Enterprise',
    operation: 'text-search',
    tier: 'enterprise',
    per1000Micros: usdToMicros(35),
    freeMonthlyEvents: 1_000,
    billedPerRequest: true,
  },
  'nearby-search:pro': {
    id: '99F9-A108-83A6',
    label: 'Places API Nearby Search Pro',
    operation: 'nearby-search',
    tier: 'pro',
    per1000Micros: usdToMicros(32),
    freeMonthlyEvents: 5_000,
    billedPerRequest: true,
  },
  'nearby-search:enterprise': {
    id: '772E-9975-BE34',
    label: 'Places API Nearby Search Enterprise',
    operation: 'nearby-search',
    tier: 'enterprise',
    per1000Micros: usdToMicros(35),
    freeMonthlyEvents: 1_000,
    billedPerRequest: true,
  },
  'place-details:essentials': {
    id: '6E05-E1C3-8D85',
    label: 'Places API Place Details Essentials',
    operation: 'place-details',
    tier: 'essentials',
    per1000Micros: usdToMicros(5),
    freeMonthlyEvents: 10_000,
    billedPerRequest: false,
  },
  'place-details:pro': {
    id: '4ED6-464A-2AFC',
    label: 'Places API Place Details Pro',
    operation: 'place-details',
    tier: 'pro',
    per1000Micros: usdToMicros(17),
    freeMonthlyEvents: 5_000,
    billedPerRequest: false,
  },
  'place-details:enterprise': {
    id: '2D9A-3DE0-3766',
    label: 'Places API Place Details Enterprise',
    operation: 'place-details',
    tier: 'enterprise',
    per1000Micros: usdToMicros(20),
    freeMonthlyEvents: 1_000,
    billedPerRequest: false,
  },
} as const satisfies Record<string, GoogleSku>;

export type GoogleSkuKey = keyof typeof GOOGLE_SKUS;

/**
 * Which SKU tier a set of requested fields lands in. Field names are the
 * Places API (New) response field names, without the `places.` prefix.
 *
 * Verified against the Places API data-fields documentation, 2026-08-08.
 */
export const GOOGLE_FIELD_TIERS: Record<GooglePlacesTier, readonly string[]> = {
  'essentials-ids-only': ['id', 'name', 'attributions', 'nextPageToken'],
  essentials: ['formattedAddress', 'shortFormattedAddress', 'addressComponents', 'location', 'viewport', 'types', 'plusCode', 'postalAddress'],
  pro: [
    'displayName',
    'businessStatus',
    'googleMapsUri',
    'primaryType',
    'primaryTypeDisplayName',
    'utcOffsetMinutes',
    'timeZone',
    'iconMaskBaseUri',
    'iconBackgroundColor',
    'photos',
    'subDestinations',
    'containingPlaces',
    'pureServiceAreaBusiness',
  ],
  enterprise: [
    'rating',
    'userRatingCount',
    'websiteUri',
    'nationalPhoneNumber',
    'internationalPhoneNumber',
    'priceLevel',
    'priceRange',
    'regularOpeningHours',
    'currentOpeningHours',
  ],
  'enterprise-atmosphere': [
    'reviews',
    'editorialSummary',
    'regularSecondaryOpeningHours',
    'currentSecondaryOpeningHours',
    'allowsDogs',
    'delivery',
    'dineIn',
    'goodForChildren',
    'liveMusic',
    'outdoorSeating',
    'parkingOptions',
    'paymentOptions',
    'reservable',
    'restroom',
    'takeout',
    'servesBeer',
    'servesBreakfast',
    'servesBrunch',
    'servesCocktails',
    'servesCoffee',
    'servesDessert',
    'servesDinner',
    'servesLunch',
    'servesVegetarianFood',
    'servesWine',
  ],
};

/** Ascending cost order; the highest tier touched by a field mask wins. */
export const GOOGLE_TIER_ORDER: readonly GooglePlacesTier[] = [
  'essentials-ids-only',
  'essentials',
  'pro',
  'enterprise',
  'enterprise-atmosphere',
];

// ---------------------------------------------------------------------------
// Firecrawl — credit-based
// ---------------------------------------------------------------------------

export type FirecrawlOperation = 'search' | 'scrape' | 'crawl' | 'map' | 'extract';

export interface FirecrawlPricing {
  /** Credits consumed per unit of the operation. */
  readonly creditsPerUnit: number;
  /** What one unit means, for the cost estimator's explanation text. */
  readonly unit: string;
}

export const FIRECRAWL_OPERATIONS: Record<FirecrawlOperation, FirecrawlPricing> = {
  // 2 credits per 10 results; we bill a whole search as one unit of 10.
  search: { creditsPerUnit: 2, unit: 'search (up to 10 results)' },
  scrape: { creditsPerUnit: 1, unit: 'page' },
  crawl: { creditsPerUnit: 1, unit: 'page' },
  map: { creditsPerUnit: 1, unit: 'page' },
  extract: { creditsPerUnit: 1, unit: 'page' },
};

/**
 * Effective cost of one credit depends on the plan, and the spread is wide
 * enough to change design decisions: pay-as-you-go credits cost 6x plan
 * credits. Configure this to match the actual subscription.
 */
export interface FirecrawlPlanSpec {
  readonly label: string;
  readonly monthlyUsd: number;
  readonly includedCredits: number;
}

/**
 * Not `as const`: widening to `number` keeps the zero-guard in
 * {@link firecrawlCreditMicros} meaningful. With literal types the compiler
 * proves `includedCredits === 0` unreachable today, and a future plan with no
 * included credits would then divide by zero silently.
 */
export type FirecrawlPlan = 'free' | 'payg' | 'hobby' | 'standard' | 'growth' | 'scale';

export const FIRECRAWL_PLANS: Record<FirecrawlPlan, FirecrawlPlanSpec> = {
  free: { label: 'Free', monthlyUsd: 0, includedCredits: 1_000 },
  payg: { label: 'Pay as you go', monthlyUsd: 5, includedCredits: 1_000 },
  hobby: { label: 'Hobby', monthlyUsd: 16, includedCredits: 5_000 },
  standard: { label: 'Standard', monthlyUsd: 83, includedCredits: 100_000 },
  growth: { label: 'Growth', monthlyUsd: 333, includedCredits: 500_000 },
  scale: { label: 'Scale', monthlyUsd: 599, includedCredits: 1_000_000 },
};

export function firecrawlCreditMicros(plan: FirecrawlPlan): Micros {
  const { monthlyUsd, includedCredits } = FIRECRAWL_PLANS[plan];
  if (includedCredits === 0) return 0;
  return usdToMicros(monthlyUsd) / includedCredits;
}

// ---------------------------------------------------------------------------
// Groq — token-based
// ---------------------------------------------------------------------------

export interface GroqModelPricing {
  readonly inputPerMillionMicros: Micros;
  readonly outputPerMillionMicros: Micros;
}

/**
 * Keyed by Groq model id. GROQ_MODEL is configuration, so an unknown model must
 * not crash cost tracking — see {@link groqPricingFor}.
 */
export const GROQ_MODELS: Record<string, GroqModelPricing> = {
  'openai/gpt-oss-20b': {
    inputPerMillionMicros: usdToMicros(0.075),
    outputPerMillionMicros: usdToMicros(0.3),
  },
  'openai/gpt-oss-120b': {
    inputPerMillionMicros: usdToMicros(0.15),
    outputPerMillionMicros: usdToMicros(0.6),
  },
  'llama-3.1-8b-instant': {
    inputPerMillionMicros: usdToMicros(0.05),
    outputPerMillionMicros: usdToMicros(0.08),
  },
  'llama-3.3-70b-versatile': {
    inputPerMillionMicros: usdToMicros(0.59),
    outputPerMillionMicros: usdToMicros(0.79),
  },
};

/** Conservative stand-in for an unpriced model: the most expensive we know. */
export const GROQ_FALLBACK_PRICING: GroqModelPricing = {
  inputPerMillionMicros: usdToMicros(0.59),
  outputPerMillionMicros: usdToMicros(0.79),
};

export function groqPricingFor(model: string): GroqModelPricing {
  return GROQ_MODELS[model] ?? GROQ_FALLBACK_PRICING;
}

export function groqCallMicros(
  model: string,
  inputTokens: number,
  outputTokens: number,
): Micros {
  const pricing = groqPricingFor(model);
  return Math.round(
    (inputTokens * pricing.inputPerMillionMicros + outputTokens * pricing.outputPerMillionMicros) /
      1_000_000,
  );
}

// ---------------------------------------------------------------------------
// Assumptions used by the pre-flight cost estimator.
// Configurable because they must be re-tuned against observed funnel data —
// they are starting estimates, not measurements.
// ---------------------------------------------------------------------------

export interface FunnelAssumptions {
  /** Unique businesses yielded per billed Text Search request, after page-fill and cross-cell overlap. */
  readonly businessesPerSearchRequest: number;
  /** Share of discovered businesses passing deterministic filters. */
  readonly filterPassRate: number;
  /** Share of filtered businesses needing a web search (no Google-listed site). */
  readonly webSearchRate: number;
  /** Homepage scrapes per filtered business. */
  readonly homepageScrapeRate: number;
  /** Share of scrapes needing a second page (contact/about). */
  readonly secondPageRate: number;
  /** Share of filtered businesses whose website match is ambiguous enough for AI. */
  readonly aiAdjudicationRate: number;
  /** Share of filtered businesses receiving a qualitative narrative. */
  readonly aiNarrativeRate: number;
  /** Share of discovered businesses that become A/B-grade qualified leads. */
  readonly qualifiedLeadRate: number;
  /** Typical token counts per AI task, for estimation only. */
  readonly tokensPerClassification: { input: number; output: number };
  readonly tokensPerNarrative: { input: number; output: number };
}

export const DEFAULT_FUNNEL: FunnelAssumptions = {
  businessesPerSearchRequest: 13,
  filterPassRate: 0.45,
  webSearchRate: 0.35,
  homepageScrapeRate: 0.76,
  secondPageRate: 0.3,
  aiAdjudicationRate: 0.2,
  aiNarrativeRate: 0.1,
  qualifiedLeadRate: 0.25,
  tokensPerClassification: { input: 3_000, output: 200 },
  tokensPerNarrative: { input: 1_500, output: 400 },
};

export interface PricingConfig {
  readonly googleTextSearchSku: GoogleSkuKey;
  readonly firecrawlPlan: FirecrawlPlan;
  readonly groqModel: string;
  readonly funnel: FunnelAssumptions;
  /** Display currency. Cost maths always happens in USD micros. */
  readonly displayCurrency: string;
}

export const DEFAULT_PRICING: PricingConfig = {
  googleTextSearchSku: 'text-search:enterprise',
  firecrawlPlan: 'free',
  groqModel: 'openai/gpt-oss-20b',
  funnel: DEFAULT_FUNNEL,
  displayCurrency: 'USD',
};
