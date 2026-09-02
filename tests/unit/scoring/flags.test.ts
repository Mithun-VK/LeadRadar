import { describe, expect, it } from 'vitest';

import {
  ALL_OPPORTUNITY_FLAGS,
  FLAG_LABELS,
  deriveOpportunityFlags,
  flagNames,
  rankFlags,
  type FlagInput,
} from '@/modules/scoring/flags';
import type { WebsiteObservations } from '@/modules/enrichment/website-analysis';

function observations(overrides: Partial<WebsiteObservations> = {}): WebsiteObservations {
  return {
    httpsEnabled: true,
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
    ...overrides,
  };
}

function input(overrides: Partial<FlagInput> = {}): FlagInput {
  return {
    googleWebsiteStatus: 'GOOGLE_WEBSITE_PRESENT',
    independentWebsiteStatus: 'INDEPENDENT_WEBSITE_FOUND',
    observations: observations(),
    seoScore: 25,
    mobileScore: 20,
    hasEmail: true,
    socialPlatformCount: 2,
    rating: 4.6,
    reviewCount: 180,
    ...overrides,
  };
}

describe('deriveOpportunityFlags — website state', () => {
  it('raises NO_WEBSITE when nothing was found and Google listed nothing', () => {
    const flags = flagNames(
      deriveOpportunityFlags(
        input({
          independentWebsiteStatus: 'NO_INDEPENDENT_WEBSITE_FOUND',
          googleWebsiteStatus: 'GOOGLE_WEBSITE_NOT_LISTED',
          observations: null,
          seoScore: null,
          mobileScore: null,
        }),
      ),
    );

    expect(flags).toContain('NO_WEBSITE');
    expect(flags).not.toContain('DIRECTORY_LISTING_ONLY');
  });

  it('distinguishes a directory-only presence from having no presence at all', () => {
    const flags = flagNames(
      deriveOpportunityFlags(
        input({
          independentWebsiteStatus: 'NO_INDEPENDENT_WEBSITE_FOUND',
          googleWebsiteStatus: 'GOOGLE_WEBSITE_IS_THIRD_PARTY_LISTING',
          observations: null,
          seoScore: null,
          mobileScore: null,
        }),
      ),
    );

    // The product's central distinction: a business on Practo with no own site
    // is a better prospect than one with nothing, not the same thing.
    expect(flags).toContain('DIRECTORY_LISTING_ONLY');
    expect(flags).not.toContain('NO_WEBSITE');
  });

  it('raises WEBSITE_BROKEN for a listed site that would not load', () => {
    const flags = flagNames(
      deriveOpportunityFlags(
        input({
          independentWebsiteStatus: 'WEBSITE_BROKEN',
          observations: null,
          seoScore: null,
          mobileScore: null,
        }),
      ),
    );

    expect(flags).toContain('WEBSITE_BROKEN');
  });

  it('never emits two conflicting website-state flags at once', () => {
    const exclusive = ['NO_WEBSITE', 'DIRECTORY_LISTING_ONLY', 'WEBSITE_BROKEN', 'WEBSITE_PARKED'];

    for (const status of [
      'NO_INDEPENDENT_WEBSITE_FOUND',
      'WEBSITE_BROKEN',
      'INDEPENDENT_WEBSITE_FOUND',
      'WEBSITE_UNVERIFIED',
    ]) {
      const flags = flagNames(deriveOpportunityFlags(input({ independentWebsiteStatus: status })));
      const hits = flags.filter((flag) => exclusive.includes(flag));
      expect(hits.length).toBeLessThanOrEqual(1);
    }
  });

  it('raises WEBSITE_PARKED for a placeholder page', () => {
    const flags = flagNames(
      deriveOpportunityFlags(input({ observations: observations({ isParked: true }) })),
    );

    expect(flags).toContain('WEBSITE_PARKED');
    expect(flags).not.toContain('NO_WEBSITE');
  });

  it('raises THIN_WEBSITE for a single-page presence', () => {
    const flags = flagNames(
      deriveOpportunityFlags(
        input({
          observations: observations({ isThin: true, contentLength: 200, internalLinkCount: 1 }),
        }),
      ),
    );

    expect(flags).toContain('THIN_WEBSITE');
  });
});

describe('deriveOpportunityFlags — measured defects', () => {
  it('raises NO_HTTPS for a plain-http site', () => {
    const flags = flagNames(
      deriveOpportunityFlags(input({ observations: observations({ httpsEnabled: false }) })),
    );

    expect(flags).toContain('NO_HTTPS');
  });

  it('raises POOR_MOBILE and names the viewport tag as the reason', () => {
    const details = deriveOpportunityFlags(
      input({ observations: observations({ hasViewportMeta: false }), mobileScore: 7 }),
    );
    const mobile = details.find((d) => d.flag === 'POOR_MOBILE');

    expect(mobile).toBeDefined();
    expect(mobile!.rationale).toMatch(/viewport/i);
  });

  it('raises MISSING_ALT_TEXT with the actual counts', () => {
    const details = deriveOpportunityFlags(
      input({ observations: observations({ imageCount: 17, imagesWithAlt: 3 }) }),
    );
    const alt = details.find((d) => d.flag === 'MISSING_ALT_TEXT');

    expect(alt).toBeDefined();
    expect(alt!.rationale).toContain('14 of 17');
  });

  it('does not raise MISSING_ALT_TEXT when most images are covered', () => {
    const flags = flagNames(
      deriveOpportunityFlags(
        input({ observations: observations({ imageCount: 10, imagesWithAlt: 9 }) }),
      ),
    );

    expect(flags).not.toContain('MISSING_ALT_TEXT');
  });

  it('raises MISSING_META_DESCRIPTION and MISSING_H1 from real absences', () => {
    const flags = flagNames(
      deriveOpportunityFlags(
        input({ observations: observations({ hasMetaDescription: false, h1Count: 0 }) }),
      ),
    );

    expect(flags).toContain('MISSING_META_DESCRIPTION');
    expect(flags).toContain('MISSING_H1');
  });

  it('does not claim missing structured data when the markup could not be read', () => {
    const flags = flagNames(
      deriveOpportunityFlags(
        input({
          observations: observations({ htmlUnavailable: true, hasStructuredData: false }),
        }),
      ),
    );

    // "We could not look" must never be reported as "it is absent".
    expect(flags).not.toContain('NO_STRUCTURED_DATA');
    expect(flags).not.toContain('OUTDATED_WEBSITE');
  });

  it('claims OUTDATED_WEBSITE only from converging structural evidence', () => {
    const outdated = flagNames(
      deriveOpportunityFlags(
        input({
          observations: observations({ hasViewportMeta: false, hasStructuredData: false }),
        }),
      ),
    );
    expect(outdated).toContain('OUTDATED_WEBSITE');

    // One weak signal alone is not enough to call a site outdated.
    const notOutdated = flagNames(
      deriveOpportunityFlags(input({ observations: observations({ hasStructuredData: false }) })),
    );
    expect(notOutdated).not.toContain('OUTDATED_WEBSITE');
  });
});

describe('deriveOpportunityFlags — reachability and commercial signals', () => {
  it('raises NO_CONTACT_EMAIL when no address was found', () => {
    expect(flagNames(deriveOpportunityFlags(input({ hasEmail: false })))).toContain(
      'NO_CONTACT_EMAIL',
    );
  });

  it('raises NO_SOCIAL_MEDIA when no profiles were found', () => {
    expect(flagNames(deriveOpportunityFlags(input({ socialPlatformCount: 0 })))).toContain(
      'NO_SOCIAL_MEDIA',
    );
  });

  it('raises LOW_REVIEW_COUNT so a downgraded grade is explained rather than mysterious', () => {
    const details = deriveOpportunityFlags(input({ reviewCount: 6 }));
    const low = details.find((d) => d.flag === 'LOW_REVIEW_COUNT');

    expect(low).toBeDefined();
    expect(low!.rationale).toContain('6 reviews');
  });

  it('raises DECLINING_RATING below the weak-rating threshold', () => {
    expect(flagNames(deriveOpportunityFlags(input({ rating: 3.1 })))).toContain('DECLINING_RATING');
    expect(flagNames(deriveOpportunityFlags(input({ rating: 4.4 })))).not.toContain(
      'DECLINING_RATING',
    );
  });

  it('leaves a strong, well-built business with essentially no flags', () => {
    const flags = flagNames(deriveOpportunityFlags(input()));
    expect(flags).toEqual([]);
  });
});

describe('flag vocabulary', () => {
  it('has a label for every flag it can emit', () => {
    const cases: FlagInput[] = [
      input(),
      input({
        observations: null,
        independentWebsiteStatus: 'NO_INDEPENDENT_WEBSITE_FOUND',
        seoScore: null,
        mobileScore: null,
      }),
      input({
        independentWebsiteStatus: 'WEBSITE_BROKEN',
        observations: null,
        seoScore: null,
        mobileScore: null,
      }),
      input({
        observations: observations({
          httpsEnabled: false,
          hasViewportMeta: false,
          hasStructuredData: false,
          hasMetaDescription: false,
          h1Count: 0,
          imageCount: 10,
          imagesWithAlt: 0,
          hasContactPage: false,
          hasBookingIndicator: false,
          isFreeHosting: true,
          mixedContentCount: 3,
          contentLength: 900,
        }),
        seoScore: 4,
        mobileScore: 2,
        hasEmail: false,
        socialPlatformCount: 0,
        rating: 2.9,
        reviewCount: 3,
      }),
    ];

    for (const scenario of cases) {
      for (const detail of deriveOpportunityFlags(scenario)) {
        expect(FLAG_LABELS[detail.flag]).toBeDefined();
        expect(ALL_OPPORTUNITY_FLAGS).toContain(detail.flag);
        // Every flag must justify itself with a measurement, not an adjective.
        expect(detail.rationale.length).toBeGreaterThan(20);
      }
    }
  });

  it('has no flag asserting page speed, which is never measured', () => {
    expect(ALL_OPPORTUNITY_FLAGS).not.toContain('SLOW_WEBSITE');
    for (const label of Object.values(FLAG_LABELS)) {
      expect(label).not.toMatch(/slow|speed|load time/i);
    }
  });
});

describe('rankFlags', () => {
  it('puts high-severity flags first for a UI that shows only the top few', () => {
    const details = deriveOpportunityFlags(
      input({
        observations: observations({
          httpsEnabled: false,
          hasStructuredData: false,
          hasViewportMeta: false,
        }),
        seoScore: 5,
        mobileScore: 1,
        reviewCount: 4,
      }),
    );

    const ranked = rankFlags(details);
    const severities = ranked.map((d) => d.severity);
    const firstLow = severities.indexOf('low');
    const lastHigh = severities.lastIndexOf('high');

    if (firstLow !== -1 && lastHigh !== -1) expect(lastHigh).toBeLessThan(firstLow);
  });

  it('does not mutate its input', () => {
    const details = deriveOpportunityFlags(input({ hasEmail: false, socialPlatformCount: 0 }));
    const before = [...details];
    rankFlags(details);
    expect(details).toEqual(before);
  });
});
