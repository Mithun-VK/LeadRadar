/**
 * Mock fixtures.
 *
 * Realistic enough to exercise the whole pipeline, including the cases that
 * actually break it in production:
 *
 *   - a business whose Google "website" is really a Practo/Zomato listing
 *     (GOOGLE_WEBSITE_IS_THIRD_PARTY_LISTING), the most common trap in this
 *     product;
 *   - two businesses with near-identical names in different cities, to exercise
 *     name-collision handling;
 *   - a franchise location, which must be demoted rather than rewarded;
 *   - a permanently closed listing that filtering must drop;
 *   - a high-review / no-website business, the ideal lead;
 *   - a low-review / no-website business, which must NOT outrank it.
 *
 * Deterministic by construction: the same request always yields the same
 * results, so E2E assertions are stable and no test depends on the network.
 */
import type { BusinessStatus, GoogleWebsiteStatus, NormalizedBusiness } from '@/types/domain';

export interface MockCity {
  readonly name: string;
  readonly state: string;
  readonly bounds: { south: number; west: number; north: number; east: number };
}

/**
 * Cities are data, not code — the same registry shape the real geographic
 * planner uses, so nothing is hard-coded to Chennai.
 */
export const MOCK_CITIES: readonly MockCity[] = [
  { name: 'Chennai', state: 'Tamil Nadu', bounds: { south: 12.83, west: 80.05, north: 13.25, east: 80.34 } },
  { name: 'Bangalore', state: 'Karnataka', bounds: { south: 12.83, west: 77.46, north: 13.14, east: 77.78 } },
  { name: 'Mumbai', state: 'Maharashtra', bounds: { south: 18.89, west: 72.77, north: 19.27, east: 72.99 } },
  { name: 'Delhi', state: 'Delhi', bounds: { south: 28.4, west: 76.84, north: 28.88, east: 77.35 } },
  { name: 'Hyderabad', state: 'Telangana', bounds: { south: 17.2, west: 78.24, north: 17.61, east: 78.63 } },
];

interface FixtureSpec {
  readonly slug: string;
  readonly displayName: string;
  readonly category: string;
  readonly city: string;
  readonly rating: number | null;
  readonly reviewCount: number | null;
  readonly websiteUri: string | null;
  readonly phone: string | null;
  readonly status?: BusinessStatus;
  /** Marks a fixture as a chain outlet, so chain handling can be tested. */
  readonly isChain?: boolean;
  /** Notes why this fixture exists, surfaced in mock-mode debugging. */
  readonly scenario: string;
}

/**
 * URLs that look like a business website in the Places `websiteUri` field but
 * are really a directory or social listing. Classifying these correctly is the
 * difference between discarding a good lead and finding one.
 */
export const THIRD_PARTY_LISTING_HOSTS: readonly string[] = [
  'practo.com',
  'zomato.com',
  'swiggy.com',
  'justdial.com',
  'sulekha.com',
  'facebook.com',
  'instagram.com',
  'linktr.ee',
  'wa.me',
  'g.page',
  'business.site',
  'yelp.com',
  'tripadvisor.com',
  'urbanpro.com',
  'magicpin.in',
];

const SPECS: readonly FixtureSpec[] = [
  {
    slug: 'sri-krishna-dental-care',
    displayName: 'Sri Krishna Dental Care',
    category: 'dental clinic',
    city: 'Chennai',
    rating: 4.8,
    reviewCount: 1_240,
    websiteUri: null,
    phone: '+914428151234',
    scenario: 'Ideal lead: strong demand signal, no website at all.',
  },
  {
    slug: 'anna-nagar-smile-studio',
    displayName: 'Anna Nagar Smile Studio',
    category: 'dental clinic',
    city: 'Chennai',
    rating: 4.1,
    reviewCount: 8,
    websiteUri: null,
    phone: '+914426201234',
    scenario:
      'Weak lead: no website but almost no reviews. Must NOT outrank the ' +
      'high-review clinic — the additive-scoring failure this product avoids.',
  },
  {
    slug: 'adyar-dental-specialists',
    displayName: 'Adyar Dental Specialists',
    category: 'dental clinic',
    city: 'Chennai',
    rating: 4.6,
    reviewCount: 412,
    websiteUri: 'https://www.practo.com/chennai/clinic/adyar-dental-specialists',
    phone: '+914424411234',
    scenario:
      'Third-party listing masquerading as a website. Excellent web-development ' +
      'lead that a naive websiteUri check would discard.',
  },
  {
    slug: 'koramangala-dental-hub',
    displayName: 'Koramangala Dental Hub',
    category: 'dental clinic',
    city: 'Bangalore',
    rating: 4.7,
    reviewCount: 860,
    websiteUri: 'https://koramangaladentalhub.in',
    phone: '+918041234567',
    scenario: 'Has a real owned website; a redesign/SEO lead rather than a build lead.',
  },
  {
    slug: 'sri-krishna-dental-care-hyd',
    displayName: 'Sri Krishna Dental Care',
    category: 'dental clinic',
    city: 'Hyderabad',
    rating: 4.3,
    reviewCount: 95,
    websiteUri: null,
    phone: '+914023551234',
    scenario:
      'Name collision with the Chennai clinic. Website matching must not attach ' +
      'one clinic\'s site to the other.',
  },
  {
    slug: 'bandra-brew-cafe',
    displayName: 'Bandra Brew Cafe',
    category: 'cafe',
    city: 'Mumbai',
    rating: 4.5,
    reviewCount: 320,
    websiteUri: 'https://www.instagram.com/bandrabrewcafe',
    phone: '+912226401234',
    scenario: 'Active social presence, no website: social-first business, prime build lead.',
  },
  {
    slug: 'cafe-coffee-day-cp',
    displayName: 'Cafe Coffee Day - Connaught Place',
    category: 'cafe',
    city: 'Delhi',
    rating: 4.0,
    reviewCount: 2_150,
    websiteUri: 'https://www.cafecoffeeday.com',
    phone: '+911123411234',
    isChain: true,
    scenario:
      'Franchise outlet. Must be demoted, not rewarded: the decision is made at ' +
      'HQ, not at this location.',
  },
  {
    slug: 'defunct-dental-clinic',
    displayName: 'Old Town Dental Clinic',
    category: 'dental clinic',
    city: 'Delhi',
    rating: 3.9,
    reviewCount: 44,
    websiteUri: null,
    phone: null,
    status: 'CLOSED_PERMANENTLY',
    scenario: 'Permanently closed. Deterministic filtering must drop it before any spend.',
  },
  {
    slug: 'velachery-family-dental',
    displayName: 'Velachery Family Dental',
    category: 'dental clinic',
    city: 'Chennai',
    rating: 4.4,
    reviewCount: 156,
    websiteUri: null,
    phone: '+914422441234',
    scenario: 'Solid mid-tier lead; the volume case.',
  },
  {
    slug: 'jubilee-hills-dental-studio',
    displayName: 'Jubilee Hills Dental Studio',
    category: 'dental clinic',
    city: 'Hyderabad',
    rating: 4.9,
    reviewCount: 640,
    websiteUri: 'https://jubileehillsdentalstudio.example',
    phone: '+914023551299',
    scenario: 'Owned website that is thin/parked in the mock web provider — redesign lead.',
  },
];

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Classifies a website URL the way the real pipeline does. */
export function classifyWebsite(websiteUri: string | null): GoogleWebsiteStatus {
  if (!websiteUri) return 'GOOGLE_WEBSITE_NOT_LISTED';
  let host: string;
  try {
    host = new URL(websiteUri).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return 'GOOGLE_WEBSITE_NOT_LISTED';
  }
  const isListing = THIRD_PARTY_LISTING_HOSTS.some(
    (listing) => host === listing || host.endsWith(`.${listing}`),
  );
  return isListing ? 'GOOGLE_WEBSITE_IS_THIRD_PARTY_LISTING' : 'GOOGLE_WEBSITE_PRESENT';
}

/**
 * Deterministic pseudo-coordinates inside the city's bounds, derived from the
 * slug so a fixture always lands in the same place and geographic-cell tests
 * are reproducible.
 */
function coordinatesFor(slug: string, city: MockCity): { latitude: number; longitude: number } {
  let hash = 0;
  for (const char of slug) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const latSpan = city.bounds.north - city.bounds.south;
  const lngSpan = city.bounds.east - city.bounds.west;
  return {
    latitude: city.bounds.south + ((hash % 1000) / 1000) * latSpan,
    longitude: city.bounds.west + (((hash >> 10) % 1000) / 1000) * lngSpan,
  };
}

export interface MockBusiness extends NormalizedBusiness {
  readonly scenario: string;
  readonly isChain: boolean;
}

function build(spec: FixtureSpec): MockBusiness {
  const city = MOCK_CITIES.find((c) => c.name === spec.city);
  if (!city) throw new Error(`Mock fixture ${spec.slug} references unknown city ${spec.city}`);

  const coords = coordinatesFor(spec.slug, city);

  return {
    // Shaped like a real Place ID so nothing downstream can assume a format it
    // will not see in production.
    placeId: `ChIJmock${spec.slug.replace(/[^a-z0-9]/g, '').slice(0, 16).padEnd(16, '0')}`,
    normalizedName: normalizeName(spec.displayName),
    displayName: spec.displayName,
    primaryCategory: spec.category,
    categories: [spec.category],
    formattedAddress: `${spec.displayName}, ${city.name}, ${city.state}, India`,
    city: city.name,
    state: city.state,
    country: 'India',
    postalCode: null,
    location: coords,
    phone: spec.phone,
    rating: spec.rating,
    reviewCount: spec.reviewCount,
    businessStatus: spec.status ?? 'OPERATIONAL',
    googleMapsUri: `https://maps.google.com/?cid=mock-${spec.slug}`,
    websiteUri: spec.websiteUri,
    googleWebsiteStatus: classifyWebsite(spec.websiteUri),
    observedAt: new Date('2026-08-08T00:00:00.000Z'),
    scenario: spec.scenario,
    isChain: spec.isChain ?? false,
  };
}

export const MOCK_BUSINESSES: readonly MockBusiness[] = SPECS.map(build);

/** Filters fixtures the way a discovery provider would, for the mock adapter. */
export function findMockBusinesses(options: {
  readonly category?: string;
  readonly city?: string;
  readonly minRating?: number;
}): readonly MockBusiness[] {
  const category = options.category?.toLowerCase().trim();
  const city = options.city?.toLowerCase().trim();

  return MOCK_BUSINESSES.filter((business) => {
    if (category && !business.categories.some((c) => c.toLowerCase().includes(category))) {
      return false;
    }
    if (city && business.city?.toLowerCase() !== city) return false;
    if (options.minRating !== undefined && (business.rating ?? 0) < options.minRating) return false;
    return true;
  });
}
