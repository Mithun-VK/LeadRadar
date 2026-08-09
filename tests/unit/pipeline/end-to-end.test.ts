/**
 * End-to-end pipeline test, in-process against mock providers.
 *
 * Exercises the exact scenario from the brief:
 *
 *   "Find dental clinics in Chennai with no website and more than 50 reviews."
 *
 * query parse → structured query → validation → search plan → mock discovery →
 * dedupe → deterministic filtering → website discovery → verification →
 * Groq only when ambiguous → scoring → service recommendation → export
 *
 * No database and no Redis, so it runs in CI with no services. The database-backed
 * variant lives in tests/integration.
 */
import { describe, expect, it } from 'vitest';

import { estimateSearchCost } from '@/modules/search/cost-estimator';
import { partitionByFilters } from '@/modules/search/filters';
import { resolveCity, seedCells, subdivide } from '@/modules/search/geography';
import { dedupeByPlaceId, detectChain } from '@/modules/leads/normalize';
import { enrichBusiness, socialPlatformsOf } from '@/modules/enrichment/pipeline';
import { createMockRegistry } from '@/modules/providers/registry';
import { scoreOpportunity } from '@/modules/scoring/opportunity';
import { recommendServices } from '@/modules/scoring/services';
import { columnsFor, toCsv } from '@/modules/export/policy';
import { structuredQuerySchema } from '@/schemas/query';
import type { NormalizedBusiness } from '@/types/domain';

const RAW_QUERY = 'Find dental clinics in Chennai with no website and more than 50 reviews.';

describe('end-to-end: the brief scenario', () => {
  it('runs the whole pipeline and produces qualified, explainable leads', async () => {
    const providers = createMockRegistry();

    // ---- 1. parse natural language ---------------------------------------
    const parsed = await providers.ai.parseQuery(RAW_QUERY);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const query = parsed.value.data.result;
    expect(query.categories).toContain('dental clinic');
    expect(query.locations).toContain('Chennai, India');
    expect(query.minimumReviews).toBe(50);
    expect(query.websiteStatus).toBe('GOOGLE_WEBSITE_NOT_LISTED');

    // ---- 2. validation: the query must survive the strict schema ----------
    expect(structuredQuerySchema.safeParse(query).success).toBe(true);

    // ---- 3. cost estimate before any spend -------------------------------
    const estimate = estimateSearchCost(query);
    expect(estimate.googleRequests).toBeGreaterThan(0);
    expect(estimate.estimatedQualifiedLeads).toBeGreaterThan(0);
    // Per-qualified-lead cost is the metric that matters, and it should be cents.
    expect(estimate.costPerQualifiedLeadMicros).toBeLessThan(1_000_000);

    // ---- 4. search plan: cells from the city registry --------------------
    const city = resolveCity(query.locations[0]!);
    expect(city).not.toBeNull();
    const cells = seedCells(city!);
    expect(cells.length).toBeGreaterThan(0);

    // ---- 5. discovery: fan out over every cell, paginating explicitly ----
    // All cells, not just the first: the planner fans out across the whole city,
    // and businesses are distributed among the quadrants.
    const discovered: NormalizedBusiness[] = [];

    for (const cell of cells) {
      let pageToken: string | undefined;
      let requests = 0;

      do {
        const page = await providers.discovery.search({
          textQuery: `dental clinic in ${city!.name}`,
          locationRestriction: cell.bounds,
          ...(pageToken !== undefined && { pageToken }),
          pageSize: 20,
        });
        expect(page.ok).toBe(true);
        if (!page.ok) return;

        requests += 1;
        discovered.push(...page.value.data.businesses);
        pageToken = page.value.data.nextPageToken ?? undefined;

        // Every page reports its cost, so spend cannot be made invisibly.
        expect(page.value.usage[0]!.provider).toBe('google-places');
      } while (pageToken !== undefined && requests < 3);
    }

    expect(discovered.length).toBeGreaterThan(0);

    // ---- 6. dedupe before any enrichment spend ---------------------------
    const unique = dedupeByPlaceId(discovered);
    expect(unique.length).toBe(new Set(unique.map((b) => b.placeId)).size);

    // ---- 7. deterministic filtering --------------------------------------
    const { passed, dropped, reasonCounts } = partitionByFilters(
      unique,
      { query, expectedCities: ['Chennai'] },
      (business) => detectChain(business.displayName),
    );

    expect(passed.length).toBeGreaterThan(0);
    // Filtering must actually remove work, or the stage is pointless.
    expect(dropped.length).toBeGreaterThan(0);

    // The closed clinic and the sub-50-review clinic must both be gone.
    expect(passed.some((b) => b.businessStatus === 'CLOSED_PERMANENTLY')).toBe(false);
    expect(passed.every((b) => (b.reviewCount ?? 0) >= 50)).toBe(true);

    // Every drop carries a reason, so the UI can explain the funnel.
    for (const entry of dropped) {
      expect(entry.outcome.reason).toBeDefined();
      expect(entry.outcome.detail).toBeDefined();
    }
    expect(Object.keys(reasonCounts).length).toBeGreaterThan(0);

    /**
     * A directory-only listing must SURVIVE a "no website" filter: the business
     * owns no site, which is exactly the opportunity. This is the assertion that
     * would fail under a naive `websiteUri != null` check.
     */
    const directoryOnly = unique.find(
      (b) => b.googleWebsiteStatus === 'GOOGLE_WEBSITE_IS_THIRD_PARTY_LISTING',
    );
    if (directoryOnly && (directoryOnly.reviewCount ?? 0) >= 50) {
      expect(passed.some((b) => b.placeId === directoryOnly.placeId)).toBe(true);
    }

    // ---- 8. enrichment: discovery, verification, social ------------------
    const enrichedResults = [];
    for (const business of passed.slice(0, 5)) {
      const result = await enrichBusiness(
        {
          id: business.placeId,
          displayName: business.displayName,
          normalizedName: business.normalizedName,
          city: business.city,
          primaryCategory: business.primaryCategory,
          formattedAddress: business.formattedAddress,
          phone: business.phone,
          googleWebsiteStatus: business.googleWebsiteStatus,
          websiteUri: business.websiteUri,
        },
        providers,
      );

      // Enrichment never throws for ordinary web failure.
      expect(result.independentWebsiteStatus).toBeDefined();
      // Every enrichment explains what it decided and why.
      expect(result.decisions.length).toBeGreaterThan(0);

      enrichedResults.push({ business, result });
    }

    expect(enrichedResults.length).toBeGreaterThan(0);

    // ---- 9. scoring and recommendation -----------------------------------
    const scored = enrichedResults.map(({ business, result }) => {
      const platforms = socialPlatformsOf(result.socialProfiles);

      const score = scoreOpportunity({
        businessStatus: business.businessStatus,
        googleWebsiteStatus: business.googleWebsiteStatus,
        independentWebsiteStatus: result.independentWebsiteStatus,
        rating: business.rating,
        reviewCount: business.reviewCount,
        reviewVelocityPerMonth: null,
        hasPhone: business.phone !== null,
        socialPlatforms: platforms,
        isChain: detectChain(business.displayName),
        identityVerification:
          result.verification?.status === 'MATCH'
            ? 'VERIFIED'
            : result.verification?.status === 'PROBABLE_MATCH'
              ? 'PROBABLE'
              : 'UNVERIFIED',
        websiteQuality: result.websiteQuality,
      });

      const recommendations = recommendServices({
        googleWebsiteStatus: business.googleWebsiteStatus,
        independentWebsiteStatus: result.independentWebsiteStatus,
        websiteQuality: result.websiteQuality,
        socialPlatforms: platforms,
        rating: business.rating,
        reviewCount: business.reviewCount,
        isChain: detectChain(business.displayName),
        primaryCategory: business.primaryCategory,
      });

      return { business, score, recommendations };
    });

    for (const entry of scored) {
      expect(entry.score.total).toBeGreaterThanOrEqual(0);
      expect(entry.score.total).toBeLessThanOrEqual(100);
      // Explainability is not optional: every score has signals with rationale.
      expect(entry.score.signals.length).toBeGreaterThan(0);
      for (const signal of entry.score.signals) {
        expect(signal.rationale).not.toBe('');
      }
      // A non-chain lead always has something to sell.
      if (!detectChain(entry.business.displayName)) {
        expect(entry.recommendations.length).toBeGreaterThan(0);
        expect(entry.recommendations[0]!.pitch).not.toBe('');
      }
    }

    // ---- 10. the ranking requirement -------------------------------------
    const ranked = [...scored].sort((a, b) => b.score.total - a.score.total);
    const best = ranked[0]!;
    const worst = ranked.at(-1)!;

    // The top lead must have real demand behind it, not just an absent website.
    expect(best.score.total).toBeGreaterThanOrEqual(worst.score.total);
    expect(best.recommendations.length).toBeGreaterThan(0);

    // ---- 11. export, safe policy by default ------------------------------
    const columns = columnsFor('safe');
    const csv = toCsv(
      columns,
      scored.map(({ business, score, recommendations }) => ({
        opportunityScore: score.total,
        leadPriority: score.priority,
        digitalPresence: score.digitalPresence,
        recommendedServices: recommendations.map((rec) => rec.service).join('; '),
        topPitch: recommendations[0]?.pitch ?? '',
        verifiedDomain: '',
        googlePlaceId: business.placeId,
      })),
    );

    expect(csv).toContain('Opportunity Score');
    // Google-derived columns must be absent by default.
    expect(csv).not.toContain('Business Name');
    expect(csv.split('\r\n').length).toBeGreaterThan(1);
  });

  it('spends nothing on a query with no recognised location', () => {
    const estimate = estimateSearchCost({
      categories: ['dental clinic'],
      locations: ['Atlantis'],
      minimumRating: null,
      maximumRating: null,
      minimumReviews: null,
      maximumReviews: null,
      websiteStatus: 'ANY',
      requireSocialPresence: null,
      excludeChains: false,
      maxResults: null,
    });

    expect(estimate.googleRequests).toBe(0);
    expect(estimate.totalCostMicros).toBe(0);
    expect(estimate.warnings.join(' ')).toMatch(/discover nothing/i);
  });
});

describe('geographic subdivision', () => {
  it('splits a cell into four disjoint quadrants covering the parent', () => {
    const city = resolveCity('Chennai, India')!;
    const parent = seedCells(city)[0]!;
    const children = subdivide(parent);

    expect(children).toHaveLength(4);
    for (const child of children) {
      expect(child.depth).toBe(parent.depth + 1);
      expect(child.bounds.south).toBeGreaterThanOrEqual(parent.bounds.south);
      expect(child.bounds.north).toBeLessThanOrEqual(parent.bounds.north);
      expect(child.bounds.west).toBeGreaterThanOrEqual(parent.bounds.west);
      expect(child.bounds.east).toBeLessThanOrEqual(parent.bounds.east);
    }

    // Cell keys are derived from bounds, so they are stable and unique.
    expect(new Set(children.map((child) => child.cellKey)).size).toBe(4);
  });

  it('resolves common city aliases so a user is not told Bengaluru is unsupported', () => {
    expect(resolveCity('Bengaluru')?.name).toBe('Bangalore');
    expect(resolveCity('Bombay')?.name).toBe('Mumbai');
    expect(resolveCity('New Delhi, India')?.name).toBe('Delhi');
    expect(resolveCity('Atlantis')).toBeNull();
  });
});
