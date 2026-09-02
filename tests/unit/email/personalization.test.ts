import { describe, expect, it } from 'vitest';

import {
  containsOnlyGivenFacts,
  deterministicAngle,
  personalize,
  primaryOpportunity,
} from '@/modules/email/personalization';
import { deriveOpportunityFlags, type FlagDetail } from '@/modules/scoring/flags';
import type { AiProvider } from '@/modules/providers/contracts';
import { ok } from '@/lib/result';

function flags(
  overrides: Partial<Parameters<typeof deriveOpportunityFlags>[0]> = {},
): FlagDetail[] {
  return deriveOpportunityFlags({
    googleWebsiteStatus: 'GOOGLE_WEBSITE_NOT_LISTED',
    independentWebsiteStatus: 'NO_INDEPENDENT_WEBSITE_FOUND',
    observations: null,
    seoScore: null,
    mobileScore: null,
    hasEmail: true,
    socialPlatformCount: 1,
    rating: 4.5,
    reviewCount: 120,
    ...overrides,
  });
}

const base = {
  businessName: 'Acme Dental',
  industry: 'dental clinic',
  city: 'Chennai',
  verifiedDomain: null,
  recommendedService: 'WEBSITE_DEVELOPMENT',
  websiteQualityScore: null,
};

/** An AI provider whose summariser returns whatever text a test supplies. */
function stubAi(summary: string): AiProvider {
  return {
    name: 'stub',
    model: 'stub-model',
    isMock: true,
    parseQuery: async () => {
      throw new Error('not used');
    },
    normalizeCategory: async () => {
      throw new Error('not used');
    },
    matchWebsite: async () => {
      throw new Error('not used');
    },
    classifyDigitalPresence: async () => {
      throw new Error('not used');
    },
    summariseOpportunity: async () =>
      ok({
        data: {
          task: 'LEAD_NARRATIVE' as const,
          model: 'stub-model',
          result: { summary },
          confidence: 0.95,
          evidence: [],
          inputTokens: 10,
          outputTokens: 10,
        },
        usage: [],
      }),
  };
}

describe('deterministicAngle', () => {
  it('produces a sentence drawn from the measured flag', () => {
    const angle = deterministicAngle({ ...base, flags: flags() });

    expect(angle).toBeTruthy();
    expect(angle).toContain('Acme Dental');
    expect(angle).toContain('Chennai');
  });

  it('leads with the single highest-severity finding rather than listing everything', () => {
    const angle = deterministicAngle({
      ...base,
      flags: flags({
        independentWebsiteStatus: 'INDEPENDENT_WEBSITE_FOUND',
        observations: {
          httpsEnabled: false,
          hasViewportMeta: false,
          hasTitle: true,
          titleLength: 30,
          hasMetaDescription: false,
          metaDescriptionLength: null,
          h1Count: 0,
          imageCount: 4,
          imagesWithAlt: 0,
          hasStructuredData: false,
          hasCanonical: false,
          hasContactPage: false,
          hasBookingIndicator: false,
          hasResponsiveHints: false,
          internalLinkCount: 2,
          externalLinkCount: 0,
          contentLength: 900,
          mixedContentCount: 2,
          isThin: false,
          isParked: false,
          isFreeHosting: false,
          pageBytes: 1_000,
          scriptCount: 1,
          htmlUnavailable: false,
        },
        seoScore: 3,
        mobileScore: 1,
      }),
    });

    // One observation, not a bulleted audit report.
    expect(angle!.split('.').filter((s) => s.trim().length > 0).length).toBeLessThanOrEqual(3);
  });

  it('returns null when there is nothing worth saying', () => {
    expect(deterministicAngle({ ...base, flags: [] })).toBeNull();
  });

  it('never leads with a flag that would insult the prospect', () => {
    // Low review count and a weak rating are real, but saying them to the
    // recipient is offensive and they are not fixable by the sender's service.
    const angle = deterministicAngle({
      ...base,
      flags: flags({
        independentWebsiteStatus: 'INDEPENDENT_WEBSITE_FOUND',
        reviewCount: 3,
        rating: 2.5,
      }),
    });

    if (angle) {
      expect(angle).not.toMatch(/only \d+ reviews|rating is a visible reputation problem/i);
    }
  });
});

describe('primaryOpportunity', () => {
  it('returns a short label for the clearest gap', () => {
    expect(primaryOpportunity(flags())).toBe('no website');
  });

  it('returns null when nothing is sayable', () => {
    expect(primaryOpportunity([])).toBeNull();
  });
});

describe('containsOnlyGivenFacts', () => {
  const source = 'Measured observation: your site has no mobile viewport tag. City: Chennai.';

  it('accepts a rephrasing that adds no new specifics', () => {
    expect(containsOnlyGivenFacts('Your website is missing its mobile viewport tag.', source)).toBe(
      true,
    );
  });

  it('rejects an invented metric', () => {
    // The exact failure this guard exists for.
    expect(
      containsOnlyGivenFacts(
        'Your site takes 8 seconds to load and loses 40% of visitors.',
        source,
      ),
    ).toBe(false);
  });

  it('rejects an invented percentage', () => {
    expect(containsOnlyGivenFacts('You are losing 62% of mobile traffic.', source)).toBe(false);
  });

  it('rejects an invented URL', () => {
    expect(
      containsOnlyGivenFacts('See https://example.com/audit for the full report.', source),
    ).toBe(false);
  });

  it('accepts a number that was actually given', () => {
    expect(
      containsOnlyGivenFacts(
        '14 of your 17 images have no alt text.',
        'Finding: 14 of 17 images have no alt text',
      ),
    ).toBe(true);
  });
});

describe('personalize', () => {
  it('supplies values only for facts that are known', async () => {
    const result = await personalize(
      { ...base, city: null, industry: null, flags: flags() },
      { senderName: 'Priya', companyName: 'Acme Agency' },
    );

    expect(result.values.business_name).toBe('Acme Dental');
    expect(result.values.sender_name).toBe('Priya');
    // Absent rather than filled with a plausible default, so the strict renderer
    // skips this lead instead of inventing a city.
    expect(result.values.city).toBeUndefined();
    expect(result.values.industry).toBeUndefined();
  });

  it('marks the angle as measured when no AI is involved', async () => {
    const result = await personalize(
      { ...base, flags: flags() },
      { senderName: 'Priya', companyName: 'Acme Agency' },
    );

    expect(result.angleSource).toBe('measured');
  });

  it('accepts an AI rephrasing that introduces no new facts', async () => {
    const result = await personalize(
      { ...base, flags: flags() },
      {
        senderName: 'Priya',
        companyName: 'Acme Agency',
        ai: stubAi('I could not find a website for Acme Dental anywhere online.'),
      },
    );

    expect(result.angleSource).toBe('ai-rephrased');
    expect(result.values.sales_angle).toContain('Acme Dental');
  });

  it('discards an AI rephrasing that invents a metric, keeping the measured sentence', async () => {
    const result = await personalize(
      { ...base, flags: flags() },
      {
        senderName: 'Priya',
        companyName: 'Acme Agency',
        ai: stubAi('Your site loses 73% of visitors within 4 seconds of loading.'),
      },
    );

    expect(result.angleSource).toBe('measured');
    expect(result.values.sales_angle).not.toContain('73%');
  });

  it('discards an over-long AI rephrasing', async () => {
    const result = await personalize(
      { ...base, flags: flags() },
      {
        senderName: 'Priya',
        companyName: 'Acme Agency',
        ai: stubAi('word '.repeat(200)),
      },
    );

    expect(result.angleSource).toBe('measured');
  });

  it('maps the recommended service to plain language', async () => {
    const result = await personalize(
      { ...base, flags: flags() },
      { senderName: 'Priya', companyName: 'Acme Agency' },
    );

    expect(result.values.recommended_service).toBe('building websites');
  });

  it('derives a service from the flags when none has been stored', async () => {
    /**
     * Regression. An unscored or imported lead has no ServiceRecommendation row,
     * which left `{{recommended_service}}` unresolved — so the SHIPPED starter
     * template silently refused every such lead with an unexplained
     * "template needs details this lead does not have". Runtime verification
     * caught it.
     */
    const result = await personalize(
      { ...base, recommendedService: null, flags: flags() },
      { senderName: 'Priya', companyName: 'Acme Agency' },
    );

    expect(result.values.recommended_service).toBe('building websites');
  });

  it('derives a redesign rather than a build when the site exists but is weak', async () => {
    const result = await personalize(
      {
        ...base,
        recommendedService: null,
        flags: flags({
          independentWebsiteStatus: 'INDEPENDENT_WEBSITE_FOUND',
          googleWebsiteStatus: 'GOOGLE_WEBSITE_PRESENT',
          observations: {
            httpsEnabled: false,
            hasViewportMeta: true,
            hasTitle: true,
            titleLength: 40,
            hasMetaDescription: true,
            metaDescriptionLength: 120,
            h1Count: 1,
            imageCount: 4,
            imagesWithAlt: 4,
            hasStructuredData: true,
            hasCanonical: true,
            hasContactPage: true,
            hasBookingIndicator: true,
            hasResponsiveHints: true,
            internalLinkCount: 10,
            externalLinkCount: 2,
            contentLength: 2_500,
            mixedContentCount: 0,
            isThin: false,
            isParked: false,
            isFreeHosting: false,
            pageBytes: 5_000,
            scriptCount: 3,
            htmlUnavailable: false,
          },
          seoScore: 25,
          mobileScore: 20,
        }),
      },
      { senderName: 'Priya', companyName: 'Acme Agency' },
    );

    expect(result.values.recommended_service).toBe('website redesigns');
  });

  it('leaves the service absent when there is no evidence for one', async () => {
    // Absent rather than guessed: the strict renderer then skips the lead instead
    // of pitching a service nothing supports.
    const result = await personalize(
      { ...base, recommendedService: null, flags: [] },
      { senderName: 'Priya', companyName: 'Acme Agency' },
    );

    expect(result.values.recommended_service).toBeUndefined();
  });

  it('prefers a stored recommendation over the derived fallback', async () => {
    const result = await personalize(
      { ...base, recommendedService: 'LOCAL_SEO', flags: flags() },
      { senderName: 'Priya', companyName: 'Acme Agency' },
    );

    expect(result.values.recommended_service).toBe('local search visibility');
  });
});
