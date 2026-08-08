/**
 * Website verification.
 *
 * The most consequential logic in the product. Attaching the wrong website to a
 * business produces a lead that is confidently wrong — a salesperson calls a
 * dental clinic to discuss a site that belongs to a different clinic in a
 * different city, and the customer stops trusting every other row too. A missed
 * match costs one lead; a false match costs credibility.
 *
 * So the bar is deliberately asymmetric: strong positive evidence is required to
 * accept, while weak evidence yields PROBABLE_* or UNKNOWN rather than a guess.
 *
 * Deterministic scoring runs first and settles roughly four candidates in five at
 * zero marginal cost. Only genuinely ambiguous cases reach the AI — and even then
 * the AI adjudicates facts this module already extracted; it never supplies them.
 */
import {
  addressOverlap,
  domainNameAffinity,
  extractPhoneDigits,
  isFreeHosting,
  isThirdPartyListing,
  nameSimilarity,
  normalizeDomain,
} from '@/modules/leads/normalize';
import type { FetchedPage, VerificationEvidence, VerificationOutcome } from '@/modules/providers/contracts';
import type { NormalizedBusiness, WebsiteMatchStatus } from '@/types/domain';

/**
 * Signal weights, summing to 100.
 *
 * Phone dominates because it is the only near-unique identifier available: two
 * dental clinics can share a name and a city, but not a phone number. Name and
 * domain affinity are supporting evidence — they are exactly what a
 * plausible-looking wrong match also has.
 */
export const VERIFICATION_WEIGHTS = {
  phone: 45,
  name: 20,
  domain: 15,
  city: 10,
  address: 6,
  category: 4,
} as const;

/** Accept without AI. Requires phone plus corroboration in practice. */
export const ACCEPT_THRESHOLD = 70;
/** Below this, reject without AI — spending a call to confirm a clear no is waste. */
export const REJECT_THRESHOLD = 25;

export interface VerificationInput {
  readonly business: Pick<
    NormalizedBusiness,
    'displayName' | 'normalizedName' | 'city' | 'primaryCategory' | 'formattedAddress'
  > & { readonly phoneDigits: string | null };
  readonly page: FetchedPage;
}

export interface DeterministicResult {
  readonly score: number;
  readonly evidence: VerificationEvidence[];
  readonly matched: {
    name: boolean;
    phone: boolean;
    address: boolean;
    city: boolean;
    category: boolean;
    domain: boolean;
  };
  /** Set when the candidate is disqualified outright, regardless of score. */
  readonly disqualified?: 'THIRD_PARTY_LISTING' | 'EMPTY_PAGE';
  /** Populated when the result is inconclusive, for the AI prompt. */
  readonly unresolvedReason: string;
}

/**
 * Scores a candidate page against a business using rules only.
 *
 * Every signal contributes evidence with the span that produced it, so a verdict
 * can be explained in the UI without re-deriving it.
 */
export function scoreDeterministic(input: VerificationInput): DeterministicResult {
  const { business, page } = input;
  const evidence: VerificationEvidence[] = [];
  const matched = {
    name: false,
    phone: false,
    address: false,
    city: false,
    category: false,
    domain: false,
  };

  const domain = normalizeDomain(page.finalUrl || page.url);
  const haystack = `${page.title ?? ''} ${page.description ?? ''} ${page.content}`;
  const lower = haystack.toLowerCase();

  // A directory or social page can never be an owned website, however well it
  // matches. This check comes first because a Practo page for the right clinic
  // matches on every other signal and would otherwise score highly.
  if (isThirdPartyListing(domain)) {
    return {
      score: 0,
      evidence: [
        {
          field: 'domain',
          matched: false,
          points: 0,
          detail: `${domain} is a directory or social listing, not an owned website`,
        },
      ],
      matched,
      disqualified: 'THIRD_PARTY_LISTING',
      unresolvedReason: '',
    };
  }

  // An empty page proves nothing either way; it is not evidence of a mismatch.
  if (haystack.trim().length < 40) {
    return {
      score: 0,
      evidence: [
        { field: 'domain', matched: false, points: 0, detail: 'Page returned no usable content' },
      ],
      matched,
      disqualified: 'EMPTY_PAGE',
      unresolvedReason: 'Page had no content to compare',
    };
  }

  let score = 0;

  // --- phone -------------------------------------------------------------
  const pagePhones = extractPhoneDigits(haystack);
  if (business.phoneDigits && pagePhones.includes(business.phoneDigits)) {
    score += VERIFICATION_WEIGHTS.phone;
    matched.phone = true;
    evidence.push({
      field: 'phone',
      matched: true,
      points: VERIFICATION_WEIGHTS.phone,
      detail: `Page lists ${business.phoneDigits}`,
    });
  } else if (business.phoneDigits) {
    evidence.push({
      field: 'phone',
      matched: false,
      points: 0,
      detail:
        pagePhones.length > 0
          ? `Page lists different numbers (${pagePhones.slice(0, 3).join(', ')})`
          : 'Page lists no phone number',
    });
  }

  // --- name --------------------------------------------------------------
  const titleSimilarity = page.title ? nameSimilarity(business.displayName, page.title) : 0;
  const bodyHasName = lower.includes(business.normalizedName);
  const nameScore = Math.max(titleSimilarity, bodyHasName ? 0.9 : 0);

  if (nameScore >= 0.6) {
    const points = Math.round(VERIFICATION_WEIGHTS.name * nameScore);
    score += points;
    matched.name = true;
    evidence.push({
      field: 'name',
      matched: true,
      points,
      detail: page.title
        ? `Title "${page.title.slice(0, 90)}" matches (${nameScore.toFixed(2)})`
        : 'Business name appears in page text',
    });
  } else {
    evidence.push({
      field: 'name',
      matched: false,
      points: 0,
      detail: `Name similarity ${nameScore.toFixed(2)} is too low`,
    });
  }

  // --- domain ------------------------------------------------------------
  const affinity = domainNameAffinity(business.displayName, domain);
  if (affinity >= 0.5) {
    const points = Math.round(VERIFICATION_WEIGHTS.domain * affinity);
    score += points;
    matched.domain = true;
    evidence.push({
      field: 'domain',
      matched: true,
      points,
      detail: `Domain ${domain} reflects the business name (${affinity.toFixed(2)})`,
    });
  } else {
    evidence.push({
      field: 'domain',
      matched: false,
      points: 0,
      detail: `Domain ${domain} does not reflect the business name`,
    });
  }

  // --- city --------------------------------------------------------------
  if (business.city && lower.includes(business.city.toLowerCase())) {
    score += VERIFICATION_WEIGHTS.city;
    matched.city = true;
    evidence.push({
      field: 'city',
      matched: true,
      points: VERIFICATION_WEIGHTS.city,
      detail: `Page mentions ${business.city}`,
    });
  } else if (business.city) {
    evidence.push({
      field: 'city',
      matched: false,
      points: 0,
      detail: `Page does not mention ${business.city}`,
    });
  }

  // --- address -----------------------------------------------------------
  const overlap = addressOverlap(business.formattedAddress, haystack);
  if (overlap >= 0.4) {
    const points = Math.round(VERIFICATION_WEIGHTS.address * overlap);
    score += points;
    matched.address = true;
    evidence.push({
      field: 'address',
      matched: true,
      points,
      detail: `${Math.round(overlap * 100)}% of address tokens appear on the page`,
    });
  }

  // --- category ----------------------------------------------------------
  if (business.primaryCategory) {
    const words = business.primaryCategory.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    if (words.length > 0 && words.some((word) => lower.includes(word))) {
      score += VERIFICATION_WEIGHTS.category;
      matched.category = true;
      evidence.push({
        field: 'category',
        matched: true,
        points: VERIFICATION_WEIGHTS.category,
        detail: `Page mentions ${business.primaryCategory}`,
      });
    }
  }

  /**
   * Same-name-different-city guard.
   *
   * A page that clearly names a DIFFERENT city while matching on name is the
   * classic false positive — "Sri Krishna Dental Care" exists independently in
   * Chennai and Hyderabad. Name evidence alone must not carry such a candidate,
   * so its contribution is withdrawn.
   */
  if (matched.name && !matched.city && !matched.phone && business.city) {
    const otherCityMentioned = /\b(chennai|bangalore|bengaluru|mumbai|delhi|hyderabad|pune|kolkata|ahmedabad|jaipur|kochi|coimbatore)\b/i
      .exec(lower);
    if (otherCityMentioned && otherCityMentioned[1]!.toLowerCase() !== business.city.toLowerCase()) {
      const penalty = Math.round(VERIFICATION_WEIGHTS.name * 0.8);
      score -= penalty;
      evidence.push({
        field: 'city',
        matched: false,
        points: -penalty,
        detail: `Page appears to be for ${otherCityMentioned[1]}, not ${business.city}`,
      });
    }
  }

  const clamped = Math.max(0, Math.min(100, score));

  return {
    score: clamped,
    evidence,
    matched,
    unresolvedReason: describeAmbiguity(clamped, matched, business.phoneDigits !== null),
  };
}

function describeAmbiguity(
  score: number,
  matched: DeterministicResult['matched'],
  hadPhone: boolean,
): string {
  if (score >= ACCEPT_THRESHOLD || score < REJECT_THRESHOLD) return '';
  if (!hadPhone) return 'No phone number on record, so the strongest signal was unavailable';
  if (!matched.phone && matched.name) return 'Name matches but the phone number does not';
  if (matched.name && !matched.city) return 'Name matches but locality could not be confirmed';
  return 'Signals are mixed and no single strong identifier matched';
}

/** Maps a deterministic score to a verdict, when no AI is involved. */
export function statusFromScore(score: number): WebsiteMatchStatus {
  if (score >= ACCEPT_THRESHOLD) return 'MATCH';
  if (score >= 55) return 'PROBABLE_MATCH';
  if (score >= REJECT_THRESHOLD) return 'PROBABLE_MISMATCH';
  return 'MISMATCH';
}

/** Whether the AI should adjudicate. */
export function needsAiAdjudication(result: DeterministicResult): boolean {
  if (result.disqualified) return false;
  return result.score >= REJECT_THRESHOLD && result.score < ACCEPT_THRESHOLD;
}

/**
 * Converts a deterministic result into a final outcome without AI.
 *
 * Confidence is derived from distance past the threshold rather than being set to
 * 1.0: even a strong rule match is evidence, not proof, and the UI should say so.
 */
export function outcomeFromDeterministic(result: DeterministicResult): VerificationOutcome {
  if (result.disqualified === 'THIRD_PARTY_LISTING') {
    return {
      status: 'MISMATCH',
      confidence: 0.95,
      deterministicScore: 0,
      evidence: result.evidence,
      usedAi: false,
    };
  }
  if (result.disqualified === 'EMPTY_PAGE') {
    return {
      status: 'UNKNOWN',
      confidence: 0.2,
      deterministicScore: 0,
      evidence: result.evidence,
      usedAi: false,
    };
  }

  const status = statusFromScore(result.score);
  const confidence =
    status === 'MATCH'
      ? Math.min(0.98, 0.75 + (result.score - ACCEPT_THRESHOLD) / 120)
      : status === 'MISMATCH'
        ? Math.min(0.95, 0.7 + (REJECT_THRESHOLD - result.score) / 100)
        : 0.6;

  return {
    status,
    confidence: Number(confidence.toFixed(2)),
    deterministicScore: result.score,
    evidence: result.evidence,
    usedAi: false,
  };
}

/**
 * Pages worth fetching beyond the homepage, in priority order.
 *
 * Capped hard at one extra page. Contact and about pages carry the phone number
 * that settles most ambiguity; a third page almost never changes the verdict and
 * costs another credit on every ambiguous candidate in the job.
 */
export function secondaryPagePaths(links: readonly string[]): string[] {
  const preferred = ['/contact', '/contact-us', '/about', '/about-us', '/pages/contact', '/pages/about'];
  const found: string[] = [];

  for (const link of links) {
    let path: string;
    try {
      path = new URL(link).pathname.toLowerCase().replace(/\/+$/, '');
    } catch {
      continue;
    }
    if (preferred.includes(path) && !found.includes(link)) found.push(link);
    if (found.length >= 1) break;
  }

  return found;
}

/**
 * Merges homepage and secondary-page evidence.
 *
 * Takes the better score rather than averaging: a contact page confirming the
 * phone number is decisive, and averaging it against a marketing homepage that
 * happened to omit the number would discard the very evidence we paid for.
 */
export function mergeResults(
  primary: DeterministicResult,
  secondary: DeterministicResult,
): DeterministicResult {
  const better = secondary.score > primary.score ? secondary : primary;
  return {
    ...better,
    evidence: [...primary.evidence, ...secondary.evidence],
    matched: {
      name: primary.matched.name || secondary.matched.name,
      phone: primary.matched.phone || secondary.matched.phone,
      address: primary.matched.address || secondary.matched.address,
      city: primary.matched.city || secondary.matched.city,
      category: primary.matched.category || secondary.matched.category,
      domain: primary.matched.domain || secondary.matched.domain,
    },
  };
}

/** Signals about the site itself, for digital-presence scoring. */
export interface WebsiteQualitySignals {
  readonly httpsEnabled: boolean;
  readonly isFreeHosting: boolean;
  readonly hasContactPage: boolean;
  readonly hasBookingIndicator: boolean;
  readonly contentLength: number;
  readonly isThin: boolean;
  readonly isParked: boolean;
  readonly linkCount: number;
}

const BOOKING_PATTERNS = /\b(book (?:an )?appointment|book now|schedule (?:a )?visit|online booking|reserve a table|request a quote)\b/i;
const PARKED_PATTERNS = /\b(coming soon|under construction|domain (?:is )?for sale|this domain|buy this domain|parked|default web page|website is being built)\b/i;

/**
 * Derives quality signals from a fetched page.
 *
 * A live URL is not a working web presence. A parked or one-page site is a
 * REDESIGN lead, and identifying it correctly is what lets LeadRadar sell to
 * businesses that a naive "has website" filter would discard.
 */
export function assessWebsiteQuality(page: FetchedPage): WebsiteQualitySignals {
  const content = page.content;
  const links = page.links;

  return {
    httpsEnabled: page.httpsEnabled,
    isFreeHosting: isFreeHosting(page.finalUrl || page.url),
    hasContactPage: links.some((link) => /\/(contact|contact-us|reach-us)/i.test(link)),
    hasBookingIndicator: BOOKING_PATTERNS.test(content),
    contentLength: content.length,
    // Under ~600 characters of main content is a placeholder, not a website.
    isThin: content.trim().length < 600,
    isParked: PARKED_PATTERNS.test(content) && content.trim().length < 1_500,
    linkCount: links.length,
  };
}
