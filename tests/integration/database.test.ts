/**
 * Database integration tests.
 *
 * Runs against a real PostgreSQL, because the properties under test are precisely
 * the ones an in-memory fake cannot verify: unique constraints, cascade behaviour,
 * transaction atomicity, and tenant isolation.
 *
 * Excluded from `npm test` so the default run needs no services. Run with:
 *   docker compose up -d && npm run test:integration
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeDatabase, db, type TenantContext } from '@/modules/database/client';
import {
  GOOGLE_SNAPSHOT_TTL_DAYS,
  currentGoogleSnapshot,
  ensurePlaceIdentifier,
  listLeads,
  purgeExpiredGoogleSnapshots,
  recordUsage,
  reviewVelocity,
  upsertDiscoveredBusiness,
  usageSummary,
} from '@/modules/database/repositories';
import type { NormalizedBusiness } from '@/types/domain';

const ORG_A = 'test_org_alpha';
const ORG_B = 'test_org_beta';

const tenantA: TenantContext = { organizationId: ORG_A };
const tenantB: TenantContext = { organizationId: ORG_B };

function business(overrides: Partial<NormalizedBusiness> = {}): NormalizedBusiness {
  return {
    placeId: 'ChIJintegration001',
    normalizedName: 'integration dental care',
    displayName: 'Integration Dental Care',
    primaryCategory: 'dental clinic',
    categories: ['dental clinic'],
    formattedAddress: '1 Test Road, Chennai, Tamil Nadu 600001',
    city: 'Chennai',
    state: 'Tamil Nadu',
    country: 'India',
    postalCode: '600001',
    location: { latitude: 13.08, longitude: 80.27 },
    phone: '+914428150001',
    rating: 4.7,
    reviewCount: 250,
    businessStatus: 'OPERATIONAL',
    googleMapsUri: 'https://maps.google.com/?cid=test',
    websiteUri: null,
    googleWebsiteStatus: 'GOOGLE_WEBSITE_NOT_LISTED',
    observedAt: new Date(),
    ...overrides,
  };
}

beforeAll(async () => {
  for (const id of [ORG_A, ORG_B]) {
    await db().organization.upsert({
      where: { id },
      update: {},
      create: { id, name: id, slug: id.replace(/_/g, '-') },
    });
  }
});

afterAll(async () => {
  // Cascades clear businesses, snapshots, usage, and scores.
  await db().organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } });
  await db().placeIdentifier.deleteMany({ where: { googlePlaceId: { startsWith: 'ChIJintegration' } } });
  await closeDatabase();
});

describe('upsertDiscoveredBusiness', () => {
  it('creates the place identifier, snapshot, and business in one transaction', async () => {
    const result = await upsertDiscoveredBusiness(tenantA, {
      business: business(),
      skuKey: 'text-search:enterprise',
    });

    expect(result.created).toBe(true);

    const row = await db().business.findUnique({
      where: { id: result.id },
      include: { placeIdentifier: { include: { snapshots: true } } },
    });

    expect(row?.displayName).toBe('Integration Dental Care');
    expect(row?.placeIdentifier.googlePlaceId).toBe('ChIJintegration001');
    expect(row?.placeIdentifier.snapshots).toHaveLength(1);
    // Derived at write time rather than trusted from the provider.
    expect(row?.phoneDigits).toBe('4428150001');
  });

  it('is idempotent for the same place and tenant', async () => {
    const first = await upsertDiscoveredBusiness(tenantA, {
      business: business({ placeId: 'ChIJintegration002' }),
      skuKey: 'text-search:enterprise',
    });
    const second = await upsertDiscoveredBusiness(tenantA, {
      business: business({ placeId: 'ChIJintegration002', reviewCount: 400 }),
      skuKey: 'text-search:enterprise',
    });

    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);

    const row = await db().business.findUnique({ where: { id: first.id } });
    // Metrics are refreshed on re-discovery.
    expect(row?.reviewCount).toBe(400);
  });

  /**
   * Two tenants get independent lead records over the same underlying place, while
   * sharing the Place ID so neither pays twice to learn the business exists.
   */
  it('gives each tenant its own business row over a shared place identifier', async () => {
    const spec = business({ placeId: 'ChIJintegration003' });

    const a = await upsertDiscoveredBusiness(tenantA, { business: spec, skuKey: 'text-search:enterprise' });
    const b = await upsertDiscoveredBusiness(tenantB, { business: spec, skuKey: 'text-search:enterprise' });

    expect(a.id).not.toBe(b.id);

    const rows = await db().business.findMany({
      where: { placeIdentifier: { googlePlaceId: 'ChIJintegration003' } },
      select: { organizationId: true, placeIdentifierId: true },
    });

    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.placeIdentifierId)).size).toBe(1);
  });

  it('classifies a directory URL rather than treating it as a website', async () => {
    const result = await upsertDiscoveredBusiness(tenantA, {
      business: business({
        placeId: 'ChIJintegration004',
        websiteUri: 'https://www.practo.com/chennai/clinic/integration-dental',
      }),
      skuKey: 'text-search:enterprise',
    });

    const row = await db().business.findUnique({ where: { id: result.id } });
    expect(row?.googleWebsiteStatus).toBe('GOOGLE_WEBSITE_IS_THIRD_PARTY_LISTING');
  });

  it('detects chains at write time', async () => {
    const result = await upsertDiscoveredBusiness(tenantA, {
      business: business({ placeId: 'ChIJintegration005', displayName: 'Clove Dental Velachery' }),
      skuKey: 'text-search:enterprise',
    });
    const row = await db().business.findUnique({ where: { id: result.id } });
    expect(row?.isChain).toBe(true);
  });
});

describe('tenant isolation', () => {
  it('never returns another organization\'s leads', async () => {
    await upsertDiscoveredBusiness(tenantA, {
      business: business({ placeId: 'ChIJintegration010', displayName: 'Alpha Only Clinic' }),
      skuKey: 'text-search:enterprise',
    });

    const forA = await listLeads(tenantA, { filters: { search: 'Alpha Only' } });
    const forB = await listLeads(tenantB, { filters: { search: 'Alpha Only' } });

    expect(forA.total).toBeGreaterThan(0);
    // The decisive assertion: a cross-tenant read returns zero rows, not an error
    // that might be caught and ignored somewhere.
    expect(forB.total).toBe(0);
  });

  it('scopes usage summaries per tenant', async () => {
    await recordUsage(tenantA, [
      {
        provider: 'google-places',
        operation: 'text-search',
        units: 1,
        unitKind: 'text-search:enterprise',
        costMicros: 35_000,
        durationMs: 120,
        status: 'SUCCESS',
      },
    ]);

    const summaryA = await usageSummary(tenantA, new Date(Date.now() - 60_000));
    const summaryB = await usageSummary(tenantB, new Date(Date.now() - 60_000));

    expect(summaryA.totalCostMicros).toBeGreaterThanOrEqual(35_000);
    expect(summaryB.totalCostMicros).toBe(0);
  });

  it('excludes mocked calls from spend but counts them separately', async () => {
    await recordUsage(tenantB, [
      {
        provider: 'groq',
        operation: 'chat.completions',
        units: 1,
        unitKind: 'calls',
        costMicros: 285,
        durationMs: 90,
        status: 'SUCCESS',
        mocked: true,
      },
    ]);

    const summary = await usageSummary(tenantB, new Date(Date.now() - 60_000));
    expect(summary.totalCostMicros).toBe(0);
    expect(summary.mockedCalls).toBeGreaterThan(0);
  });
});

describe('Google snapshot retention', () => {
  it('sets an expiry on write', async () => {
    await upsertDiscoveredBusiness(tenantA, {
      business: business({ placeId: 'ChIJintegration020' }),
      skuKey: 'text-search:enterprise',
    });

    const place = await ensurePlaceIdentifier('ChIJintegration020');
    const snapshot = await currentGoogleSnapshot(place.id);

    expect(snapshot).not.toBeNull();
    const days = (snapshot!.expiresAt.getTime() - snapshot!.fetchedAt.getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(GOOGLE_SNAPSHOT_TTL_DAYS);
  });

  it('purges expired snapshots and leaves live ones', async () => {
    const place = await ensurePlaceIdentifier('ChIJintegration021');

    await db().googlePlaceSnapshot.create({
      data: {
        placeIdentifierId: place.id,
        displayName: 'Expired Snapshot Clinic',
        skuKey: 'text-search:enterprise',
        fetchedAt: new Date(Date.now() - 60 * 86_400_000),
        expiresAt: new Date(Date.now() - 30 * 86_400_000),
      },
    });
    await db().googlePlaceSnapshot.create({
      data: {
        placeIdentifierId: place.id,
        displayName: 'Live Snapshot Clinic',
        skuKey: 'text-search:enterprise',
        expiresAt: new Date(Date.now() + 10 * 86_400_000),
      },
    });

    const purged = await purgeExpiredGoogleSnapshots();
    expect(purged).toBeGreaterThan(0);

    const remaining = await db().googlePlaceSnapshot.findMany({
      where: { placeIdentifierId: place.id },
    });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.displayName).toBe('Live Snapshot Clinic');

    // The Place ID survives the purge — that is the whole point of the split.
    expect(await db().placeIdentifier.findUnique({ where: { id: place.id } })).not.toBeNull();
  });

  /**
   * Review velocity exists only because Google data must be refreshed rather than
   * hoarded — a compliance constraint that yields signal no static scrape has.
   */
  it('computes review velocity from successive snapshots', async () => {
    const place = await ensurePlaceIdentifier('ChIJintegration022');

    await db().googlePlaceSnapshot.create({
      data: {
        placeIdentifierId: place.id,
        displayName: 'Growing Clinic',
        reviewCount: 100,
        skuKey: 'text-search:enterprise',
        fetchedAt: new Date(Date.now() - 30 * 86_400_000),
        expiresAt: new Date(Date.now() + 10 * 86_400_000),
      },
    });
    await db().googlePlaceSnapshot.create({
      data: {
        placeIdentifierId: place.id,
        displayName: 'Growing Clinic',
        reviewCount: 160,
        skuKey: 'text-search:enterprise',
        fetchedAt: new Date(),
        expiresAt: new Date(Date.now() + 40 * 86_400_000),
      },
    });

    const velocity = await reviewVelocity(place.id);
    expect(velocity).not.toBeNull();
    // 60 reviews over 30 days is about 60 per month.
    expect(velocity!.perMonth).toBeGreaterThan(50);
    expect(velocity!.perMonth).toBeLessThan(70);
  });

  it('returns null velocity with only one snapshot, rather than implying zero growth', async () => {
    const place = await ensurePlaceIdentifier('ChIJintegration023');
    await db().googlePlaceSnapshot.create({
      data: {
        placeIdentifierId: place.id,
        displayName: 'New Clinic',
        reviewCount: 40,
        skuKey: 'text-search:enterprise',
        expiresAt: new Date(Date.now() + 30 * 86_400_000),
      },
    });

    expect(await reviewVelocity(place.id)).toBeNull();
  });
});

describe('listLeads', () => {
  it('sorts unscored leads last rather than at the top of a score sort', async () => {
    await upsertDiscoveredBusiness(tenantA, {
      business: business({ placeId: 'ChIJintegration030', displayName: 'Unscored Clinic' }),
      skuKey: 'text-search:enterprise',
    });

    const scoredRow = await upsertDiscoveredBusiness(tenantA, {
      business: business({ placeId: 'ChIJintegration031', displayName: 'Scored Clinic' }),
      skuKey: 'text-search:enterprise',
    });
    await db().business.update({
      where: { id: scoredRow.id },
      data: { opportunityScore: 88, leadPriority: 'A' },
    });

    const result = await listLeads(tenantA, { sortBy: 'opportunityScore', sortDir: 'desc' });
    expect(result.rows[0]!.opportunityScore).not.toBeNull();
  });

  it('paginates deterministically', async () => {
    const page1 = await listLeads(tenantA, { page: 1, pageSize: 2 });
    const page2 = await listLeads(tenantA, { page: 2, pageSize: 2 });

    expect(page1.rows).toHaveLength(2);
    // A stable tiebreaker means no row appears on two pages.
    const overlap = page1.rows.filter((row) => page2.rows.some((other) => other.id === row.id));
    expect(overlap).toHaveLength(0);
  });

  it('caps page size so one request cannot select the whole table', async () => {
    const result = await listLeads(tenantA, { pageSize: 10_000 });
    expect(result.pageSize).toBeLessThanOrEqual(200);
  });
});
