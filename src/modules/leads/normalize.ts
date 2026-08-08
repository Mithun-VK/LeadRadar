/**
 * Deterministic normalization.
 *
 * Everything here is pure, rule-based, and cheap. None of it may ever be
 * delegated to the AI layer: phone parsing, domain canonicalisation, name
 * folding, and duplicate detection have exact answers, and an LLM would make
 * them slower, costlier, non-reproducible, and occasionally wrong.
 *
 * These functions are also the foundation of website verification, so their
 * correctness directly determines whether a lead gets attached to the wrong
 * business — the failure mode that most damages trust in the product.
 */

/** Legal-form and honorific noise that carries no identifying information. */
const NAME_STOPWORDS = new Set([
  'pvt',
  'private',
  'ltd',
  'limited',
  'llp',
  'inc',
  'incorporated',
  'co',
  'company',
  'the',
  'and',
  'dr',
  'doctor',
  'mr',
  'mrs',
  'ms',
]);

/**
 * Chain and franchise markers. Chain membership is a NEGATIVE signal: the
 * purchasing decision for a franchise outlet is made at head office, so the
 * outlet is not a sellable lead however weak its digital presence looks.
 */
const CHAIN_MARKERS: readonly string[] = [
  'apollo',
  'starbucks',
  'cafe coffee day',
  'ccd',
  'dominos',
  "domino's",
  'pizza hut',
  'mcdonald',
  'kfc',
  'subway',
  'barista',
  'chai point',
  'third wave coffee',
  'blue tokai',
  'clove dental',
  'sabka dentist',
  'axiss dental',
  'fms dental',
  'partha dental',
  'vasan',
  'dr agarwal',
  'naturals',
  'lakme',
  'vlcc',
  'cult fit',
  'anytime fitness',
  'gold gym',
  "gold's gym",
  'reliance',
  'more supermarket',
];

/** Suffixes indicating a branch/outlet rather than an independent business. */
const BRANCH_MARKERS = /\b(branch|outlet|franchise|unit\s*\d+|store\s*\d+)\b/i;

/**
 * Folds a business name to a comparable form: lowercase, accent-stripped,
 * punctuation removed, legal-form words dropped, whitespace collapsed.
 *
 * Used for dedupe and for name matching during verification, so it must be
 * stable — changing it invalidates stored `normalizedName` values.
 */
export function normalizeBusinessName(raw: string): string {
  const folded = raw
    .normalize('NFKD')
    // Strip combining marks so 'Café' and 'Cafe' compare equal.
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const tokens = folded.split(' ').filter((token) => token !== '' && !NAME_STOPWORDS.has(token));

  // If stopword removal emptied the name, keep the folded form rather than
  // returning nothing — a business genuinely called "The Company" still needs
  // an identity.
  return tokens.length > 0 ? tokens.join(' ') : folded;
}

/** Significant tokens of a name, for overlap scoring. */
export function nameTokens(raw: string): string[] {
  return normalizeBusinessName(raw)
    .split(' ')
    .filter((token) => token.length >= 3);
}

/**
 * Jaccard-style token overlap between two names, 0-1.
 *
 * Chosen over edit distance because business names differ by whole words
 * ("Sri Krishna Dental" vs "Sri Krishna Dental Care"), not by characters, and
 * edit distance punishes the longer, more informative name.
 */
export function nameSimilarity(a: string, b: string): number {
  const left = new Set(nameTokens(a));
  const right = new Set(nameTokens(b));
  if (left.size === 0 || right.size === 0) return 0;

  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;

  // Normalise by the smaller set: a short name fully contained in a longer one
  // is a strong match, not a half match.
  return shared / Math.min(left.size, right.size);
}

/** Detects chain/franchise membership from the name. */
export function detectChain(displayName: string): boolean {
  const normalized = normalizeBusinessName(displayName);
  if (CHAIN_MARKERS.some((marker) => normalized.includes(normalizeBusinessName(marker)))) {
    return true;
  }
  return BRANCH_MARKERS.test(displayName);
}

// ---------------------------------------------------------------------------
// Phone numbers
// ---------------------------------------------------------------------------

/**
 * Reduces a phone number to comparable digits.
 *
 * Deliberately not a full libphonenumber dependency: verification only needs a
 * stable comparison key, and the subscriber-number tail is both sufficient and
 * robust to inconsistent country-code and STD-code formatting, which is
 * pervasive in Indian business listings.
 *
 * Returns the last 10 digits, which is the full national number in India and a
 * safe comparison suffix elsewhere.
 */
export function phoneDigits(raw: string | null | undefined): string | null {
  if (!raw) return null;

  const digits = raw.replace(/\D/g, '');
  if (digits.length < 7) return null;

  // Drop a leading trunk zero before taking the tail, so '044 2815 1234' and
  // '+91 44 2815 1234' agree.
  const tail = digits.slice(-10);
  return tail.length >= 7 ? tail : null;
}

/** Extracts every plausible phone number from free text, as comparison keys. */
export function extractPhoneDigits(text: string): string[] {
  const found = new Set<string>();

  // Sequences of digits and separators long enough to be a phone number.
  for (const match of text.matchAll(/(?:\+?\d[\d\s().-]{6,18}\d)/g)) {
    const key = phoneDigits(match[0]);
    if (key) found.add(key);
  }

  return [...found];
}

/** Formats an Indian number as E.164 where recognisable, else returns input. */
export function toE164(raw: string | null | undefined, defaultCountry = '91'): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 0) return null;

  if (raw.trim().startsWith('+')) return `+${digits}`;
  if (digits.length === 10) return `+${defaultCountry}${digits}`;
  if (digits.length === 11 && digits.startsWith('0')) return `+${defaultCountry}${digits.slice(1)}`;
  if (digits.length === 12 && digits.startsWith(defaultCountry)) return `+${digits}`;
  return `+${digits}`;
}

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

/**
 * Hosts that appear in a business's "website" field but are directories, social
 * profiles, or link aggregators rather than an owned site.
 *
 * This list is the difference between discarding a good lead and finding one: a
 * business whose only web presence is a Practo or Zomato page has no website of
 * its own, which is precisely the opportunity.
 */
export const THIRD_PARTY_LISTING_HOSTS: readonly string[] = [
  'practo.com',
  'lybrate.com',
  'zomato.com',
  'swiggy.com',
  'dineout.co.in',
  'justdial.com',
  'sulekha.com',
  'indiamart.com',
  'urbanpro.com',
  'magicpin.in',
  'nearbuy.com',
  'yelp.com',
  'tripadvisor.com',
  'tripadvisor.in',
  'facebook.com',
  'fb.com',
  'instagram.com',
  'linkedin.com',
  'x.com',
  'twitter.com',
  'youtube.com',
  'pinterest.com',
  'linktr.ee',
  'bio.link',
  'wa.me',
  'api.whatsapp.com',
  'g.page',
  'business.site',
  'sites.google.com',
  'wixsite.com',
  'blogspot.com',
  'wordpress.com',
  'medium.com',
  'google.com',
  'maps.google.com',
  'books.apple.com',
  'zocdoc.com',
  'bookmyshow.com',
  'urbanclap.com',
  'urbancompany.com',
];

/** Free-hosting suffixes: a site here is not a professional web presence. */
const FREE_HOSTING_SUFFIXES: readonly string[] = [
  '.wixsite.com',
  '.blogspot.com',
  '.wordpress.com',
  '.weebly.com',
  '.godaddysites.com',
  '.business.site',
  '.square.site',
  '.mystrikingly.com',
  '.webnode.com',
  '.jimdosite.com',
];

/**
 * Canonical domain for comparison and caching: lowercase, no scheme, no `www.`,
 * no trailing dot, no port.
 *
 * Not a security function — see the URL guard for that.
 */
export function normalizeDomain(hostnameOrUrl: string): string {
  let host = hostnameOrUrl.trim().toLowerCase();

  if (host.includes('://')) {
    try {
      host = new URL(host).hostname;
    } catch {
      // Fall through: treat as a bare hostname.
    }
  } else if (host.includes('/')) {
    host = host.split('/')[0]!;
  }

  host = host.replace(/^\[|\]$/g, '');
  if (host.includes(':') && !host.includes('::')) host = host.split(':')[0]!;
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host.startsWith('www.')) host = host.slice(4);

  return host;
}

function hostMatches(host: string, listed: string): boolean {
  return host === listed || host.endsWith(`.${listed}`);
}

/** True when a URL points at a directory, social profile, or link aggregator. */
export function isThirdPartyListing(urlOrDomain: string): boolean {
  const host = normalizeDomain(urlOrDomain);
  if (host === '') return false;
  return THIRD_PARTY_LISTING_HOSTS.some((listed) => hostMatches(host, listed));
}

/** True when a domain is on free hosting rather than an owned domain. */
export function isFreeHosting(urlOrDomain: string): boolean {
  const host = normalizeDomain(urlOrDomain);
  return FREE_HOSTING_SUFFIXES.some((suffix) => host.endsWith(suffix.slice(1)) || host.endsWith(suffix));
}

/**
 * Overlap between a business name and a domain's label, 0-1.
 *
 * Domains drop spaces ('srikrishnadental.in'), so token-set comparison fails
 * and containment is the right test: a domain label containing most of the
 * name's significant tokens is strong evidence of ownership.
 */
export function domainNameAffinity(businessName: string, urlOrDomain: string): number {
  const host = normalizeDomain(urlOrDomain);
  if (host === '') return 0;

  // Compare against the registrable label, not the TLD.
  const label = host.split('.')[0]!.replace(/[^a-z0-9]/g, '');
  if (label === '') return 0;

  const tokens = nameTokens(businessName);
  if (tokens.length === 0) return 0;

  const present = tokens.filter((token) => label.includes(token.replace(/[^a-z0-9]/g, '')));
  return present.length / tokens.length;
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/** Comparable address tokens: lowercase words of 3+ characters, deduplicated. */
export function addressTokens(address: string | null | undefined): string[] {
  if (!address) return [];
  const tokens = address
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 3);
  return [...new Set(tokens)];
}

/** Indian PIN code, when present. A strong, cheap locality signal. */
export function extractPostalCode(address: string | null | undefined): string | null {
  if (!address) return null;
  const match = /\b([1-9]\d{5})\b/.exec(address);
  return match ? match[1]! : null;
}

/** Share of a business's address tokens appearing in page text, 0-1. */
export function addressOverlap(businessAddress: string | null, pageText: string): number {
  const tokens = addressTokens(businessAddress);
  if (tokens.length === 0) return 0;

  const haystack = pageText.toLowerCase();
  const present = tokens.filter((token) => haystack.includes(token));
  return present.length / tokens.length;
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

/**
 * Deduplicates by Place ID.
 *
 * Place ID is authoritative and exact, so this is the only dedupe the discovery
 * stage needs — and it must happen before any enrichment spend, because
 * overlapping geographic cells routinely return the same business several times.
 */
export function dedupeByPlaceId<T extends { placeId: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item.placeId)) continue;
    seen.add(item.placeId);
    out.push(item);
  }
  return out;
}

/**
 * Flags probable duplicates that survive Place ID dedupe: the same business
 * listed twice by Google with different IDs.
 *
 * Requires BOTH a near-identical name AND either a shared phone or very close
 * coordinates. Name alone is not enough — "Sri Krishna Dental Care" exists
 * independently in Chennai and Hyderabad, and merging them would corrupt both.
 */
export function findProbableDuplicates<
  T extends {
    placeId: string;
    normalizedName: string;
    phoneDigits?: string | null;
    location?: { latitude: number; longitude: number } | null;
  },
>(items: readonly T[], options: { nameThreshold?: number; metresThreshold?: number } = {}): Array<[T, T]> {
  const nameThreshold = options.nameThreshold ?? 0.85;
  const metresThreshold = options.metresThreshold ?? 120;
  const pairs: Array<[T, T]> = [];

  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const a = items[i]!;
      const b = items[j]!;

      if (nameSimilarity(a.normalizedName, b.normalizedName) < nameThreshold) continue;

      const samePhone =
        a.phoneDigits != null && b.phoneDigits != null && a.phoneDigits === b.phoneDigits;

      const closeBy =
        a.location != null &&
        b.location != null &&
        haversineMetres(a.location, b.location) <= metresThreshold;

      if (samePhone || closeBy) pairs.push([a, b]);
    }
  }

  return pairs;
}

/** Great-circle distance in metres. */
export function haversineMetres(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const R = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;

  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
