import { describe, expect, it } from 'vitest';

import {
  ANALYZER_VERSION,
  CATEGORY_WEIGHTS,
  analyzeWebsite,
  categoryPercent,
  observePage,
  scoreObservations,
  type CheckCategory,
} from '@/modules/enrichment/website-analysis';
import type { FetchedPage } from '@/modules/providers/contracts';

const MODERN_HTML = `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sri Krishna Dental Care | Dentist in Anna Nagar</title>
<meta name="description" content="Family dental clinic in Anna Nagar, Chennai. Book an appointment today on the phone or online.">
<link rel="canonical" href="https://clinic.in/">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Dentist"}</script>
</head><body>
<h1>Sri Krishna Dental Care</h1>
<img src="/a.jpg" alt="Reception">
<img srcset="/b-800.jpg 800w" src="/b.jpg" alt="Team">
<a href="/about">About</a><a href="/contact">Contact</a><a href="/services">Services</a>
<a href="/team">Team</a><a href="/pricing">Pricing</a><a href="/blog">Blog</a>
<a href="/faq">FAQ</a><a href="/reviews">Reviews</a>
<a href="https://instagram.com/clinic">Instagram</a>
<p>Book an appointment with our team of dentists in Anna Nagar, Chennai.</p>
</body></html>`;

const DATED_HTML = `<!doctype html><html><head>
<title>Clinic</title>
</head><body>
<img src="http://clinic.in/banner.jpg">
<img src="http://clinic.in/chair.jpg">
<a href="/about">About</a>
</body></html>`;

function page(overrides: Partial<FetchedPage> = {}): FetchedPage {
  return {
    url: 'https://clinic.in',
    finalUrl: 'https://clinic.in/',
    statusCode: 200,
    title: 'Sri Krishna Dental Care | Dentist in Anna Nagar',
    description: 'Family dental clinic in Anna Nagar, Chennai.',
    content: 'x'.repeat(2_000),
    html: MODERN_HTML,
    links: ['https://clinic.in/contact', 'https://clinic.in/about'],
    httpsEnabled: true,
    byteLength: 2_000,
    fetchedAt: new Date('2026-08-08T00:00:00.000Z'),
    ...overrides,
  };
}

describe('observePage', () => {
  it('reads the title, meta description, and headings from the document', () => {
    const o = observePage(page());

    expect(o.hasTitle).toBe(true);
    expect(o.hasMetaDescription).toBe(true);
    expect(o.h1Count).toBe(1);
  });

  it('detects a mobile viewport tag', () => {
    expect(observePage(page()).hasViewportMeta).toBe(true);
    expect(observePage(page({ html: DATED_HTML })).hasViewportMeta).toBe(false);
  });

  it('counts images and how many carry alt text', () => {
    const o = observePage(page());
    expect(o.imageCount).toBe(2);
    expect(o.imagesWithAlt).toBe(2);

    const dated = observePage(page({ html: DATED_HTML }));
    expect(dated.imageCount).toBe(2);
    expect(dated.imagesWithAlt).toBe(0);
  });

  it('treats a present-but-empty alt as correct, since that is right for decorative images', () => {
    const o = observePage(page({ html: '<html><body><img src="/x.jpg" alt=""></body></html>' }));
    expect(o.imageCount).toBe(1);
    expect(o.imagesWithAlt).toBe(1);
  });

  it('detects structured data and a canonical link', () => {
    const o = observePage(page());
    expect(o.hasStructuredData).toBe(true);
    expect(o.hasCanonical).toBe(true);

    const dated = observePage(page({ html: DATED_HTML }));
    expect(dated.hasStructuredData).toBe(false);
    expect(dated.hasCanonical).toBe(false);
  });

  it('separates internal from external links', () => {
    const o = observePage(page());
    expect(o.internalLinkCount).toBeGreaterThanOrEqual(8);
    expect(o.externalLinkCount).toBe(1);
  });

  it('counts insecure subresources on a secure page as mixed content', () => {
    const o = observePage(page({ html: DATED_HTML }));
    expect(o.mixedContentCount).toBeGreaterThan(0);
  });

  it('does not count a plain http hyperlink as mixed content', () => {
    // A link is navigation, not a loaded subresource. Flagging it would
    // manufacture a security defect that does not exist.
    const o = observePage(
      page({ html: '<html><body><a href="http://partner.example">Partner</a></body></html>' }),
    );
    expect(o.mixedContentCount).toBe(0);
  });

  it('reports mixed content as zero on an http page, where the concept does not apply', () => {
    const o = observePage(
      page({ httpsEnabled: false, finalUrl: 'http://clinic.in/', html: DATED_HTML }),
    );
    expect(o.mixedContentCount).toBe(0);
  });

  it('flags a parked page', () => {
    const o = observePage(
      page({ content: 'Coming soon. This site is under construction.', html: null }),
    );
    expect(o.isParked).toBe(true);
  });

  it('flags a thin page', () => {
    expect(observePage(page({ content: 'Hello.' })).isThin).toBe(true);
    expect(observePage(page()).isThin).toBe(false);
  });

  it('marks html as unavailable rather than inventing absent markup', () => {
    const o = observePage(page({ html: null }));
    expect(o.htmlUnavailable).toBe(true);
    // Crucially it does NOT claim the viewport tag is missing — we did not look.
    expect(o.hasViewportMeta).toBe(false);
  });

  it('falls back to markdown for headings and images when html is unavailable', () => {
    const o = observePage(
      page({
        html: null,
        content: '# Sri Krishna Dental Care\n\n![Reception](a.jpg)\n![](b.jpg)',
      }),
    );

    expect(o.h1Count).toBe(1);
    expect(o.imageCount).toBe(2);
    expect(o.imagesWithAlt).toBe(1);
  });

  it('survives malformed markup without throwing', () => {
    expect(() => observePage(page({ html: '<html><body><div><p>unclosed' }))).not.toThrow();
  });
});

describe('scoreObservations', () => {
  it('scores a modern site far above a dated one', () => {
    const modern = analyzeWebsite(page());
    const dated = analyzeWebsite(
      page({
        html: DATED_HTML,
        httpsEnabled: false,
        finalUrl: 'http://clinic.in/',
        content: 'Clinic.',
      }),
    );

    expect(modern.qualityScore).toBeGreaterThan(dated.qualityScore);
    expect(modern.qualityScore).toBeGreaterThan(70);
    expect(dated.qualityScore).toBeLessThan(40);
  });

  it('keeps every category within its declared weight', () => {
    for (const fixture of [page(), page({ html: DATED_HTML }), page({ html: null })]) {
      const result = analyzeWebsite(fixture);
      const categories: Record<CheckCategory, number> = {
        seo: result.seoScore,
        content: result.contentScore,
        mobile: result.mobileScore,
        trust: result.trustScore,
        security: result.securityScore,
      };

      for (const [name, value] of Object.entries(categories) as [CheckCategory, number][]) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(CATEGORY_WEIGHTS[name]);
      }
    }
  });

  it('keeps the total within 0-100 and equal to the sum of its categories', () => {
    const result = analyzeWebsite(page());
    const sum =
      result.seoScore +
      result.contentScore +
      result.mobileScore +
      result.trustScore +
      result.securityScore;

    expect(result.qualityScore).toBe(sum);
    expect(result.qualityScore).toBeGreaterThanOrEqual(0);
    expect(result.qualityScore).toBeLessThanOrEqual(100);
  });

  it('declares the category weights sum to 100, so the total is a real percentage', () => {
    const total = Object.values(CATEGORY_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBe(100);
  });

  it('awards no HTTPS points to a plain-http site', () => {
    const result = analyzeWebsite(page({ httpsEnabled: false, finalUrl: 'http://clinic.in/' }));
    const https = result.findings.find((f) => f.id === 'security.https');

    expect(https?.points).toBe(0);
  });

  it('does not penalise mixed content twice on a site that has no HTTPS at all', () => {
    const result = analyzeWebsite(
      page({ httpsEnabled: false, finalUrl: 'http://clinic.in/', html: DATED_HTML }),
    );
    const mixed = result.findings.find((f) => f.id === 'security.mixedContent');

    expect(mixed?.rationale).toMatch(/not applicable/i);
  });

  it('gives partial credit rather than zero for checks it could not perform', () => {
    // Absent markup means "we did not look", which must not be scored as a
    // defect the business does not have.
    const result = analyzeWebsite(page({ html: null }));
    const viewport = result.findings.find((f) => f.id === 'mobile.viewport');

    expect(viewport?.points).toBeGreaterThan(0);
    expect(viewport?.points).toBeLessThan(viewport!.maxPoints);
    expect(viewport?.rationale).toMatch(/not available/i);
  });

  it('explains every finding in words a non-technical reader can use', () => {
    for (const finding of analyzeWebsite(page({ html: DATED_HTML })).findings) {
      expect(finding.rationale.length).toBeGreaterThan(20);
      expect(finding.points).toBeLessThanOrEqual(finding.maxPoints);
      expect(finding.points).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('analyzeWebsite — honesty about what is not measured', () => {
  it('never reports a performance score, because a single fetch cannot measure one', () => {
    const result = analyzeWebsite(page());

    expect(result.performanceScore).toBeNull();
    expect(result.performanceNote).toMatch(/cannot be determined/i);
  });

  it('reports page weight as a raw observation rather than folding it into a score', () => {
    const result = analyzeWebsite(page());

    expect(result.observations.pageBytes).toBeGreaterThan(0);
    // No finding may cite page weight as if it were a performance measurement.
    expect(result.findings.some((f) => /performance|speed|load time/i.test(f.label))).toBe(false);
  });

  it('stamps the analyzer version so results recompute without refetching', () => {
    expect(analyzeWebsite(page()).analyzerVersion).toBe(ANALYZER_VERSION);
  });

  it('is deterministic for the same input', () => {
    const a = analyzeWebsite(page());
    const b = analyzeWebsite(page());
    expect(a.qualityScore).toBe(b.qualityScore);
    expect(a.findings).toEqual(b.findings);
  });
});

describe('categoryPercent', () => {
  it('converts a weighted score into a percentage for display', () => {
    expect(categoryPercent('seo', CATEGORY_WEIGHTS.seo)).toBe(100);
    expect(categoryPercent('seo', 0)).toBe(0);
  });
});

describe('scoreObservations is separable from observation', () => {
  it('re-scores stored observations without a page, so weights can change for free', () => {
    const observations = observePage(page());
    const { categories } = scoreObservations(observations);

    expect(categories.seo).toBe(analyzeWebsite(page()).seoScore);
  });
});
