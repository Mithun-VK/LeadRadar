import { describe, expect, it } from 'vitest';

import { scoreOpportunity, type ScoringInput } from '@/modules/scoring/opportunity';
import { DEFAULT_CAPS } from '@/modules/scoring/config';

/** A strong lead: real demand, no web presence, contactable. */
function base(overrides: Partial<ScoringInput> = {}): ScoringInput {
  return {
    businessStatus: 'OPERATIONAL',
    googleWebsiteStatus: 'GOOGLE_WEBSITE_NOT_LISTED',
    independentWebsiteStatus: 'NO_INDEPENDENT_WEBSITE_FOUND',
    rating: 4.8,
    reviewCount: 1_200,
    reviewVelocityPerMonth: null,
    hasPhone: true,
    socialPlatforms: ['INSTAGRAM'],
    isChain: false,
    identityVerification: 'PROBABLE',
    websiteQuality: null,
    ...overrides,
  };
}

describe('scoreOpportunity — the central ranking requirement', () => {
  /**
   * The failure that motivates the whole multiplicative design.
   *
   * Under additive weights (+30 no website, +25 no verified website, +15 phone,
   * +10 rating) a 4.1-star clinic with 8 reviews scores ~80 and lands in grade A,
   * despite almost certainly having no budget. This asserts the correct ordering
   * with a wide margin, so a future refactor toward additive scoring fails here.
   */
  it('ranks a high-review no-website business far above a low-review one', () => {
    const strong = scoreOpportunity(base({ rating: 4.8, reviewCount: 1_200 }));
    const weak = scoreOpportunity(base({ rating: 4.1, reviewCount: 8, socialPlatforms: [] }));

    expect(strong.total).toBeGreaterThan(weak.total + 30);
    expect(strong.priority).toBe('A_PLUS');
    expect(weak.priority).not.toBe('A_PLUS');
    expect(weak.priority).not.toBe('A');
  });

  it('caps a sub-10-review business at grade C however total the website gap', () => {
    const result = scoreOpportunity(base({ reviewCount: 6, rating: 5.0 }));
    expect(result.total).toBeLessThanOrEqual(DEFAULT_CAPS.lowReviewMaxScore);
    expect(['C', 'D']).toContain(result.priority);
    expect(result.appliedCaps.join(' ')).toMatch(/reviews/i);
  });

  it('reaches the top band for a genuinely excellent lead', () => {
    const result = scoreOpportunity(
      base({ identityVerification: 'VERIFIED', reviewVelocityPerMonth: 12 }),
    );
    expect(result.total).toBeGreaterThanOrEqual(90);
    expect(result.priority).toBe('A_PLUS');
  });
});

describe('scoreOpportunity — need factor', () => {
  it('rates a directory-only listing nearly as high as total absence', () => {
    const absent = scoreOpportunity(base());
    const directoryOnly = scoreOpportunity(
      base({
        googleWebsiteStatus: 'GOOGLE_WEBSITE_IS_THIRD_PARTY_LISTING',
        independentWebsiteStatus: 'NO_INDEPENDENT_WEBSITE_FOUND',
      }),
    );

    // The business owns no site either way; a directory listing even proves
    // willingness to invest in being found.
    expect(Math.abs(absent.total - directoryOnly.total)).toBeLessThan(8);
    expect(directoryOnly.priority).toBe('A_PLUS');
  });

  it('scores a good website well below no website', () => {
    const noSite = scoreOpportunity(base());
    const goodSite = scoreOpportunity(
      base({
        googleWebsiteStatus: 'GOOGLE_WEBSITE_PRESENT',
        independentWebsiteStatus: 'INDEPENDENT_WEBSITE_FOUND',
        websiteQuality: {
          httpsEnabled: true,
          isFreeHosting: false,
          hasContactPage: true,
          hasBookingIndicator: true,
          contentLength: 8_000,
          isThin: false,
          isParked: false,
          linkCount: 30,
        },
      }),
    );

    expect(goodSite.total).toBeLessThan(noSite.total - 30);
  });

  it('rates a broken website above a working one — it is actively losing customers', () => {
    const broken = scoreOpportunity(base({ independentWebsiteStatus: 'WEBSITE_BROKEN' }));
    const working = scoreOpportunity(
      base({
        independentWebsiteStatus: 'INDEPENDENT_WEBSITE_FOUND',
        websiteQuality: {
          httpsEnabled: true,
          isFreeHosting: false,
          hasContactPage: true,
          hasBookingIndicator: false,
          contentLength: 5_000,
          isThin: false,
          isParked: false,
          linkCount: 20,
        },
      }),
    );
    expect(broken.total).toBeGreaterThan(working.total);
  });

  it('rates a parked domain as high need', () => {
    const parked = scoreOpportunity(
      base({
        independentWebsiteStatus: 'INDEPENDENT_WEBSITE_FOUND',
        websiteQuality: {
          httpsEnabled: true,
          isFreeHosting: false,
          hasContactPage: false,
          hasBookingIndicator: false,
          contentLength: 40,
          isThin: true,
          isParked: true,
          linkCount: 0,
        },
      }),
    );
    expect(parked.factors.need).toBeGreaterThan(0.8);
  });
});

describe('scoreOpportunity — value factor', () => {
  it('increases monotonically with review count', () => {
    const counts = [0, 10, 50, 100, 200, 500, 1_000];
    const scores = counts.map((reviewCount) => scoreOpportunity(base({ reviewCount })).factors.value);

    for (let i = 1; i < scores.length; i += 1) {
      expect(scores[i]!, `${counts[i]} vs ${counts[i - 1]}`).toBeGreaterThanOrEqual(scores[i - 1]!);
    }
  });

  it('penalises a poor rating as a struggling-business signal', () => {
    const good = scoreOpportunity(base({ rating: 4.6 }));
    const poor = scoreOpportunity(base({ rating: 2.8 }));
    expect(poor.factors.value).toBeLessThan(good.factors.value);
  });

  it('rewards review growth, which only exists because snapshots are refreshed', () => {
    // A mid-tier business, because value saturates at 1.0 for a 1,200-review
    // business and a bonus cannot exceed the ceiling.
    const flat = scoreOpportunity(base({ reviewCount: 120, reviewVelocityPerMonth: 0 }));
    const growing = scoreOpportunity(base({ reviewCount: 120, reviewVelocityPerMonth: 15 }));
    expect(growing.factors.value).toBeGreaterThan(flat.factors.value);
  });

  it('clamps the value factor at 1.0 rather than letting bonuses compound past it', () => {
    const result = scoreOpportunity(base({ reviewCount: 100_000, rating: 5, reviewVelocityPerMonth: 500 }));
    expect(result.factors.value).toBe(1);
  });

  it('treats a missing rating as neutral rather than as zero', () => {
    const result = scoreOpportunity(base({ rating: null }));
    expect(result.total).toBeGreaterThan(50);
  });
});

describe('scoreOpportunity — reach factor', () => {
  it('scores a lead with no contact route lower', () => {
    const contactable = scoreOpportunity(base());
    const unreachable = scoreOpportunity(base({ hasPhone: false, socialPlatforms: [] }));

    expect(unreachable.factors.reach).toBeLessThan(contactable.factors.reach);
    expect(unreachable.total).toBeLessThan(contactable.total);
  });

  // Multiplication means a weak factor dominates, which is the intended
  // behaviour: an uncontactable business is not a strong lead with a caveat.
  it('lets weak reach drag down an otherwise perfect lead', () => {
    const result = scoreOpportunity(base({ hasPhone: false, socialPlatforms: [] }));
    expect(result.factors.need).toBeGreaterThan(0.9);
    expect(result.factors.value).toBeGreaterThan(0.9);
    expect(result.total).toBeLessThan(70);
  });
});

describe('scoreOpportunity — caps', () => {
  it('scores a permanently closed business to the floor', () => {
    const result = scoreOpportunity(base({ businessStatus: 'CLOSED_PERMANENTLY' }));
    expect(result.total).toBeLessThanOrEqual(DEFAULT_CAPS.closedMaxScore);
    expect(result.priority).toBe('D');
  });

  it('caps a chain outlet, because the decision sits with head office', () => {
    const result = scoreOpportunity(base({ isChain: true }));
    expect(result.total).toBeLessThanOrEqual(DEFAULT_CAPS.chainMaxScore);
    expect(result.appliedCaps.join(' ')).toMatch(/head office/i);
  });

  it('keeps an unverified lead out of the top band', () => {
    const result = scoreOpportunity(base({ identityVerification: 'UNVERIFIED' }));
    expect(result.total).toBeLessThanOrEqual(DEFAULT_CAPS.unverifiedMaxScore);
  });
});

describe('scoreOpportunity — explainability', () => {
  it('produces a signal for every factor with a rationale and provenance', () => {
    const result = scoreOpportunity(base());

    expect(result.signals.length).toBeGreaterThanOrEqual(3);
    for (const signal of result.signals) {
      expect(signal.label).not.toBe('');
      expect(signal.rationale).not.toBe('');
      expect(['need', 'value', 'reach']).toContain(signal.factor);
      expect(signal.provenance).not.toBe('');
    }

    expect(result.signals.some((signal) => signal.factor === 'need')).toBe(true);
    expect(result.signals.some((signal) => signal.factor === 'value')).toBe(true);
    expect(result.signals.some((signal) => signal.factor === 'reach')).toBe(true);
  });

  it('is deterministic', () => {
    const input = base();
    expect(scoreOpportunity(input).total).toBe(scoreOpportunity(input).total);
  });

  it('always stays within 0-100 and reports a version', () => {
    const cases: Array<Partial<ScoringInput>> = [
      {},
      { reviewCount: 0, rating: null, hasPhone: false, socialPlatforms: [] },
      { reviewCount: 100_000, rating: 5, reviewVelocityPerMonth: 500 },
      { businessStatus: 'CLOSED_PERMANENTLY', isChain: true },
    ];

    for (const override of cases) {
      const result = scoreOpportunity(base(override));
      expect(result.total).toBeGreaterThanOrEqual(0);
      expect(result.total).toBeLessThanOrEqual(100);
      expect(result.signalsVersion).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});

describe('classifyDigitalPresence', () => {
  it('reports MINIMAL with no website and no social', () => {
    expect(scoreOpportunity(base({ socialPlatforms: [] })).digitalPresence).toBe('MINIMAL');
  });

  it('reports WEAK for social-only', () => {
    expect(scoreOpportunity(base()).digitalPresence).toBe('WEAK');
  });

  it('reports EXCELLENT for a full presence', () => {
    const result = scoreOpportunity(
      base({
        independentWebsiteStatus: 'INDEPENDENT_WEBSITE_FOUND',
        socialPlatforms: ['INSTAGRAM', 'FACEBOOK'],
        websiteQuality: {
          httpsEnabled: true,
          isFreeHosting: false,
          hasContactPage: true,
          hasBookingIndicator: true,
          contentLength: 9_000,
          isThin: false,
          isParked: false,
          linkCount: 40,
        },
      }),
    );
    expect(result.digitalPresence).toBe('EXCELLENT');
  });
});
