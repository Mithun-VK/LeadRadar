/**
 * Translates Google Places responses into the provider-neutral domain model.
 *
 * This is the boundary: nothing downstream of here knows Google exists. That is
 * what allows an Overture/OSM adapter to replace this one if the Places terms
 * turn out to be untenable for lead generation.
 *
 * All Google-shaped quirks are absorbed here — localised name objects, address
 * components rather than parsed fields, `BUSINESS_STATUS` string enums, and the
 * fact that a missing `websiteUri` is meaningful data rather than an omission.
 */
import {
  detectChain,
  extractPostalCode,
  isThirdPartyListing,
  normalizeBusinessName,
  phoneDigits,
  toE164,
} from '@/modules/leads/normalize';
import type { BusinessStatus, GoogleWebsiteStatus, NormalizedBusiness } from '@/types/domain';

import type { GooglePlace } from './schemas';

/** Address component types, in the order we prefer them for each field. */
const CITY_TYPES = ['locality', 'postal_town', 'administrative_area_level_3', 'sublocality_level_1'];
const STATE_TYPES = ['administrative_area_level_1'];
const COUNTRY_TYPES = ['country'];
const POSTAL_TYPES = ['postal_code'];

function component(
  place: GooglePlace,
  wanted: readonly string[],
  prefer: 'longText' | 'shortText' = 'longText',
): string | null {
  const components = place.addressComponents ?? [];
  for (const type of wanted) {
    const match = components.find((c) => c.types.includes(type));
    if (match) return match[prefer] ?? match.longText ?? match.shortText ?? null;
  }
  return null;
}

function mapBusinessStatus(raw: string | undefined): BusinessStatus {
  switch (raw) {
    case 'OPERATIONAL':
      return 'OPERATIONAL';
    case 'CLOSED_TEMPORARILY':
      return 'CLOSED_TEMPORARILY';
    case 'CLOSED_PERMANENTLY':
      return 'CLOSED_PERMANENTLY';
    default:
      // An unrecognised or absent status is UNKNOWN, never assumed OPERATIONAL:
      // spending enrichment budget on a closed business is pure waste.
      return 'UNKNOWN';
  }
}

/**
 * Classifies the website field.
 *
 * The three-way split is the product's core data-quality insight. A `websiteUri`
 * pointing at Practo, Zomato, Justdial, Instagram, or a Linktree means the
 * business has no site of its own — an excellent web-development lead that a
 * naive null check would discard.
 */
export function classifyGoogleWebsite(websiteUri: string | undefined): GoogleWebsiteStatus {
  if (!websiteUri || websiteUri.trim() === '') return 'GOOGLE_WEBSITE_NOT_LISTED';
  return isThirdPartyListing(websiteUri)
    ? 'GOOGLE_WEBSITE_IS_THIRD_PARTY_LISTING'
    : 'GOOGLE_WEBSITE_PRESENT';
}

/**
 * Human-readable category from Google's type taxonomy.
 *
 * `primaryType` is snake_case ('dental_clinic'); the display form is what the
 * UI and export show, so it is derived once here.
 */
function categoryLabel(raw: string | undefined): string | null {
  if (!raw) return null;
  return raw.replace(/_/g, ' ').trim() || null;
}

/**
 * Google's `types` include structural entries ('point_of_interest',
 * 'establishment') that carry no business meaning and would pollute category
 * filters.
 */
const NOISE_TYPES = new Set(['point_of_interest', 'establishment', 'food', 'store', 'health']);

export interface NormalizeOptions {
  /** Fallback city when address components are absent, e.g. the searched city. */
  readonly fallbackCity?: string | null;
  /** Timestamp for the snapshot; injectable so tests are deterministic. */
  readonly observedAt?: Date;
}

/** Normalizes one place. Returns null when the response lacks a usable identity. */
export function normalizePlace(
  place: GooglePlace,
  options: NormalizeOptions = {},
): NormalizedBusiness | null {
  const displayName = place.displayName?.text?.trim() ?? '';
  // Without a name there is nothing to verify a website against and nothing to
  // show a salesperson, so the row is worthless rather than partially useful.
  if (place.id.trim() === '' || displayName === '') return null;

  const formattedAddress = place.formattedAddress?.trim() ?? null;
  const city = component(place, CITY_TYPES) ?? options.fallbackCity ?? null;
  const phone = toE164(place.nationalPhoneNumber ?? place.internationalPhoneNumber ?? null);

  const categories = (place.types ?? [])
    .filter((type) => !NOISE_TYPES.has(type))
    .map((type) => type.replace(/_/g, ' '));

  return {
    placeId: place.id,
    normalizedName: normalizeBusinessName(displayName),
    displayName,
    primaryCategory: categoryLabel(place.primaryType) ?? categories[0] ?? null,
    categories,
    formattedAddress,
    city,
    state: component(place, STATE_TYPES),
    country: component(place, COUNTRY_TYPES),
    postalCode: component(place, POSTAL_TYPES, 'shortText') ?? extractPostalCode(formattedAddress),
    location: place.location ?? null,
    phone,
    // Absent rather than zero: 'no rating yet' and 'rated 0' are different facts,
    // and conflating them would let unrated businesses fail a rating filter for
    // the wrong reason.
    rating: place.rating ?? null,
    reviewCount: place.userRatingCount ?? null,
    businessStatus: mapBusinessStatus(place.businessStatus),
    googleMapsUri: place.googleMapsUri ?? null,
    websiteUri: place.websiteUri ?? null,
    googleWebsiteStatus: classifyGoogleWebsite(place.websiteUri),
    observedAt: options.observedAt ?? new Date(),
  };
}

/** Normalizes a page, dropping unusable entries rather than failing the batch. */
export function normalizePlaces(
  places: readonly GooglePlace[],
  options: NormalizeOptions = {},
): { businesses: NormalizedBusiness[]; skipped: number } {
  const businesses: NormalizedBusiness[] = [];
  let skipped = 0;

  for (const place of places) {
    const normalized = normalizePlace(place, options);
    if (normalized) businesses.push(normalized);
    else skipped += 1;
  }

  return { businesses, skipped };
}

/** Convenience for callers needing the phone comparison key. */
export function businessPhoneDigits(business: NormalizedBusiness): string | null {
  return phoneDigits(business.phone);
}

/** Convenience for chain detection at the normalization boundary. */
export function businessIsChain(business: NormalizedBusiness): boolean {
  return detectChain(business.displayName);
}
