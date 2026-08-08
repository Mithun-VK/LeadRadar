/**
 * Mock provider adapters.
 *
 * These satisfy the same contracts as the live adapters, so the entire product
 * runs with `MOCK_EXTERNAL_APIS=true` and no credentials. That is a hard
 * requirement, not a testing convenience: it is how the app is developed,
 * demonstrated, and end-to-end tested without spending API budget.
 *
 * They are deterministic and they report realistic usage figures, so the cost
 * dashboard shows plausible numbers in mock mode and the cost-tracking path is
 * exercised rather than bypassed.
 */
import {
  DEFAULT_PRICING,
  FIRECRAWL_OPERATIONS,
  GOOGLE_SKUS,
  firecrawlCreditMicros,
  groqCallMicros,
} from '@/config/pricing';
import { AppError } from '@/lib/errors';
import { normalizeDomain } from '@/lib/ids';
import { err, ok, type Result } from '@/lib/result';
import type {
  AiProvider,
  AiVerdict,
  BusinessDiscoveryProvider,
  DigitalPresenceInput,
  DiscoveryPage,
  DiscoveryRequest,
  FetchedPage,
  PageFetchRequest,
  UsageRecord,
  WebDiscoveryProvider,
  WebSearchRequest,
  WebSearchResult,
  WebsiteMatchInput,
  WebsiteMatchVerdict,
  WithUsage,
} from '@/modules/providers/contracts';
import { structuredQuerySchema } from '@/schemas/query';
import type { StructuredQuery } from '@/types/domain';

import { MOCK_BUSINESSES, MOCK_CITIES, findMockBusinesses } from './fixtures';

/** Provider ceiling: Text Search returns at most 20 per page, 60 in total. */
const PAGE_SIZE = 20;
const MAX_TOTAL = 60;

function usage(partial: Omit<UsageRecord, 'mocked'>): UsageRecord {
  return { ...partial, mocked: true };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export class MockDiscoveryProvider implements BusinessDiscoveryProvider {
  readonly name = 'mock-google-places';
  readonly isMock = true;

  async search(request: DiscoveryRequest): Promise<Result<WithUsage<DiscoveryPage>>> {
    const sku = GOOGLE_SKUS[DEFAULT_PRICING.googleTextSearchSku];

    // The city is inferred from the restriction box so the mock exercises the
    // same cell-based code path as the live provider.
    const city = request.locationRestriction
      ? MOCK_CITIES.find((candidate) => {
          const b = request.locationRestriction!;
          const cx = (candidate.bounds.west + candidate.bounds.east) / 2;
          const cy = (candidate.bounds.south + candidate.bounds.north) / 2;
          return cx >= b.west && cx <= b.east && cy >= b.south && cy <= b.north;
        })?.name
      : undefined;

    const matches = findMockBusinesses({
      category: request.textQuery,
      city,
      minRating: request.minRating,
    });

    const offset = request.pageToken ? Number.parseInt(request.pageToken, 10) : 0;
    if (Number.isNaN(offset) || offset < 0) {
      return err(
        new AppError({
          code: 'PROVIDER_BAD_REQUEST',
          message: `Mock provider received an invalid page token: ${request.pageToken}`,
        }),
      );
    }

    const pageSize = Math.min(request.pageSize ?? PAGE_SIZE, PAGE_SIZE);
    const page = matches.slice(offset, offset + pageSize);
    const consumed = offset + page.length;
    const hasMore = consumed < Math.min(matches.length, MAX_TOTAL);

    return ok({
      data: {
        businesses: page,
        nextPageToken: hasMore ? String(consumed) : null,
        // Saturation drives cell subdivision, so the mock must be able to report it.
        saturated: consumed >= MAX_TOTAL,
        attributions: ['Powered by Google (mock)'],
      },
      usage: [
        usage({
          provider: 'google-places',
          operation: 'text-search',
          units: 1,
          unitKind: DEFAULT_PRICING.googleTextSearchSku,
          estimatedCostMicros: Math.round(sku.per1000Micros / 1000),
          durationMs: 12,
        }),
      ],
    });
  }

  async refreshPlaceIds(
    placeIds: readonly string[],
  ): Promise<Result<WithUsage<Record<string, boolean>>>> {
    const known = new Set(MOCK_BUSINESSES.map((b) => b.placeId));
    const result: Record<string, boolean> = {};
    for (const id of placeIds) result[id] = known.has(id);

    return ok({
      data: result,
      // IDs-only refresh is free; reporting zero cost keeps that visible.
      usage: [
        usage({
          provider: 'google-places',
          operation: 'refresh-place-ids',
          units: placeIds.length,
          unitKind: 'text-search:essentials-ids-only',
          estimatedCostMicros: 0,
          durationMs: 4,
        }),
      ],
    });
  }
}

// ---------------------------------------------------------------------------
// Web discovery
// ---------------------------------------------------------------------------

/** Pages the mock web provider can serve, keyed by normalised domain. */
const MOCK_PAGES: Record<
  string,
  { title: string; description: string; content: string; links: string[] }
> = {
  'srikrishnadentalcare.in': {
    title: 'Sri Krishna Dental Care | Dentist in Anna Nagar, Chennai',
    description: 'Family dental clinic in Anna Nagar, Chennai. Call +91 44 2815 1234.',
    content:
      'Sri Krishna Dental Care is a family dental clinic in Anna Nagar, Chennai. ' +
      'Call us on +91 44 2815 1234 to book an appointment. Address: Anna Nagar, Chennai, Tamil Nadu.',
    links: ['/about', '/contact', '/services'],
  },
  'koramangaladentalhub.in': {
    title: 'Koramangala Dental Hub — Dentist in Bangalore',
    description: 'Modern dental care in Koramangala, Bangalore.',
    content:
      'Koramangala Dental Hub. Phone +91 80 4123 4567. Koramangala, Bangalore, Karnataka. ' +
      'Book online. Implants, orthodontics, whitening.',
    links: ['/about', '/contact', '/book'],
  },
  'jubileehillsdentalstudio.example': {
    title: 'Jubilee Hills Dental Studio',
    description: '',
    // Deliberately thin: a one-page site with no contact funnel is a redesign
    // lead, and the digital-presence rules must be able to see that.
    content: 'Jubilee Hills Dental Studio. Coming soon.',
    links: [],
  },
  'wrong-business.example': {
    title: 'Chennai Silks — Sarees and Textiles',
    description: 'Traditional sarees.',
    // Exists so website verification can be tested rejecting a plausible-looking
    // but wrong result — the failure mode that most damages lead trust.
    content: 'Chennai Silks. Sarees, textiles, wedding collections. Phone +91 44 9999 0000.',
    links: ['/contact'],
  },
};

export class MockWebDiscoveryProvider implements WebDiscoveryProvider {
  readonly name = 'mock-firecrawl';
  readonly isMock = true;

  async search(
    request: WebSearchRequest,
  ): Promise<Result<WithUsage<readonly WebSearchResult[]>>> {
    const needle = request.query.toLowerCase();

    // Match a fixture business by name, then offer its site plus one decoy, so
    // verification always has something wrong to reject.
    const business = MOCK_BUSINESSES.find((candidate) =>
      needle.includes(candidate.displayName.toLowerCase().slice(0, 12)),
    );

    const results: WebSearchResult[] = [];
    if (business) {
      const slug = business.normalizedName.replace(/\s+/g, '');
      const domain = `${slug}.in`;
      if (MOCK_PAGES[domain]) {
        results.push({
          url: `https://${domain}`,
          title: MOCK_PAGES[domain].title,
          description: MOCK_PAGES[domain].description,
          position: 1,
        });
      }
      results.push({
        url: 'https://wrong-business.example',
        title: MOCK_PAGES['wrong-business.example']!.title,
        description: MOCK_PAGES['wrong-business.example']!.description,
        position: results.length + 1,
      });
    }

    const credits = FIRECRAWL_OPERATIONS.search.creditsPerUnit;
    return ok({
      data: results.slice(0, request.limit ?? 10),
      usage: [
        usage({
          provider: 'firecrawl',
          operation: 'search',
          units: credits,
          unitKind: 'credits',
          estimatedCostMicros: Math.round(
            credits * firecrawlCreditMicros(DEFAULT_PRICING.firecrawlPlan),
          ),
          durationMs: 180,
        }),
      ],
    });
  }

  async fetchPage(request: PageFetchRequest): Promise<Result<WithUsage<FetchedPage>>> {
    const domain = normalizeDomain(request.url);
    const page = MOCK_PAGES[domain];

    const credits = FIRECRAWL_OPERATIONS.scrape.creditsPerUnit;
    const usageRecords = [
      usage({
        provider: 'firecrawl' as const,
        operation: 'scrape',
        units: credits,
        unitKind: 'credits',
        estimatedCostMicros: Math.round(
          credits * firecrawlCreditMicros(DEFAULT_PRICING.firecrawlPlan),
        ),
        durationMs: 240,
      }),
    ];

    if (!page) {
      // A dead or unknown domain is a normal outcome, not an exception — the
      // pipeline must handle it without failing the job.
      return err(
        new AppError({
          code: 'PROVIDER_BAD_RESPONSE',
          message: `Mock web provider has no page for ${domain}`,
          safeMessage: 'That website could not be reached.',
          retryability: 'never',
          context: { domain },
        }),
      );
    }

    return ok({
      data: {
        url: request.url,
        finalUrl: `https://${domain}/`,
        statusCode: 200,
        title: page.title,
        description: page.description,
        content: page.content,
        links: page.links.map((link) => `https://${domain}${link}`),
        httpsEnabled: true,
        byteLength: page.content.length,
        fetchedAt: new Date('2026-08-08T00:00:00.000Z'),
      },
      usage: usageRecords,
    });
  }
}

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

function aiUsage(model: string, inputTokens: number, outputTokens: number): UsageRecord {
  return usage({
    provider: 'groq',
    operation: 'chat.completions',
    units: 1,
    unitKind: 'calls',
    estimatedCostMicros: groqCallMicros(model, inputTokens, outputTokens),
    durationMs: 90,
    inputTokens,
    outputTokens,
  });
}

/**
 * Deterministic rule-based stand-in for Groq. It answers the same questions the
 * live provider does and returns the same validated shapes, so swapping between
 * them changes nothing downstream.
 */
export class MockAiProvider implements AiProvider {
  readonly name = 'mock-groq';
  readonly isMock = true;

  constructor(readonly model: string) {}

  async parseQuery(text: string): Promise<Result<WithUsage<AiVerdict<StructuredQuery>>>> {
    const lower = text.toLowerCase();

    const categories: string[] = [];
    for (const [needle, category] of [
      ['dental', 'dental clinic'],
      ['dentist', 'dental clinic'],
      ['cafe', 'cafe'],
      ['coffee', 'cafe'],
      ['restaurant', 'restaurant'],
      ['salon', 'beauty salon'],
      ['gym', 'gym'],
    ] as const) {
      if (lower.includes(needle) && !categories.includes(category)) categories.push(category);
    }

    const locations = MOCK_CITIES.filter((city) => lower.includes(city.name.toLowerCase())).map(
      (city) => `${city.name}, India`,
    );

    const ratingMatch = /(?:rating|rated)\D{0,20}?(\d(?:\.\d)?)/.exec(lower);
    const reviewMatch = /(\d[\d,]*)\s*(?:\+\s*)?reviews?/.exec(lower);

    const noWebsite = /no website|without a website|missing website|no site/.test(lower);

    const candidate = {
      categories: categories.length > 0 ? categories : ['dental clinic'],
      locations: locations.length > 0 ? locations : ['Chennai, India'],
      minimumRating: ratingMatch ? Number(ratingMatch[1]) : null,
      maximumRating: null,
      minimumReviews: reviewMatch ? Number(reviewMatch[1]!.replace(/,/g, '')) : null,
      maximumReviews: null,
      websiteStatus: noWebsite ? ('GOOGLE_WEBSITE_NOT_LISTED' as const) : ('ANY' as const),
      requireSocialPresence: /instagram|social/.test(lower) ? true : null,
      excludeChains: /independent|local|small|non-?chain/.test(lower),
      maxResults: null,
    };

    // Validated here for the same reason the live provider validates: mock
    // output must not be trusted more than real output, or the schema gate goes
    // untested in development.
    const parsed = structuredQuerySchema.safeParse(candidate);
    if (!parsed.success) {
      return err(
        new AppError({
          code: 'AI_SCHEMA_VIOLATION',
          message: `Mock parser produced an invalid query: ${parsed.error.message}`,
        }),
      );
    }

    return ok({
      data: {
        task: 'QUERY_PARSE',
        model: this.model,
        result: parsed.data,
        confidence: categories.length > 0 && locations.length > 0 ? 0.95 : 0.6,
        evidence: [text.slice(0, 200)],
        inputTokens: 420,
        outputTokens: 120,
      },
      usage: [aiUsage(this.model, 420, 120)],
    });
  }

  async normalizeCategory(
    text: string,
    allowed: readonly string[],
  ): Promise<Result<WithUsage<AiVerdict<{ category: string }>>>> {
    const lower = text.toLowerCase();
    const match = allowed.find((c) => lower.includes(c.toLowerCase())) ?? allowed[0] ?? text;
    return ok({
      data: {
        task: 'CATEGORY_NORMALIZE',
        model: this.model,
        result: { category: match },
        confidence: 0.9,
        evidence: [text.slice(0, 100)],
        inputTokens: 120,
        outputTokens: 20,
      },
      usage: [aiUsage(this.model, 120, 20)],
    });
  }

  async matchWebsite(
    input: WebsiteMatchInput,
  ): Promise<Result<WithUsage<AiVerdict<WebsiteMatchVerdict>>>> {
    const content = input.candidate.contentExcerpt.toLowerCase();
    const nameTokens = input.business.name
      .toLowerCase()
      .split(/\s+/)
      .filter((token) => token.length > 3);

    const matchedName = nameTokens.length > 0 && nameTokens.every((token) => content.includes(token));
    const matchedPhone =
      input.business.phoneDigits !== null &&
      input.candidate.phoneDigitsFound.includes(input.business.phoneDigits);
    const matchedCity =
      input.business.city !== null && content.includes(input.business.city.toLowerCase());
    const matchedCategory =
      input.business.category !== null && content.includes(input.business.category.toLowerCase());

    const positives = [matchedName, matchedPhone, matchedCity, matchedCategory].filter(
      Boolean,
    ).length;

    const status: WebsiteMatchVerdict['status'] =
      matchedPhone && matchedName
        ? 'MATCH'
        : positives >= 3
          ? 'PROBABLE_MATCH'
          : positives <= 1
            ? 'MISMATCH'
            : 'PROBABLE_MISMATCH';

    return ok({
      data: {
        task: 'WEBSITE_MATCH',
        model: this.model,
        result: { status, matchedName, matchedPhone, matchedCity, matchedCategory },
        confidence: status === 'MATCH' ? 0.96 : positives >= 3 ? 0.82 : 0.55,
        // Evidence is quoted from the input, never invented.
        evidence: [input.candidate.contentExcerpt.slice(0, 160)],
        inputTokens: 2_800,
        outputTokens: 140,
      },
      usage: [aiUsage(this.model, 2_800, 140)],
    });
  }

  async classifyDigitalPresence(
    input: DigitalPresenceInput,
  ): Promise<Result<WithUsage<AiVerdict<{ level: string; reasons: readonly string[] }>>>> {
    const reasons: string[] = [];
    let level: string;

    if (!input.hasVerifiedWebsite && input.socialPlatforms.length === 0) {
      level = 'MINIMAL';
      reasons.push('No verified website and no social profiles found');
    } else if (!input.hasVerifiedWebsite) {
      level = 'WEAK';
      reasons.push(`Social presence only (${input.socialPlatforms.join(', ')})`);
    } else if ((input.pageCount ?? 0) <= 1 || !input.hasContactPage) {
      level = 'MODERATE';
      reasons.push('Website exists but is thin or lacks a contact funnel');
    } else if (input.socialPlatforms.length >= 2 && input.hasBookingIndicator) {
      level = 'EXCELLENT';
      reasons.push('Website with booking plus multiple active social channels');
    } else {
      level = 'GOOD';
      reasons.push('Functional website with contact details');
    }

    return ok({
      data: {
        task: 'DIGITAL_PRESENCE_CLASSIFY',
        model: this.model,
        result: { level, reasons },
        confidence: 0.88,
        evidence: [input.contentExcerpt.slice(0, 160)],
        inputTokens: 1_600,
        outputTokens: 110,
      },
      usage: [aiUsage(this.model, 1_600, 110)],
    });
  }

  async summariseOpportunity(input: {
    readonly businessName: string;
    readonly signals: readonly string[];
  }): Promise<Result<WithUsage<AiVerdict<{ summary: string }>>>> {
    const summary =
      `${input.businessName} shows strong local demand with a weak digital footprint. ` +
      `Key signals: ${input.signals.slice(0, 4).join('; ')}.`;

    return ok({
      data: {
        task: 'LEAD_NARRATIVE',
        model: this.model,
        result: { summary },
        confidence: 0.8,
        evidence: input.signals.slice(0, 3),
        inputTokens: 1_400,
        outputTokens: 260,
      },
      usage: [aiUsage(this.model, 1_400, 260)],
    });
  }
}
