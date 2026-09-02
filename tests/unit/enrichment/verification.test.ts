import { describe, expect, it } from 'vitest';

import {
  ACCEPT_THRESHOLD,
  REJECT_THRESHOLD,
  assessWebsiteQuality,
  mergeResults,
  needsAiAdjudication,
  outcomeFromDeterministic,
  scoreDeterministic,
  secondaryPagePaths,
} from '@/modules/enrichment/verification';
import type { FetchedPage } from '@/modules/providers/contracts';

const business = {
  displayName: 'Sri Krishna Dental Care',
  normalizedName: 'sri krishna dental care',
  city: 'Chennai',
  primaryCategory: 'dental clinic',
  formattedAddress: '12 Second Avenue, Anna Nagar, Chennai, Tamil Nadu 600040',
  phoneDigits: '4428151234',
};

function page(overrides: Partial<FetchedPage> = {}): FetchedPage {
  return {
    url: 'https://srikrishnadental.in',
    finalUrl: 'https://srikrishnadental.in/',
    statusCode: 200,
    title: 'Sri Krishna Dental Care | Dentist in Anna Nagar, Chennai',
    description: 'Family dental clinic in Anna Nagar, Chennai.',
    content:
      'Sri Krishna Dental Care is a family dental clinic in Anna Nagar, Chennai. ' +
      'Call +91 44 2815 1234 to book. 12 Second Avenue, Anna Nagar, Chennai, Tamil Nadu 600040.',
    html: null,
    links: ['https://srikrishnadental.in/contact', 'https://srikrishnadental.in/about'],
    httpsEnabled: true,
    byteLength: 200,
    fetchedAt: new Date('2026-08-08T00:00:00.000Z'),
    ...overrides,
  };
}

describe('scoreDeterministic — the true positive', () => {
  it('accepts a matching site on rules alone, with no AI needed', () => {
    const result = scoreDeterministic({ business, page: page() });

    expect(result.score).toBeGreaterThanOrEqual(ACCEPT_THRESHOLD);
    expect(result.matched.phone).toBe(true);
    expect(result.matched.name).toBe(true);
    expect(result.matched.city).toBe(true);
    expect(needsAiAdjudication(result)).toBe(false);
    expect(outcomeFromDeterministic(result).status).toBe('MATCH');
  });

  it('records evidence for every field it considered', () => {
    const result = scoreDeterministic({ business, page: page() });
    const fields = new Set(result.evidence.map((entry) => entry.field));

    expect(fields.has('phone')).toBe(true);
    expect(fields.has('name')).toBe(true);
    expect(fields.has('domain')).toBe(true);
    for (const entry of result.evidence) {
      expect(entry.detail).not.toBe('');
    }
  });
});

describe('scoreDeterministic — the dangerous false positive', () => {
  /**
   * The failure mode that damages trust most: a page for the SAME business name in
   * a DIFFERENT city. A salesperson calls a Chennai clinic about a Hyderabad
   * clinic's website and the whole list loses credibility.
   */
  it('rejects a same-name business in a different city', () => {
    const result = scoreDeterministic({
      business,
      page: page({
        title: 'Sri Krishna Dental Care | Dentist in Jubilee Hills, Hyderabad',
        // The description is part of the compared text too, so it must be
        // consistent with the scenario — a Hyderabad page does not mention Chennai.
        description: 'Family dental clinic in Jubilee Hills, Hyderabad.',
        content:
          'Sri Krishna Dental Care, Jubilee Hills, Hyderabad, Telangana. Call +91 40 2355 1234.',
        links: [],
      }),
    });

    expect(result.matched.phone).toBe(false);
    expect(result.score).toBeLessThan(ACCEPT_THRESHOLD);
    expect(result.evidence.some((entry) => entry.points < 0)).toBe(true);
  });

  it('rejects a completely unrelated business', () => {
    const result = scoreDeterministic({
      business,
      page: page({
        url: 'https://chennaisilks.com',
        finalUrl: 'https://chennaisilks.com/',
        title: 'Chennai Silks — Sarees and Textiles',
        content: 'Chennai Silks. Sarees, textiles, wedding collections. Phone +91 44 9999 0000.',
        links: [],
      }),
    });

    expect(result.score).toBeLessThan(REJECT_THRESHOLD + 20);
    expect(result.matched.phone).toBe(false);
    expect(result.matched.name).toBe(false);
  });

  /**
   * A directory page for the RIGHT business matches on name, city, phone, and
   * category — so it would score highly on every other signal. Disqualifying it
   * outright is the only correct handling, and it is also the opportunity.
   */
  it('disqualifies a directory page even when every other signal matches', () => {
    const result = scoreDeterministic({
      business,
      page: page({
        url: 'https://www.practo.com/chennai/clinic/sri-krishna-dental-care',
        finalUrl: 'https://www.practo.com/chennai/clinic/sri-krishna-dental-care',
      }),
    });

    expect(result.disqualified).toBe('THIRD_PARTY_LISTING');
    expect(result.score).toBe(0);
    expect(needsAiAdjudication(result)).toBe(false);
    expect(outcomeFromDeterministic(result).status).toBe('MISMATCH');
  });
});

describe('scoreDeterministic — inconclusive cases route to AI', () => {
  it('flags a name-and-city match with no phone as ambiguous', () => {
    const result = scoreDeterministic({
      business: { ...business, phoneDigits: null },
      page: page({
        content: 'Sri Krishna Dental Care, Chennai. Book your appointment today.',
        links: [],
      }),
    });

    expect(result.score).toBeGreaterThanOrEqual(REJECT_THRESHOLD);
    expect(result.score).toBeLessThan(ACCEPT_THRESHOLD);
    expect(needsAiAdjudication(result)).toBe(true);
    expect(result.unresolvedReason).not.toBe('');
  });

  it('returns UNKNOWN for an empty page rather than guessing a mismatch', () => {
    const result = scoreDeterministic({
      business,
      page: page({ content: '', title: null, description: null }),
    });

    expect(result.disqualified).toBe('EMPTY_PAGE');
    // An empty page proves nothing either way; calling it a mismatch would be a
    // fabricated conclusion.
    expect(outcomeFromDeterministic(result).status).toBe('UNKNOWN');
    expect(needsAiAdjudication(result)).toBe(false);
  });
});

describe('outcomeFromDeterministic', () => {
  it('never reports full certainty, because rules are evidence not proof', () => {
    const result = scoreDeterministic({ business, page: page() });
    const outcome = outcomeFromDeterministic(result);
    expect(outcome.confidence).toBeGreaterThan(0.7);
    expect(outcome.confidence).toBeLessThan(1);
    expect(outcome.usedAi).toBe(false);
  });
});

describe('mergeResults', () => {
  it('takes the better score rather than averaging away decisive evidence', () => {
    const homepage = scoreDeterministic({
      business,
      page: page({ content: 'Sri Krishna Dental Care. Welcome.', links: [] }),
    });
    const contact = scoreDeterministic({
      business,
      page: page({ content: 'Contact us on +91 44 2815 1234, Anna Nagar, Chennai.', links: [] }),
    });

    const merged = mergeResults(homepage, contact);

    expect(merged.score).toBe(Math.max(homepage.score, contact.score));
    // Matches are unioned: each page contributed something the other lacked.
    expect(merged.matched.phone).toBe(true);
    expect(merged.evidence.length).toBe(homepage.evidence.length + contact.evidence.length);
  });
});

describe('secondaryPagePaths', () => {
  it('prefers a contact page and returns at most one', () => {
    const found = secondaryPagePaths([
      'https://example.com/services',
      'https://example.com/contact',
      'https://example.com/about',
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('/contact');
  });

  it('returns nothing when no useful page exists', () => {
    expect(secondaryPagePaths(['https://example.com/blog/post-1'])).toEqual([]);
    expect(secondaryPagePaths([])).toEqual([]);
  });

  it('ignores unparseable links rather than throwing', () => {
    expect(() => secondaryPagePaths(['not a url', 'https://example.com/contact'])).not.toThrow();
  });
});

describe('assessWebsiteQuality', () => {
  it('identifies a parked domain', () => {
    const quality = assessWebsiteQuality(
      page({ content: 'Coming soon. This domain is for sale.', links: [] }),
    );
    expect(quality.isParked).toBe(true);
    expect(quality.isThin).toBe(true);
  });

  it('identifies a thin single-page site', () => {
    const quality = assessWebsiteQuality(page({ content: 'Welcome to our clinic.', links: [] }));
    expect(quality.isThin).toBe(true);
    expect(quality.isParked).toBe(false);
  });

  it('detects a booking funnel, which changes the recommended service', () => {
    const quality = assessWebsiteQuality(
      page({ content: `${'x'.repeat(1_000)} Book an appointment online today.` }),
    );
    expect(quality.hasBookingIndicator).toBe(true);
    expect(quality.isThin).toBe(false);
  });

  it('detects a contact page from the link set', () => {
    expect(assessWebsiteQuality(page()).hasContactPage).toBe(true);
    expect(assessWebsiteQuality(page({ links: [] })).hasContactPage).toBe(false);
  });

  it('flags free hosting', () => {
    const quality = assessWebsiteQuality(
      page({ url: 'https://clinic.wixsite.com/home', finalUrl: 'https://clinic.wixsite.com/home' }),
    );
    expect(quality.isFreeHosting).toBe(true);
  });
});
