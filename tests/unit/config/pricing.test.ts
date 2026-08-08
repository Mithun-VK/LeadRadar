import { describe, expect, it } from 'vitest';

import {
  FIRECRAWL_OPERATIONS,
  GOOGLE_FIELD_TIERS,
  GOOGLE_SKUS,
  GOOGLE_TIER_ORDER,
  firecrawlCreditMicros,
  formatMicros,
  groqCallMicros,
  groqPricingFor,
  microsToUsd,
  usdToMicros,
} from '@/config/pricing';

describe('micros arithmetic', () => {
  it('round-trips USD through micros', () => {
    expect(usdToMicros(35)).toBe(35_000_000);
    expect(microsToUsd(35_000_000)).toBe(35);
  });

  // Per-call costs are fractions of a cent; accumulating them as floats over a
  // 100,000-business job drifts visibly, which is why micros are integers.
  it('keeps sub-cent amounts exact when accumulated', () => {
    const perCall = usdToMicros(0.000285);
    const total = perCall * 100_000;
    expect(Number.isInteger(total)).toBe(true);
    expect(microsToUsd(total)).toBeCloseTo(28.5, 6);
  });

  it('formats small amounts with enough precision to be meaningful', () => {
    expect(formatMicros(285)).toBe('$0.000285');
    expect(formatMicros(35_000_000)).toBe('$35.00');
    expect(formatMicros(0)).toBe('$0.00');
  });
});

describe('Google Places SKUs', () => {
  it('prices Text Search Enterprise at $35 per 1,000 with 1,000 free', () => {
    const sku = GOOGLE_SKUS['text-search:enterprise'];
    expect(sku.per1000Micros).toBe(usdToMicros(35));
    expect(sku.freeMonthlyEvents).toBe(1_000);
    expect(sku.billedPerRequest).toBe(true);
  });

  it('treats IDs-only Text Search as free and unmetered', () => {
    const sku = GOOGLE_SKUS['text-search:essentials-ids-only'];
    expect(sku.per1000Micros).toBe(0);
    expect(sku.freeMonthlyEvents).toBe(Number.POSITIVE_INFINITY);
  });

  /**
   * The central cost insight of the product, asserted so a future refactor
   * cannot quietly reintroduce the Place Details pattern: Text Search is billed
   * per REQUEST and returns up to 20 places, so acquiring the same Enterprise
   * fields via Place Details (billed per PLACE) costs roughly 11x more.
   */
  it('confirms Text Search beats Place Details per business by an order of magnitude', () => {
    const textSearch = GOOGLE_SKUS['text-search:enterprise'];
    const details = GOOGLE_SKUS['place-details:enterprise'];

    // Micros per business: $35 / 1000 requests / 20 places per request.
    const perBusinessViaTextSearch = textSearch.per1000Micros / 1000 / 20;
    // Micros per business: $20 / 1000 places, billed per place.
    const perBusinessViaDetails = details.per1000Micros / 1000;

    expect(perBusinessViaTextSearch).toBe(1_750); // $0.00175
    expect(perBusinessViaDetails).toBe(20_000); // $0.02
    expect(perBusinessViaDetails / perBusinessViaTextSearch).toBeGreaterThan(10);
  });

  it('assigns every SKU a distinct Google SKU id', () => {
    const ids = Object.values(GOOGLE_SKUS).map((sku) => sku.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('Google field-to-tier mapping', () => {
  it('places the fields LeadRadar needs in the Enterprise tier', () => {
    // Requesting any one of these promotes the whole request to Enterprise, so
    // LeadRadar is inherently an Enterprise-tier product.
    for (const field of ['rating', 'userRatingCount', 'websiteUri', 'nationalPhoneNumber']) {
      expect(GOOGLE_FIELD_TIERS.enterprise).toContain(field);
    }
  });

  it('keeps reviews and editorialSummary out of the Enterprise tier', () => {
    // These would escalate to Enterprise + Atmosphere for no product value.
    expect(GOOGLE_FIELD_TIERS['enterprise-atmosphere']).toContain('reviews');
    expect(GOOGLE_FIELD_TIERS['enterprise-atmosphere']).toContain('editorialSummary');
    expect(GOOGLE_FIELD_TIERS.enterprise).not.toContain('reviews');
  });

  it('assigns each field to exactly one tier', () => {
    const seen = new Map<string, string>();
    for (const [tier, fields] of Object.entries(GOOGLE_FIELD_TIERS)) {
      for (const field of fields) {
        expect(seen.has(field), `${field} appears in ${seen.get(field)} and ${tier}`).toBe(false);
        seen.set(field, tier);
      }
    }
  });

  it('orders tiers by ascending cost and covers every tier', () => {
    expect(GOOGLE_TIER_ORDER).toEqual([
      'essentials-ids-only',
      'essentials',
      'pro',
      'enterprise',
      'enterprise-atmosphere',
    ]);
    expect(new Set(GOOGLE_TIER_ORDER)).toEqual(new Set(Object.keys(GOOGLE_FIELD_TIERS)));
  });
});

describe('Firecrawl credits', () => {
  it('charges 2 credits per search and 1 per scraped page', () => {
    expect(FIRECRAWL_OPERATIONS.search.creditsPerUnit).toBe(2);
    expect(FIRECRAWL_OPERATIONS.scrape.creditsPerUnit).toBe(1);
  });

  it('derives credit cost from the plan, and the spread is large', () => {
    const standard = firecrawlCreditMicros('standard');
    const payg = firecrawlCreditMicros('payg');
    expect(microsToUsd(standard)).toBeCloseTo(0.00083, 5);
    expect(microsToUsd(payg)).toBeCloseTo(0.005, 5);
    // Pay-as-you-go credits cost ~6x plan credits, which is large enough to
    // change design decisions — hence plan-aware costing rather than a constant.
    expect(payg / standard).toBeGreaterThan(5);
  });

  it('treats the free plan as zero-cost credits', () => {
    expect(firecrawlCreditMicros('free')).toBe(0);
  });
});

describe('Groq pricing', () => {
  it('prices the default model per published rates', () => {
    const pricing = groqPricingFor('openai/gpt-oss-20b');
    expect(microsToUsd(pricing.inputPerMillionMicros)).toBeCloseTo(0.075, 6);
    expect(microsToUsd(pricing.outputPerMillionMicros)).toBeCloseTo(0.3, 6);
  });

  it('falls back conservatively for an unknown configured model', () => {
    // GROQ_MODEL is configuration; an unknown value must not crash cost
    // tracking, and must not under-report spend either.
    const unknown = groqPricingFor('some/model-we-have-never-seen');
    expect(unknown.inputPerMillionMicros).toBe(groqPricingFor('llama-3.3-70b-versatile').inputPerMillionMicros);
  });

  it('costs a typical classification call at well under a cent', () => {
    const micros = groqCallMicros('openai/gpt-oss-20b', 3_000, 200);
    expect(microsToUsd(micros)).toBeCloseTo(0.000285, 6);
  });

  /**
   * The corrected cost hierarchy: a Groq classification is CHEAPER than one
   * Firecrawl page scrape. This inverts the common assumption that AI is the
   * expensive layer, and it is why the pipeline may spend a Groq call to avoid
   * a fetch.
   */
  it('is cheaper per call than a single Firecrawl page scrape', () => {
    const groq = groqCallMicros('openai/gpt-oss-20b', 3_000, 200);
    const scrape = firecrawlCreditMicros('standard') * FIRECRAWL_OPERATIONS.scrape.creditsPerUnit;
    expect(groq).toBeLessThan(scrape);
  });

  it('is far cheaper than one business discovered via Google', () => {
    const groq = groqCallMicros('openai/gpt-oss-20b', 3_000, 200);
    const perBusiness = GOOGLE_SKUS['text-search:enterprise'].per1000Micros / 1000 / 13;
    expect(groq).toBeLessThan(perBusiness);
  });
});
