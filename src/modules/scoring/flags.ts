/**
 * Opportunity flags.
 *
 * A score tells a salesperson *how good* a lead is. A flag tells them *what to
 * say*. `NO_HTTPS` on a jeweller's site is an opening line; "opportunity score
 * 82" is not.
 *
 * Flags are derived, never stored as an independent source of truth: they are
 * recomputed from the same signals that produce the score, so a flag can never
 * contradict the evidence panel beneath it. Every flag carries the sentence that
 * justifies it, drawn from measurements rather than adjectives.
 *
 * Deliberately excluded: any flag that would require a measurement we do not
 * have. There is no SLOW_WEBSITE, because load performance is not measured
 * (see website-analysis.ts) and a flag asserting slowness would be a guess
 * printed next to facts.
 */
import type { WebsiteObservations } from '@/modules/enrichment/website-analysis';

/**
 * The complete flag vocabulary.
 *
 * A closed union rather than free strings: flags drive UI filters and campaign
 * targeting, so a typo must be a compile error rather than a segment that
 * silently matches nothing.
 */
export type OpportunityFlag =
  | 'NO_WEBSITE'
  | 'DIRECTORY_LISTING_ONLY'
  | 'WEBSITE_BROKEN'
  | 'WEBSITE_PARKED'
  | 'OUTDATED_WEBSITE'
  | 'THIN_WEBSITE'
  | 'FREE_HOSTING'
  | 'NO_HTTPS'
  | 'MIXED_CONTENT'
  | 'POOR_MOBILE'
  | 'POOR_SEO'
  | 'MISSING_META_DESCRIPTION'
  | 'MISSING_H1'
  | 'MISSING_ALT_TEXT'
  | 'NO_STRUCTURED_DATA'
  | 'LOW_CONTENT_QUALITY'
  | 'NO_CONTACT_EMAIL'
  | 'NO_CONTACT_ROUTE'
  | 'NO_BOOKING_FUNNEL'
  | 'NO_SOCIAL_MEDIA'
  | 'LOW_REVIEW_COUNT'
  | 'DECLINING_RATING';

export interface FlagDetail {
  readonly flag: OpportunityFlag;
  readonly label: string;
  /** The measured fact behind the flag. Never an adjective on its own. */
  readonly rationale: string;
  /** Which service this flag most directly supports selling. */
  readonly severity: 'high' | 'medium' | 'low';
}

export const FLAG_LABELS: Record<OpportunityFlag, string> = {
  NO_WEBSITE: 'No website',
  DIRECTORY_LISTING_ONLY: 'Directory listing only',
  WEBSITE_BROKEN: 'Website broken',
  WEBSITE_PARKED: 'Website parked',
  OUTDATED_WEBSITE: 'Outdated website',
  THIN_WEBSITE: 'Single thin page',
  FREE_HOSTING: 'Free hosting',
  NO_HTTPS: 'No HTTPS',
  MIXED_CONTENT: 'Insecure resources',
  POOR_MOBILE: 'Poor mobile experience',
  POOR_SEO: 'Poor SEO',
  MISSING_META_DESCRIPTION: 'No meta description',
  MISSING_H1: 'No main heading',
  MISSING_ALT_TEXT: 'Missing image alt text',
  NO_STRUCTURED_DATA: 'No structured data',
  LOW_CONTENT_QUALITY: 'Low content volume',
  NO_CONTACT_EMAIL: 'No contact email found',
  NO_CONTACT_ROUTE: 'No contact route',
  NO_BOOKING_FUNNEL: 'No booking or enquiry',
  NO_SOCIAL_MEDIA: 'No social presence',
  LOW_REVIEW_COUNT: 'Few reviews',
  DECLINING_RATING: 'Below-average rating',
};

export interface FlagInput {
  readonly googleWebsiteStatus: string;
  readonly independentWebsiteStatus: string;
  readonly observations: WebsiteObservations | null;
  readonly seoScore: number | null;
  readonly mobileScore: number | null;
  readonly hasEmail: boolean;
  readonly socialPlatformCount: number;
  readonly rating: number | null;
  readonly reviewCount: number | null;
}

/** Reviews below which a business reads as too small or too new to have traction. */
const LOW_REVIEW_THRESHOLD = 10;
/** Rating below which the business has a visible reputation problem. */
const WEAK_RATING_THRESHOLD = 3.5;
/** Weighted SEO score (out of 25) below which the gap is worth naming. */
const POOR_SEO_THRESHOLD = 13;
/** Weighted mobile score (out of 20) below which the gap is worth naming. */
const POOR_MOBILE_THRESHOLD = 10;

/**
 * Derives the flags for one lead.
 *
 * Website-state flags are mutually exclusive by construction: a business either
 * has no site, or a directory listing, or a broken one, or a working one to
 * critique. Emitting NO_WEBSITE alongside POOR_SEO would be incoherent, and a
 * salesperson reading both would trust neither.
 */
export function deriveOpportunityFlags(input: FlagInput): FlagDetail[] {
  const flags: FlagDetail[] = [];

  const add = (
    flag: OpportunityFlag,
    rationale: string,
    severity: FlagDetail['severity'],
  ): void => {
    flags.push({ flag, label: FLAG_LABELS[flag], rationale, severity });
  };

  // --- website state: exactly one of these -----------------------------------
  const o = input.observations;

  if (input.independentWebsiteStatus === 'NO_INDEPENDENT_WEBSITE_FOUND') {
    if (input.googleWebsiteStatus === 'GOOGLE_WEBSITE_IS_THIRD_PARTY_LISTING') {
      add(
        'DIRECTORY_LISTING_ONLY',
        'The business is listed on a directory or social platform but has no website of its own. It already pays to be findable, which makes it a stronger prospect than one with no presence at all.',
        'high',
      );
    } else {
      add(
        'NO_WEBSITE',
        'No website could be found for this business through its listing or a public web search.',
        'high',
      );
    }
  } else if (input.independentWebsiteStatus === 'WEBSITE_BROKEN') {
    add(
      'WEBSITE_BROKEN',
      'The website listed for this business could not be loaded. It is losing every visitor who tries to reach it.',
      'high',
    );
  } else if (o?.isParked) {
    add(
      'WEBSITE_PARKED',
      'The domain resolves to a placeholder or "coming soon" page rather than a working site.',
      'high',
    );
  } else if (o) {
    // A working site: critique what was actually measured.
    if (o.isThin) {
      add(
        'THIN_WEBSITE',
        `The site has ${o.contentLength} characters of content and ${o.internalLinkCount} internal links — a single page rather than a website.`,
        'high',
      );
    }
    if (o.isFreeHosting) {
      add(
        'FREE_HOSTING',
        'The site runs on a free subdomain rather than the business’s own domain.',
        'medium',
      );
    }
    // "Outdated" is claimed only from converging structural evidence, never from
    // a visual impression we cannot form.
    if (!o.hasViewportMeta && !o.hasStructuredData && !o.htmlUnavailable) {
      add(
        'OUTDATED_WEBSITE',
        'The site has neither a mobile viewport tag nor structured data, both standard for over a decade — the markup predates current practice.',
        'medium',
      );
    }
  }

  // --- security --------------------------------------------------------------
  if (o && !o.httpsEnabled) {
    add(
      'NO_HTTPS',
      'The site is served over plain HTTP, so every visitor sees a "Not secure" warning in their browser.',
      'high',
    );
  }
  if (o && o.mixedContentCount > 0) {
    add(
      'MIXED_CONTENT',
      `${o.mixedContentCount} resource(s) load over insecure HTTP on an otherwise secure page.`,
      'medium',
    );
  }

  // --- SEO -------------------------------------------------------------------
  if (input.seoScore !== null && input.seoScore < POOR_SEO_THRESHOLD) {
    add('POOR_SEO', `Search-visibility basics score ${input.seoScore} out of 25.`, 'high');
  }
  if (o && !o.hasMetaDescription) {
    add(
      'MISSING_META_DESCRIPTION',
      'No meta description, so search engines write the snippet under the business’s own search result.',
      'medium',
    );
  }
  if (o && o.h1Count === 0) {
    add(
      'MISSING_H1',
      'The page has no H1 heading telling search engines what it is about.',
      'medium',
    );
  }
  if (o && !o.hasStructuredData && !o.htmlUnavailable) {
    add(
      'NO_STRUCTURED_DATA',
      'No Schema.org markup, so opening hours, address, and reviews cannot show directly in search results.',
      'low',
    );
  }
  if (o && o.imageCount > 0 && o.imagesWithAlt / o.imageCount < 0.5) {
    add(
      'MISSING_ALT_TEXT',
      `${o.imageCount - o.imagesWithAlt} of ${o.imageCount} images have no alt text, hurting accessibility and image search.`,
      'low',
    );
  }

  // --- mobile ---------------------------------------------------------------
  if (input.mobileScore !== null && input.mobileScore < POOR_MOBILE_THRESHOLD) {
    add(
      'POOR_MOBILE',
      o && !o.hasViewportMeta
        ? 'The site has no mobile viewport tag, so phones render a zoomed-out desktop layout — and most local searches happen on a phone.'
        : `Mobile readiness scores ${input.mobileScore} out of 20.`,
      'high',
    );
  }

  // --- content --------------------------------------------------------------
  if (o && !o.isThin && !o.isParked && o.contentLength < 1_500) {
    add(
      'LOW_CONTENT_QUALITY',
      `Only ${o.contentLength} characters of content, which gives search engines little to rank and visitors little to read.`,
      'medium',
    );
  }

  // --- reachability ---------------------------------------------------------
  if (!input.hasEmail) {
    add(
      'NO_CONTACT_EMAIL',
      'No email address is published on the business’s own pages, so it cannot be reached by email.',
      'medium',
    );
  }
  if (o && !o.hasContactPage) {
    add('NO_CONTACT_ROUTE', 'No contact page is linked from the site.', 'medium');
  }
  if (o && !o.hasBookingIndicator) {
    add(
      'NO_BOOKING_FUNNEL',
      'The site has no booking or enquiry call to action, so visits are not converted into customers.',
      'low',
    );
  }
  if (input.socialPlatformCount === 0) {
    add('NO_SOCIAL_MEDIA', 'No social media profiles were found for this business.', 'medium');
  }

  // --- commercial signals ---------------------------------------------------
  if (input.reviewCount !== null && input.reviewCount < LOW_REVIEW_THRESHOLD) {
    // A caution, not an opportunity: it is shown so a salesperson understands
    // why an otherwise needy lead is graded down.
    add(
      'LOW_REVIEW_COUNT',
      `Only ${input.reviewCount} reviews, which usually means limited customer volume and limited budget.`,
      'low',
    );
  }
  if (input.rating !== null && input.rating < WEAK_RATING_THRESHOLD) {
    add(
      'DECLINING_RATING',
      `A ${input.rating.toFixed(1)} rating is a visible reputation problem, and reputation work is sellable alongside web work.`,
      'low',
    );
  }

  return flags;
}

/** Flag identifiers only, for the denormalised column and filter queries. */
export function flagNames(details: readonly FlagDetail[]): OpportunityFlag[] {
  return details.map((detail) => detail.flag);
}

/** Highest-severity flags first, for a UI that shows only the top few. */
export function rankFlags(details: readonly FlagDetail[]): FlagDetail[] {
  const order = { high: 0, medium: 1, low: 2 } as const;
  return [...details].sort((a, b) => order[a.severity] - order[b.severity]);
}

/** Every flag value, for building filter UIs without duplicating the union. */
export const ALL_OPPORTUNITY_FLAGS = Object.keys(FLAG_LABELS) as OpportunityFlag[];
