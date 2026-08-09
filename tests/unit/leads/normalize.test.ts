import { describe, expect, it } from 'vitest';

import {
  addressOverlap,
  dedupeByPlaceId,
  detectChain,
  domainNameAffinity,
  extractPhoneDigits,
  extractPostalCode,
  findProbableDuplicates,
  haversineMetres,
  isFreeHosting,
  isThirdPartyListing,
  nameSimilarity,
  normalizeBusinessName,
  normalizeDomain,
  phoneDigits,
  toE164,
} from '@/modules/leads/normalize';

describe('normalizeBusinessName', () => {
  it('folds case, punctuation, and accents', () => {
    expect(normalizeBusinessName('Café Möbius, Pvt. Ltd.')).toBe('cafe mobius');
    expect(normalizeBusinessName("Dr. Sharma's Dental Clinic")).toBe('sharmas dental clinic');
  });

  it('expands ampersands so "Bar & Grill" and "Bar and Grill" agree', () => {
    expect(normalizeBusinessName('Bar & Grill')).toBe(normalizeBusinessName('Bar and Grill'));
  });

  it('drops legal-form noise that carries no identity', () => {
    expect(normalizeBusinessName('Acme Dental Private Limited')).toBe('acme dental');
    expect(normalizeBusinessName('Acme Dental LLP')).toBe('acme dental');
  });

  // A business genuinely named only from stopwords still needs an identity.
  it('never returns an empty string', () => {
    expect(normalizeBusinessName('The Company')).not.toBe('');
    expect(normalizeBusinessName('Dr.')).not.toBe('');
  });

  it('is stable — the same input always folds identically', () => {
    const input = 'Sri Krishna Dental Care';
    expect(normalizeBusinessName(input)).toBe(normalizeBusinessName(input));
  });
});

describe('nameSimilarity', () => {
  // Names differ by whole words, not characters, so a short name contained in a
  // longer one is a strong match rather than a half match.
  it('treats a contained name as a strong match', () => {
    expect(nameSimilarity('Sri Krishna Dental', 'Sri Krishna Dental Care')).toBe(1);
  });

  it('scores unrelated names near zero', () => {
    expect(nameSimilarity('Sri Krishna Dental', 'Chennai Silks Textiles')).toBeLessThan(0.2);
  });

  it('returns 0 when either name has no significant tokens', () => {
    expect(nameSimilarity('', 'Something')).toBe(0);
    expect(nameSimilarity('a b', 'Something')).toBe(0);
  });
});

describe('detectChain', () => {
  it('flags known chains', () => {
    for (const name of ['Cafe Coffee Day - CP', "Domino's Pizza Adyar", 'Clove Dental Velachery']) {
      expect(detectChain(name), name).toBe(true);
    }
  });

  it('flags branch and outlet markers', () => {
    expect(detectChain('Sunrise Dental - Branch 2')).toBe(true);
    expect(detectChain('Mega Store Outlet')).toBe(true);
  });

  it('does not flag independent businesses', () => {
    for (const name of ['Sri Krishna Dental Care', 'Bandra Brew Cafe', 'Anna Nagar Smile Studio']) {
      expect(detectChain(name), name).toBe(false);
    }
  });
});

describe('phoneDigits', () => {
  // Indian listings format numbers inconsistently; all of these are the same line.
  it('reduces equivalent formats to the same key', () => {
    const expected = '4428151234';
    for (const input of [
      '+91 44 2815 1234',
      '044-2815-1234',
      '(044) 28151234',
      '91 44 28151234',
      '04428151234',
    ]) {
      expect(phoneDigits(input), input).toBe(expected);
    }
  });

  it('rejects values too short to be a phone number', () => {
    expect(phoneDigits('12345')).toBeNull();
    expect(phoneDigits('')).toBeNull();
    expect(phoneDigits(null)).toBeNull();
    expect(phoneDigits(undefined)).toBeNull();
  });

  it('distinguishes genuinely different numbers', () => {
    expect(phoneDigits('+91 44 2815 1234')).not.toBe(phoneDigits('+91 44 2815 9999'));
  });
});

describe('extractPhoneDigits', () => {
  it('finds numbers in page text and deduplicates them', () => {
    const found = extractPhoneDigits(
      'Call +91 44 2815 1234 or 044-2815-1234 for appointments. Fax: 044 2815 9999.',
    );
    expect(found).toContain('4428151234');
    expect(found).toContain('4428159999');
    // The first two are the same number written differently.
    expect(found.filter((entry) => entry === '4428151234')).toHaveLength(1);
  });

  it('returns nothing for text with no numbers', () => {
    expect(extractPhoneDigits('Open Monday to Saturday')).toEqual([]);
  });
});

describe('toE164', () => {
  it('normalises Indian numbers', () => {
    expect(toE164('44 2815 1234')).toBe('+914428151234');
    expect(toE164('9876543210')).toBe('+919876543210');
    expect(toE164('09876543210')).toBe('+919876543210');
  });

  it('preserves an existing international prefix', () => {
    expect(toE164('+1 415 555 0100')).toBe('+14155550100');
  });

  it('returns null for empty input', () => {
    expect(toE164(null)).toBeNull();
    expect(toE164('')).toBeNull();
  });
});

describe('normalizeDomain', () => {
  it('canonicalises URLs and hostnames alike', () => {
    for (const input of [
      'https://www.Example.com/path?q=1',
      'http://example.com',
      'WWW.EXAMPLE.COM',
      'example.com.',
      'example.com:443',
      'example.com/contact',
    ]) {
      expect(normalizeDomain(input), input).toBe('example.com');
    }
  });

  it('keeps subdomains that are part of the identity', () => {
    expect(normalizeDomain('https://clinic.example.co.in')).toBe('clinic.example.co.in');
  });
});

describe('isThirdPartyListing', () => {
  /**
   * The most consequential check in the product: a Practo or Zomato URL in the
   * website field means the business owns no site, which is the opportunity — not a
   * reason to discard the lead.
   */
  it('recognises directory and social listings', () => {
    for (const url of [
      'https://www.practo.com/chennai/clinic/abc-dental',
      'https://www.zomato.com/mumbai/cafe',
      'https://www.justdial.com/Chennai/Dental',
      'https://www.instagram.com/somecafe',
      'https://www.facebook.com/somebusiness',
      'https://linktr.ee/somebusiness',
      'https://wa.me/919876543210',
      'https://mybusiness.business.site',
      'https://sites.google.com/view/clinic',
    ]) {
      expect(isThirdPartyListing(url), url).toBe(true);
    }
  });

  it('does not flag an owned domain', () => {
    for (const url of [
      'https://srikrishnadental.in',
      'https://koramangaladentalhub.in',
      'https://www.mycafe.co.in',
    ]) {
      expect(isThirdPartyListing(url), url).toBe(false);
    }
  });

  it('matches subdomains of a listed host', () => {
    expect(isThirdPartyListing('https://in.linkedin.com/company/acme')).toBe(true);
  });
});

describe('isFreeHosting', () => {
  it('recognises free subdomains, which are a redesign signal', () => {
    expect(isFreeHosting('https://mysite.wixsite.com/clinic')).toBe(true);
    expect(isFreeHosting('https://clinic.blogspot.com')).toBe(true);
  });

  it('does not flag an owned domain', () => {
    expect(isFreeHosting('https://srikrishnadental.in')).toBe(false);
  });
});

describe('domainNameAffinity', () => {
  it('scores a domain built from the business name highly', () => {
    expect(domainNameAffinity('Sri Krishna Dental Care', 'srikrishnadental.in')).toBeGreaterThan(0.6);
    expect(domainNameAffinity('Koramangala Dental Hub', 'koramangaladentalhub.in')).toBe(1);
  });

  it('scores an unrelated domain at zero', () => {
    expect(domainNameAffinity('Sri Krishna Dental Care', 'chennaisilks.com')).toBe(0);
  });

  it('ignores the TLD rather than crediting it', () => {
    // 'care' must not match because '.care' is a TLD.
    expect(domainNameAffinity('Dental Care', 'dental.care')).toBeLessThan(1);
  });
});

describe('addresses', () => {
  it('extracts an Indian PIN code', () => {
    expect(extractPostalCode('12 Anna Nagar, Chennai, Tamil Nadu 600040')).toBe('600040');
    expect(extractPostalCode('No PIN here')).toBeNull();
    // A PIN never starts with 0.
    expect(extractPostalCode('Address 012345')).toBeNull();
  });

  it('measures address token overlap', () => {
    const address = '12 Second Avenue, Anna Nagar, Chennai, Tamil Nadu';
    expect(addressOverlap(address, 'Visit us at Second Avenue, Anna Nagar, Chennai')).toBeGreaterThan(0.5);
    expect(addressOverlap(address, 'Completely unrelated content about textiles')).toBeLessThan(0.2);
    expect(addressOverlap(null, 'anything')).toBe(0);
  });
});

describe('dedupeByPlaceId', () => {
  // Overlapping geographic cells return the same business repeatedly, and this
  // must happen before any enrichment spend.
  it('keeps the first occurrence of each Place ID', () => {
    const input = [
      { placeId: 'a', name: 'first' },
      { placeId: 'b', name: 'second' },
      { placeId: 'a', name: 'duplicate' },
    ];
    const result = dedupeByPlaceId(input);
    expect(result).toHaveLength(2);
    expect(result[0]!.name).toBe('first');
  });

  it('handles an empty batch', () => {
    expect(dedupeByPlaceId([])).toEqual([]);
  });
});

describe('findProbableDuplicates', () => {
  const chennai = { latitude: 13.0827, longitude: 80.2707 };

  it('pairs same-name businesses that share a phone number', () => {
    const pairs = findProbableDuplicates([
      { placeId: 'a', normalizedName: 'sri krishna dental care', phoneDigits: '4428151234' },
      { placeId: 'b', normalizedName: 'sri krishna dental care', phoneDigits: '4428151234' },
    ]);
    expect(pairs).toHaveLength(1);
  });

  it('pairs same-name businesses at nearly the same coordinates', () => {
    const pairs = findProbableDuplicates([
      { placeId: 'a', normalizedName: 'acme dental', location: chennai },
      { placeId: 'b', normalizedName: 'acme dental', location: { latitude: 13.0828, longitude: 80.2708 } },
    ]);
    expect(pairs).toHaveLength(1);
  });

  /**
   * The critical negative case. "Sri Krishna Dental Care" exists independently in
   * Chennai and Hyderabad; merging them would corrupt both records, so name
   * similarity alone must never be enough.
   */
  it('does NOT pair same-name businesses in different cities', () => {
    const pairs = findProbableDuplicates([
      { placeId: 'a', normalizedName: 'sri krishna dental care', phoneDigits: '4428151234', location: chennai },
      {
        placeId: 'b',
        normalizedName: 'sri krishna dental care',
        phoneDigits: '4023551234',
        location: { latitude: 17.385, longitude: 78.4867 },
      },
    ]);
    expect(pairs).toHaveLength(0);
  });

  it('does not pair different businesses that happen to be neighbours', () => {
    const pairs = findProbableDuplicates([
      { placeId: 'a', normalizedName: 'acme dental', location: chennai },
      { placeId: 'b', normalizedName: 'chennai silks textiles', location: chennai },
    ]);
    expect(pairs).toHaveLength(0);
  });
});

describe('haversineMetres', () => {
  it('returns zero for the same point', () => {
    const point = { latitude: 13.0827, longitude: 80.2707 };
    expect(haversineMetres(point, point)).toBe(0);
  });

  it('measures Chennai to Hyderabad at roughly 520 km', () => {
    const distance = haversineMetres(
      { latitude: 13.0827, longitude: 80.2707 },
      { latitude: 17.385, longitude: 78.4867 },
    );
    expect(distance).toBeGreaterThan(500_000);
    expect(distance).toBeLessThan(540_000);
  });
});
