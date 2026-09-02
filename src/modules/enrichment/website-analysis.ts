/**
 * Website analysis.
 *
 * Produces the evidence behind a sales conversation: not "your website is bad",
 * but "your site has no meta description, no mobile viewport tag, and 14 of 17
 * images have no alt text". Every number here is a count of something actually
 * present in, or absent from, the document we fetched.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO PERFORMANCE SCORE
 * ---------------------------------------------------------------------------
 *
 * A single server-side page fetch cannot measure load performance. It cannot
 * measure Core Web Vitals, time to interactive, render-blocking cost, or what a
 * phone on a 4G connection in Chennai experiences. It sees one HTML document,
 * fetched once, from a datacentre.
 *
 * The tempting move is to synthesise a plausible number from document size and
 * script count and label it "Performance: 62". That number would be fiction, and
 * a salesperson would repeat it to a prospect who may well have real analytics
 * open in another tab. One fabricated metric discredits every honest one beside
 * it — including the alt-text count that was true.
 *
 * So `performanceScore` is null, `performanceNote` explains why, and the UI shows
 * "not measured". Page weight and resource counts ARE reported, as the raw
 * observations they are. If real measurement is wanted later, it needs a real
 * measurement source (Lighthouse or CrUX), executed explicitly and stored as its
 * own provenance — see docs/LEAD_SCORING.md.
 *
 * The scored categories below total 100 without it.
 */
import { parse, type HTMLElement } from 'node-html-parser';

import { isFreeHosting, normalizeDomain } from '@/modules/leads/normalize';
import type { FetchedPage } from '@/modules/providers/contracts';

/** Bump when checks or weights change; stored so results recompute without refetching. */
export const ANALYZER_VERSION = '1.0.0';

/**
 * Category weights, summing to 100.
 *
 * Weighted by what an agency can actually sell against, not by engineering
 * purity. SEO and content lead because they are the visible, explicable gaps that
 * open a conversation; security is narrow but decisive (no HTTPS is an immediate,
 * demonstrable problem); mobile matters enormously for local search but only a
 * few facts about it are honestly observable from markup.
 */
export const CATEGORY_WEIGHTS = {
  seo: 25,
  content: 25,
  mobile: 20,
  trust: 15,
  security: 15,
} as const;

export type CheckCategory = keyof typeof CATEGORY_WEIGHTS;

/** One check's outcome, with the reasoning the UI renders verbatim. */
export interface AnalysisFinding {
  readonly id: string;
  readonly category: CheckCategory;
  readonly label: string;
  readonly points: number;
  readonly maxPoints: number;
  /** Why these points were awarded, phrased for a non-technical reader. */
  readonly rationale: string;
}

export interface WebsiteObservations {
  readonly httpsEnabled: boolean;
  readonly hasViewportMeta: boolean;
  readonly hasTitle: boolean;
  readonly titleLength: number | null;
  readonly hasMetaDescription: boolean;
  readonly metaDescriptionLength: number | null;
  readonly h1Count: number;
  readonly imageCount: number;
  readonly imagesWithAlt: number;
  readonly hasStructuredData: boolean;
  readonly hasCanonical: boolean;
  readonly hasContactPage: boolean;
  readonly hasBookingIndicator: boolean;
  readonly hasResponsiveHints: boolean;
  readonly internalLinkCount: number;
  readonly externalLinkCount: number;
  readonly contentLength: number;
  readonly mixedContentCount: number;
  readonly isThin: boolean;
  readonly isParked: boolean;
  readonly isFreeHosting: boolean;
  /** Raw document size. Reported, never scored — see the note above. */
  readonly pageBytes: number;
  readonly scriptCount: number;
  /** True when no raw document was available and checks fell back to text. */
  readonly htmlUnavailable: boolean;
}

export interface WebsiteAnalysisResult {
  readonly url: string;
  readonly domain: string;
  readonly qualityScore: number;
  readonly seoScore: number;
  readonly contentScore: number;
  readonly mobileScore: number;
  readonly trustScore: number;
  readonly securityScore: number;
  /** Always null from this analyzer. Present so a real measurer can fill it. */
  readonly performanceScore: null;
  readonly performanceNote: string;
  readonly observations: WebsiteObservations;
  readonly findings: readonly AnalysisFinding[];
  readonly analyzerVersion: string;
}

export const PERFORMANCE_NOT_MEASURED =
  'Not measured. Load performance cannot be determined from a single server-side ' +
  'page fetch, and an estimate presented as a measurement would be misleading. ' +
  'Connect a real measurement source (Lighthouse or CrUX) to populate this.';

const BOOKING_PATTERNS =
  /\b(book (?:an )?appointment|book now|schedule (?:a )?visit|online booking|reserve a table|request a quote|enquire now|get a quote)\b/i;
const PARKED_PATTERNS =
  /\b(coming soon|under construction|domain (?:is )?for sale|buy this domain|parked|default web page|website is being built|account suspended)\b/i;
const CONTACT_LINK_PATTERN = /\/(contact|contact-us|contactus|reach-us|get-in-touch|enquiry)\b/i;

/**
 * Extracts structural facts from the document.
 *
 * Degrades rather than fails when no raw HTML is available: markdown still
 * carries headings, image alt text, and links, so the content checks stay valid
 * while the markup-only checks (viewport, canonical, structured data) are
 * reported as unavailable rather than scored as absent. Scoring a missing
 * measurement as a failure would invent a defect.
 */
export function observePage(page: FetchedPage): WebsiteObservations {
  const html = page.html;
  const content = page.content ?? '';
  const finalUrl = page.finalUrl || page.url;
  const pageDomain = normalizeDomain(finalUrl);

  let root: HTMLElement | null = null;
  if (html && html.trim() !== '') {
    try {
      root = parse(html, { blockTextElements: { script: false, style: false } });
    } catch {
      // A document too malformed to parse is itself a finding, but not a crash.
      root = null;
    }
  }

  const htmlUnavailable = root === null;

  // --- title and meta -------------------------------------------------------
  const titleText = root?.querySelector('title')?.text?.trim() ?? page.title?.trim() ?? '';
  const hasTitle = titleText.length > 0;

  const metaDescription =
    root?.querySelector('meta[name="description"]')?.getAttribute('content')?.trim() ??
    root?.querySelector('meta[property="og:description"]')?.getAttribute('content')?.trim() ??
    page.description?.trim() ??
    '';
  const hasMetaDescription = metaDescription.length > 0;

  // --- headings -------------------------------------------------------------
  const h1Count = root
    ? root.querySelectorAll('h1').length
    : // Markdown fallback: a line starting with a single '#'.
      (content.match(/^#\s+\S/gm) ?? []).length;

  // --- images ---------------------------------------------------------------
  let imageCount: number;
  let imagesWithAlt: number;

  if (root) {
    const images = root.querySelectorAll('img');
    imageCount = images.length;
    imagesWithAlt = images.filter((img) => {
      const alt = img.getAttribute('alt');
      // A present-but-empty alt is correct for decorative images, so it counts.
      return alt !== undefined && alt !== null;
    }).length;
  } else {
    const markdownImages = [...content.matchAll(/!\[([^\]]*)\]\([^)]*\)/g)];
    imageCount = markdownImages.length;
    imagesWithAlt = markdownImages.filter((m) => (m[1] ?? '').trim() !== '').length;
  }

  // --- mobile ---------------------------------------------------------------
  const viewportContent =
    root?.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? '';
  const hasViewportMeta = /width\s*=\s*device-width/i.test(viewportContent);

  const hasResponsiveHints = root
    ? root.querySelectorAll('img[srcset], source[srcset], picture').length > 0 ||
      /@media[^{]*\((?:max|min)-width/i.test(html ?? '')
    : false;

  // --- structured data and canonical ---------------------------------------
  const hasStructuredData = root
    ? root.querySelectorAll('script[type="application/ld+json"]').length > 0 ||
      root.querySelectorAll('[itemscope]').length > 0
    : false;

  const hasCanonical = root ? root.querySelector('link[rel="canonical"]') !== null : false;

  // --- links ----------------------------------------------------------------
  const hrefs: string[] = root
    ? root
        .querySelectorAll('a[href]')
        .map((a) => a.getAttribute('href') ?? '')
        .filter((href) => href !== '')
    : [...page.links];

  let internalLinkCount = 0;
  let externalLinkCount = 0;

  for (const href of hrefs) {
    if (href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) continue;
    if (href.startsWith('/') || href.startsWith('./') || href.startsWith('../')) {
      internalLinkCount += 1;
      continue;
    }
    const linkDomain = normalizeDomain(href);
    if (linkDomain === '' || linkDomain === pageDomain) internalLinkCount += 1;
    else externalLinkCount += 1;
  }

  const hasContactPage =
    hrefs.some((href) => CONTACT_LINK_PATTERN.test(href)) ||
    page.links.some((link) => CONTACT_LINK_PATTERN.test(link));

  // --- security -------------------------------------------------------------
  const httpsEnabled = page.httpsEnabled;

  /**
   * Mixed content: insecure subresources on a secure page. Counted only from
   * attributes that actually load a resource — a plain http:// hyperlink is not
   * mixed content and flagging it would manufacture a defect.
   */
  let mixedContentCount = 0;
  if (httpsEnabled && html) {
    mixedContentCount = (html.match(/\b(?:src|srcset|data-src)\s*=\s*["']http:\/\//gi) ?? [])
      .length;
    mixedContentCount += (html.match(/<link[^>]+href\s*=\s*["']http:\/\//gi) ?? []).length;
  }

  const scriptCount = root ? root.querySelectorAll('script').length : 0;

  const trimmedContent = content.trim();

  return {
    httpsEnabled,
    hasViewportMeta,
    hasTitle,
    titleLength: hasTitle ? titleText.length : null,
    hasMetaDescription,
    metaDescriptionLength: hasMetaDescription ? metaDescription.length : null,
    h1Count,
    imageCount,
    imagesWithAlt,
    hasStructuredData,
    hasCanonical,
    hasContactPage,
    hasBookingIndicator: BOOKING_PATTERNS.test(content),
    hasResponsiveHints,
    internalLinkCount,
    externalLinkCount,
    contentLength: trimmedContent.length,
    mixedContentCount,
    isThin: trimmedContent.length < 600,
    isParked: PARKED_PATTERNS.test(content) && trimmedContent.length < 1_500,
    isFreeHosting: isFreeHosting(finalUrl),
    pageBytes: (html ?? content).length,
    scriptCount,
    htmlUnavailable,
  };
}

/**
 * Scores the observations.
 *
 * Split from observation so scoring can be re-run against stored observations
 * when weights change, without re-fetching the page — the same principle that
 * makes `SIGNALS_VERSION` work for lead scores.
 */
export function scoreObservations(o: WebsiteObservations): {
  findings: AnalysisFinding[];
  categories: Record<CheckCategory, number>;
} {
  const findings: AnalysisFinding[] = [];

  const add = (
    id: string,
    category: CheckCategory,
    label: string,
    points: number,
    maxPoints: number,
    rationale: string,
  ): void => {
    findings.push({ id, category, label, points: Math.round(points), maxPoints, rationale });
  };

  // ----------------------------------------------------------------- SEO (25)
  if (!o.hasTitle) {
    add(
      'seo.title',
      'seo',
      'Page title',
      0,
      7,
      'The page has no title, so search results and browser tabs show only the URL.',
    );
  } else if (o.titleLength !== null && (o.titleLength < 15 || o.titleLength > 65)) {
    add(
      'seo.title',
      'seo',
      'Page title',
      4,
      7,
      `The title is ${o.titleLength} characters. Under 15 says too little; over 65 is truncated in search results.`,
    );
  } else {
    add('seo.title', 'seo', 'Page title', 7, 7, 'A title of a usable length is present.');
  }

  if (!o.hasMetaDescription) {
    add(
      'seo.metaDescription',
      'seo',
      'Meta description',
      0,
      7,
      'No meta description, so search engines invent the snippet shown under the result.',
    );
  } else if (
    o.metaDescriptionLength !== null &&
    (o.metaDescriptionLength < 50 || o.metaDescriptionLength > 165)
  ) {
    add(
      'seo.metaDescription',
      'seo',
      'Meta description',
      4,
      7,
      `The description is ${o.metaDescriptionLength} characters; roughly 50-165 displays in full.`,
    );
  } else {
    add(
      'seo.metaDescription',
      'seo',
      'Meta description',
      7,
      7,
      'A well-sized meta description is present.',
    );
  }

  if (o.h1Count === 0) {
    add(
      'seo.h1',
      'seo',
      'Main heading',
      0,
      6,
      'No H1 heading, so neither readers nor search engines are told what the page is about.',
    );
  } else if (o.h1Count > 1) {
    add(
      'seo.h1',
      'seo',
      'Main heading',
      3,
      6,
      `${o.h1Count} H1 headings compete to describe the page; one should lead.`,
    );
  } else {
    add('seo.h1', 'seo', 'Main heading', 6, 6, 'Exactly one H1 heading leads the page.');
  }

  if (o.htmlUnavailable) {
    // Not scored as a failure: we could not look, which is not the same as absent.
    add(
      'seo.structuredData',
      'seo',
      'Structured data',
      3,
      5,
      'Could not be checked — the raw page markup was not available.',
    );
  } else if (o.hasStructuredData) {
    add(
      'seo.structuredData',
      'seo',
      'Structured data',
      5,
      5,
      'Schema.org markup is present, which helps rich local search results.',
    );
  } else {
    add(
      'seo.structuredData',
      'seo',
      'Structured data',
      0,
      5,
      'No Schema.org markup, so opening hours, address, and reviews cannot appear directly in search results.',
    );
  }

  // ------------------------------------------------------------- Content (25)
  if (o.isParked) {
    add(
      'content.volume',
      'content',
      'Page content',
      0,
      10,
      'The page is a placeholder or parked domain rather than a working website.',
    );
  } else if (o.contentLength < 600) {
    add(
      'content.volume',
      'content',
      'Page content',
      2,
      10,
      `Only ${o.contentLength} characters of content — a single thin page, not a site.`,
    );
  } else if (o.contentLength < 1_500) {
    add(
      'content.volume',
      'content',
      'Page content',
      6,
      10,
      `${o.contentLength} characters of content: usable but light.`,
    );
  } else {
    add(
      'content.volume',
      'content',
      'Page content',
      10,
      10,
      `${o.contentLength} characters of substantive content.`,
    );
  }

  if (o.imageCount === 0) {
    add(
      'content.imageAlt',
      'content',
      'Image alt text',
      4,
      8,
      'No images found, so alt-text coverage does not apply.',
    );
  } else {
    const coverage = o.imagesWithAlt / o.imageCount;
    const points = Math.round(coverage * 8);
    add(
      'content.imageAlt',
      'content',
      'Image alt text',
      points,
      8,
      `${o.imagesWithAlt} of ${o.imageCount} images have alt text (${Math.round(coverage * 100)}%). Missing alt text hurts accessibility and image search.`,
    );
  }

  if (o.internalLinkCount >= 8) {
    add(
      'content.depth',
      'content',
      'Site depth',
      7,
      7,
      `${o.internalLinkCount} internal links indicate a real multi-page site.`,
    );
  } else if (o.internalLinkCount >= 3) {
    add(
      'content.depth',
      'content',
      'Site depth',
      4,
      7,
      `${o.internalLinkCount} internal links — a small site with limited depth.`,
    );
  } else {
    add(
      'content.depth',
      'content',
      'Site depth',
      0,
      7,
      `Only ${o.internalLinkCount} internal links; this appears to be a single-page presence.`,
    );
  }

  // -------------------------------------------------------------- Mobile (20)
  if (o.htmlUnavailable) {
    add(
      'mobile.viewport',
      'mobile',
      'Mobile viewport',
      7,
      13,
      'Could not be checked — the raw page markup was not available.',
    );
  } else if (o.hasViewportMeta) {
    add(
      'mobile.viewport',
      'mobile',
      'Mobile viewport',
      13,
      13,
      'A mobile viewport tag is set, so the site adapts to phone screens.',
    );
  } else {
    add(
      'mobile.viewport',
      'mobile',
      'Mobile viewport',
      0,
      13,
      'No mobile viewport tag. Phones render the desktop layout zoomed out, which is the single most visible mobile defect — and most local searches are on a phone.',
    );
  }

  if (o.htmlUnavailable) {
    add(
      'mobile.responsive',
      'mobile',
      'Responsive images',
      4,
      7,
      'Could not be checked — the raw page markup was not available.',
    );
  } else if (o.hasResponsiveHints) {
    add(
      'mobile.responsive',
      'mobile',
      'Responsive images',
      7,
      7,
      'Responsive image or media-query markup is present.',
    );
  } else {
    add(
      'mobile.responsive',
      'mobile',
      'Responsive images',
      0,
      7,
      'No responsive image markup or media queries found; phones likely download full-size desktop assets.',
    );
  }

  // --------------------------------------------------------------- Trust (15)
  if (o.hasContactPage) {
    add(
      'trust.contact',
      'trust',
      'Contact route',
      7,
      7,
      'A contact page is linked, so a visitor can reach the business.',
    );
  } else {
    add(
      'trust.contact',
      'trust',
      'Contact route',
      0,
      7,
      'No contact page is linked, so an interested visitor has no obvious way to get in touch.',
    );
  }

  if (o.hasBookingIndicator) {
    add(
      'trust.booking',
      'trust',
      'Booking or enquiry',
      5,
      5,
      'The page invites a booking or enquiry, turning visits into contacts.',
    );
  } else {
    add(
      'trust.booking',
      'trust',
      'Booking or enquiry',
      0,
      5,
      'No booking or enquiry call to action, so visitors are not converted into customers.',
    );
  }

  if (o.isFreeHosting) {
    add(
      'trust.hosting',
      'trust',
      'Own domain',
      0,
      3,
      'The site is on free subdomain hosting rather than the business’s own domain, which reads as unestablished.',
    );
  } else {
    add('trust.hosting', 'trust', 'Own domain', 3, 3, 'The site is on the business’s own domain.');
  }

  // ------------------------------------------------------------ Security (15)
  if (o.httpsEnabled) {
    add('security.https', 'security', 'HTTPS', 10, 10, 'The site is served over HTTPS.');
  } else {
    add(
      'security.https',
      'security',
      'HTTPS',
      0,
      10,
      'The site is served over plain HTTP. Browsers label it "Not secure" to every visitor, and search engines demote it.',
    );
  }

  if (!o.httpsEnabled) {
    // Mixed content is undefined without HTTPS; not a second penalty for the
    // same defect.
    add(
      'security.mixedContent',
      'security',
      'Mixed content',
      0,
      5,
      'Not applicable while the site is not served over HTTPS.',
    );
  } else if (o.mixedContentCount === 0) {
    add(
      'security.mixedContent',
      'security',
      'Mixed content',
      5,
      5,
      'No insecure resources are loaded on the secure page.',
    );
  } else {
    add(
      'security.mixedContent',
      'security',
      'Mixed content',
      1,
      5,
      `${o.mixedContentCount} resource(s) load over plain HTTP on an HTTPS page, which browsers block or warn about.`,
    );
  }

  // Aggregate per category, normalised to its weight so adding a check inside a
  // category never silently inflates that category's share of the total.
  const categories = {} as Record<CheckCategory, number>;

  for (const category of Object.keys(CATEGORY_WEIGHTS) as CheckCategory[]) {
    const inCategory = findings.filter((f) => f.category === category);
    const earned = inCategory.reduce((sum, f) => sum + f.points, 0);
    const possible = inCategory.reduce((sum, f) => sum + f.maxPoints, 0);
    categories[category] =
      possible === 0 ? 0 : Math.round((earned / possible) * CATEGORY_WEIGHTS[category]);
  }

  return { findings, categories };
}

/** Full analysis of one fetched page. */
export function analyzeWebsite(page: FetchedPage): WebsiteAnalysisResult {
  const observations = observePage(page);
  const { findings, categories } = scoreObservations(observations);
  const finalUrl = page.finalUrl || page.url;

  const qualityScore = Math.max(
    0,
    Math.min(
      100,
      categories.seo +
        categories.content +
        categories.mobile +
        categories.trust +
        categories.security,
    ),
  );

  return {
    url: finalUrl,
    domain: normalizeDomain(finalUrl),
    qualityScore,
    seoScore: categories.seo,
    contentScore: categories.content,
    mobileScore: categories.mobile,
    trustScore: categories.trust,
    securityScore: categories.security,
    performanceScore: null,
    performanceNote: PERFORMANCE_NOT_MEASURED,
    observations,
    findings,
    analyzerVersion: ANALYZER_VERSION,
  };
}

/**
 * Normalises a category score to 0-100 for display.
 *
 * The stored value is weighted (SEO is out of 25), which is right for summing but
 * wrong for a progress bar labelled "SEO". Both views come from one number rather
 * than two stored fields that could disagree.
 */
export function categoryPercent(category: CheckCategory, score: number): number {
  return Math.round((score / CATEGORY_WEIGHTS[category]) * 100);
}
