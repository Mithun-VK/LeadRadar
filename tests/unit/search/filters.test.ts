import { describe, expect, it } from 'vitest';

import { applyFilters, needsWebsiteDiscovery, partitionByFilters } from '@/modules/search/filters';
import type { NormalizedBusiness, StructuredQuery } from '@/types/domain';

function query(overrides: Partial<StructuredQuery> = {}): StructuredQuery {
  return {
    categories: ['dental clinic'],
    locations: ['Chennai, India'],
    minimumRating: null,
    maximumRating: null,
    minimumReviews: null,
    maximumReviews: null,
    websiteStatus: 'ANY',
    requireSocialPresence: null,
    excludeChains: false,
    maxResults: null,
    ...overrides,
  };
}

function business(overrides: Partial<NormalizedBusiness> = {}): NormalizedBusiness {
  return {
    placeId: 'ChIJtest',
    normalizedName: 'sri krishna dental care',
    displayName: 'Sri Krishna Dental Care',
    primaryCategory: 'dental clinic',
    categories: ['dental clinic'],
    formattedAddress: '12 Second Avenue, Anna Nagar, Chennai',
    city: 'Chennai',
    state: 'Tamil Nadu',
    country: 'India',
    postalCode: '600040',
    location: { latitude: 13.08, longitude: 80.27 },
    phone: '+914428151234',
    rating: 4.6,
    reviewCount: 320,
    businessStatus: 'OPERATIONAL',
    googleMapsUri: 'https://maps.google.com/?cid=1',
    websiteUri: null,
    googleWebsiteStatus: 'GOOGLE_WEBSITE_NOT_LISTED',
    observedAt: new Date('2026-08-08T00:00:00.000Z'),
    ...overrides,
  };
}

describe('applyFilters — closed businesses', () => {
  // Cheapest possible check, and the most complete disqualifier: a closed business
  // cannot buy anything, so it must never reach paid enrichment.
  it('drops permanently closed businesses first', () => {
    const outcome = applyFilters(
      business({ businessStatus: 'CLOSED_PERMANENTLY', rating: 5, reviewCount: 5_000 }),
      { query: query() },
    );
    expect(outcome.passed).toBe(false);
    expect(outcome.reason).toBe('CLOSED_PERMANENTLY');
  });

  it('drops temporarily closed businesses', () => {
    const outcome = applyFilters(business({ businessStatus: 'CLOSED_TEMPORARILY' }), {
      query: query(),
    });
    expect(outcome.reason).toBe('CLOSED_TEMPORARILY');
  });

  it('allows an unknown status through rather than assuming closure', () => {
    expect(applyFilters(business({ businessStatus: 'UNKNOWN' }), { query: query() }).passed).toBe(true);
  });
});

describe('applyFilters — rating and reviews', () => {
  it('enforces a minimum rating', () => {
    expect(applyFilters(business({ rating: 3.9 }), { query: query({ minimumRating: 4 }) }).reason).toBe(
      'RATING_BELOW_MINIMUM',
    );
    expect(applyFilters(business({ rating: 4.0 }), { query: query({ minimumRating: 4 }) }).passed).toBe(
      true,
    );
  });

  /**
   * "Unrated" and "rated zero" are different facts. Reporting a distinct reason
   * lets the UI explain that a business was excluded because the filter could not
   * be evaluated, not because it scored badly.
   */
  it('reports a missing rating distinctly from a low one', () => {
    const outcome = applyFilters(business({ rating: null }), { query: query({ minimumRating: 4 }) });
    expect(outcome.reason).toBe('RATING_MISSING');
  });

  it('passes an unrated business when no rating filter is set', () => {
    expect(applyFilters(business({ rating: null }), { query: query() }).passed).toBe(true);
  });

  it('enforces a minimum review count', () => {
    expect(
      applyFilters(business({ reviewCount: 49 }), { query: query({ minimumReviews: 50 }) }).reason,
    ).toBe('REVIEWS_BELOW_MINIMUM');
    expect(
      applyFilters(business({ reviewCount: 50 }), { query: query({ minimumReviews: 50 }) }).passed,
    ).toBe(true);
  });

  it('enforces maximum bounds too', () => {
    expect(
      applyFilters(business({ rating: 4.9 }), { query: query({ maximumRating: 4.5 }) }).reason,
    ).toBe('RATING_ABOVE_MAXIMUM');
    expect(
      applyFilters(business({ reviewCount: 5_000 }), { query: query({ maximumReviews: 1_000 }) })
        .reason,
    ).toBe('REVIEWS_ABOVE_MAXIMUM');
  });
});

describe('applyFilters — website status', () => {
  /**
   * The deliberate asymmetry, and the product's key insight.
   *
   * A user asking for "no website" wants businesses with no OWNED web presence. A
   * Practo or Instagram URL means exactly that, so those businesses must PASS the
   * filter — treating them as "has a website" discards the best web-development
   * leads in the dataset.
   */
  it('passes a directory-only listing when the user asked for no website', () => {
    const outcome = applyFilters(
      business({
        googleWebsiteStatus: 'GOOGLE_WEBSITE_IS_THIRD_PARTY_LISTING',
        websiteUri: 'https://www.practo.com/chennai/clinic/abc',
      }),
      { query: query({ websiteStatus: 'GOOGLE_WEBSITE_NOT_LISTED' }) },
    );
    expect(outcome.passed).toBe(true);
  });

  it('drops a business with a real website when the user asked for none', () => {
    const outcome = applyFilters(
      business({ googleWebsiteStatus: 'GOOGLE_WEBSITE_PRESENT', websiteUri: 'https://clinic.in' }),
      { query: query({ websiteStatus: 'GOOGLE_WEBSITE_NOT_LISTED' }) },
    );
    expect(outcome.reason).toBe('WEBSITE_STATUS_MISMATCH');
  });

  it('does not treat plain absence as a directory listing in the reverse direction', () => {
    const outcome = applyFilters(business({ googleWebsiteStatus: 'GOOGLE_WEBSITE_NOT_LISTED' }), {
      query: query({ websiteStatus: 'GOOGLE_WEBSITE_IS_THIRD_PARTY_LISTING' }),
    });
    expect(outcome.passed).toBe(false);
  });

  it('passes everything when the filter is ANY', () => {
    for (const status of [
      'GOOGLE_WEBSITE_PRESENT',
      'GOOGLE_WEBSITE_NOT_LISTED',
      'GOOGLE_WEBSITE_IS_THIRD_PARTY_LISTING',
    ] as const) {
      expect(applyFilters(business({ googleWebsiteStatus: status }), { query: query() }).passed).toBe(
        true,
      );
    }
  });
});

describe('applyFilters — chains and locality', () => {
  it('drops chain outlets when requested', () => {
    const outcome = applyFilters(business(), {
      query: query({ excludeChains: true }),
      isChain: true,
    });
    expect(outcome.reason).toBe('CHAIN_EXCLUDED');
  });

  it('keeps chains when not excluded', () => {
    expect(applyFilters(business(), { query: query(), isChain: true }).passed).toBe(true);
  });

  // Google sometimes returns a business just outside a restricted rectangle;
  // enriching it would spend budget on a lead in the wrong city.
  it('drops a business outside the searched cities', () => {
    const outcome = applyFilters(business({ city: 'Coimbatore' }), {
      query: query(),
      expectedCities: ['Chennai'],
    });
    expect(outcome.reason).toBe('CITY_MISMATCH');
  });

  it('accepts partial city-name matches, since Google varies its granularity', () => {
    expect(
      applyFilters(business({ city: 'Chennai' }), { query: query(), expectedCities: ['Chennai'] })
        .passed,
    ).toBe(true);
    expect(
      applyFilters(business({ city: 'Greater Chennai' }), {
        query: query(),
        expectedCities: ['Chennai'],
      }).passed,
    ).toBe(true);
  });

  it('does not drop a business with no city recorded', () => {
    expect(
      applyFilters(business({ city: null }), { query: query(), expectedCities: ['Chennai'] }).passed,
    ).toBe(true);
  });
});

describe('partitionByFilters', () => {
  it('separates passes from drops and counts the reasons', () => {
    const batch = [
      business({ placeId: 'a', reviewCount: 500 }),
      business({ placeId: 'b', reviewCount: 5 }),
      business({ placeId: 'c', businessStatus: 'CLOSED_PERMANENTLY' }),
      business({ placeId: 'd', reviewCount: 200 }),
    ];

    const result = partitionByFilters(batch, { query: query({ minimumReviews: 50 }) });

    expect(result.passed).toHaveLength(2);
    expect(result.dropped).toHaveLength(2);
    expect(result.reasonCounts.REVIEWS_BELOW_MINIMUM).toBe(1);
    expect(result.reasonCounts.CLOSED_PERMANENTLY).toBe(1);
  });

  // Retaining drops is what lets the UI explain "found 4,000, qualified 1,800",
  // which is how a user discovers their filters were too strict.
  it('retains a human-readable reason for every drop', () => {
    const result = partitionByFilters([business({ reviewCount: 3 })], {
      query: query({ minimumReviews: 100 }),
    });
    expect(result.dropped[0]!.outcome.detail).toContain('3 reviews');
  });

  it('applies a chain detector when supplied', () => {
    const result = partitionByFilters(
      [business({ displayName: 'Cafe Coffee Day - CP' })],
      { query: query({ excludeChains: true }) },
      (candidate) => candidate.displayName.includes('Cafe Coffee Day'),
    );
    expect(result.passed).toHaveLength(0);
    expect(result.reasonCounts.CHAIN_EXCLUDED).toBe(1);
  });

  it('handles an empty batch', () => {
    const result = partitionByFilters([], { query: query() });
    expect(result.passed).toEqual([]);
    expect(result.reasonCounts).toEqual({});
  });
});

describe('needsWebsiteDiscovery', () => {
  it('requires discovery when no website is listed', () => {
    expect(needsWebsiteDiscovery({ googleWebsiteStatus: 'GOOGLE_WEBSITE_NOT_LISTED' })).toBe(true);
  });

  it('requires discovery when the listed URL is a directory page', () => {
    expect(
      needsWebsiteDiscovery({ googleWebsiteStatus: 'GOOGLE_WEBSITE_IS_THIRD_PARTY_LISTING' }),
    ).toBe(true);
  });

  it('skips discovery when a real website is already listed', () => {
    expect(needsWebsiteDiscovery({ googleWebsiteStatus: 'GOOGLE_WEBSITE_PRESENT' })).toBe(false);
  });
});
