/**
 * Repositories.
 *
 * Every function takes a {@link TenantContext} explicitly, so "forgot the
 * organizationId filter" is a compile error rather than a cross-tenant leak.
 * There is deliberately no un-scoped query helper for tenant-owned data.
 *
 * Provider-derived writes go through {@link upsertDiscoveredBusiness}, which is
 * the only place where a Google snapshot is persisted — keeping the TTL and the
 * durable/ephemeral split in one auditable location.
 */
import type { Prisma, PrismaClient } from '@prisma/client';

import { GOOGLE_SKUS, type GoogleSkuKey } from '@/config/pricing';
import { notFound } from '@/lib/errors';
import type { NormalizedBusiness } from '@/types/domain';

import { db, type TenantContext } from './client';
import {
  detectChain,
  extractPostalCode,
  isThirdPartyListing,
  normalizeBusinessName,
  phoneDigits,
} from '../leads/normalize';

/**
 * How long a Google-derived snapshot may be retained.
 *
 * Provider terms permit temporary caching of most Places content for a limited
 * window while allowing Place IDs to be kept indefinitely. 30 days is the
 * commonly documented window; it is configurable here so a stricter reading can
 * be applied without touching call sites. See docs/google-maps-compliance.md.
 */
export const GOOGLE_SNAPSHOT_TTL_DAYS = 30;

/** Google recommends refreshing Place IDs older than roughly 12 months. */
export const PLACE_ID_REFRESH_DAYS = 365;

function client(tx?: Prisma.TransactionClient): Prisma.TransactionClient | PrismaClient {
  return tx ?? db();
}

function snapshotExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + GOOGLE_SNAPSHOT_TTL_DAYS * 24 * 60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Place identity
// ---------------------------------------------------------------------------

/**
 * Ensures a Place ID row exists. Not tenant-scoped: a Place ID is provider
 * identity, not tenant data, and sharing it means two tenants discovering the
 * same business do not each pay to learn it exists.
 */
export async function ensurePlaceIdentifier(
  googlePlaceId: string,
  tx?: Prisma.TransactionClient,
): Promise<{ id: string }> {
  return client(tx).placeIdentifier.upsert({
    where: { googlePlaceId },
    update: {},
    create: { googlePlaceId },
    select: { id: true },
  });
}

/** Place IDs due a free existence check. */
export async function placeIdsDueRefresh(limit = 500): Promise<Array<{ id: string; googlePlaceId: string }>> {
  const cutoff = new Date(Date.now() - PLACE_ID_REFRESH_DAYS * 24 * 60 * 60 * 1000);
  return db().placeIdentifier.findMany({
    where: {
      invalidatedAt: null,
      OR: [{ lastVerifiedAt: null }, { lastVerifiedAt: { lt: cutoff } }],
    },
    select: { id: true, googlePlaceId: true },
    take: limit,
    orderBy: { lastVerifiedAt: { sort: 'asc', nulls: 'first' } },
  });
}

export async function recordPlaceIdRefresh(
  results: Record<string, boolean>,
): Promise<{ verified: number; invalidated: number }> {
  const now = new Date();
  const alive = Object.entries(results).filter(([, exists]) => exists).map(([id]) => id);
  const dead = Object.entries(results).filter(([, exists]) => !exists).map(([id]) => id);

  const [verified, invalidated] = await db().$transaction([
    db().placeIdentifier.updateMany({
      where: { googlePlaceId: { in: alive } },
      data: { lastVerifiedAt: now },
    }),
    db().placeIdentifier.updateMany({
      where: { googlePlaceId: { in: dead } },
      data: { invalidatedAt: now, lastVerifiedAt: now },
    }),
  ]);

  return { verified: verified.count, invalidated: invalidated.count };
}

// ---------------------------------------------------------------------------
// Business + Google snapshot
// ---------------------------------------------------------------------------

export interface UpsertDiscoveredInput {
  readonly business: NormalizedBusiness;
  readonly skuKey: GoogleSkuKey;
  readonly projectId?: string | null;
  readonly searchJobId?: string;
}

/**
 * Persists a discovered business: the durable tenant-scoped record, the shared
 * Place ID, and the TTL'd Google snapshot, in one transaction.
 *
 * The durable row holds the pipeline's working copy of Google metrics so
 * filtering and scoring can run without reading an expiring table; the snapshot
 * remains the system of record and the thing that gets purged.
 */
export async function upsertDiscoveredBusiness(
  tenant: TenantContext,
  input: UpsertDiscoveredInput,
): Promise<{ id: string; created: boolean }> {
  const { business, skuKey } = input;
  const normalizedName = business.normalizedName || normalizeBusinessName(business.displayName);
  const digits = phoneDigits(business.phone);
  const postalCode = business.postalCode ?? extractPostalCode(business.formattedAddress);

  // A websiteUri pointing at a directory means the business has no owned site —
  // the opportunity, not a disqualification.
  const googleWebsiteStatus = business.websiteUri
    ? isThirdPartyListing(business.websiteUri)
      ? 'GOOGLE_WEBSITE_IS_THIRD_PARTY_LISTING'
      : 'GOOGLE_WEBSITE_PRESENT'
    : 'GOOGLE_WEBSITE_NOT_LISTED';

  return db().$transaction(async (tx) => {
    const place = await ensurePlaceIdentifier(business.placeId, tx);

    await tx.placeIdentifier.update({
      where: { id: place.id },
      data: { lastVerifiedAt: new Date(), invalidatedAt: null },
    });

    await tx.googlePlaceSnapshot.create({
      data: {
        placeIdentifierId: place.id,
        displayName: business.displayName,
        formattedAddress: business.formattedAddress,
        city: business.city,
        state: business.state,
        country: business.country,
        postalCode,
        latitude: business.location?.latitude ?? null,
        longitude: business.location?.longitude ?? null,
        phone: business.phone,
        rating: business.rating,
        reviewCount: business.reviewCount,
        businessStatus: business.businessStatus,
        googleMapsUri: business.googleMapsUri,
        websiteUri: business.websiteUri,
        primaryCategory: business.primaryCategory,
        categories: [...business.categories],
        skuKey,
        fetchedAt: business.observedAt,
        expiresAt: snapshotExpiry(business.observedAt),
      },
    });

    const existing = await tx.business.findUnique({
      where: {
        organizationId_placeIdentifierId: {
          organizationId: tenant.organizationId,
          placeIdentifierId: place.id,
        },
      },
      select: { id: true },
    });

    const data = {
      normalizedName,
      displayName: business.displayName,
      primaryCategory: business.primaryCategory,
      categories: [...business.categories],
      formattedAddress: business.formattedAddress,
      city: business.city,
      state: business.state,
      country: business.country,
      postalCode,
      latitude: business.location?.latitude ?? null,
      longitude: business.location?.longitude ?? null,
      phone: business.phone,
      phoneDigits: digits,
      rating: business.rating,
      reviewCount: business.reviewCount,
      businessStatus: business.businessStatus,
      googleWebsiteStatus,
      isChain: detectChain(business.displayName),
    } satisfies Prisma.BusinessUpdateInput;

    const row = existing
      ? await tx.business.update({ where: { id: existing.id }, data, select: { id: true } })
      : await tx.business.create({
          data: {
            ...data,
            organizationId: tenant.organizationId,
            projectId: input.projectId ?? null,
            placeIdentifierId: place.id,
          },
          select: { id: true },
        });

    if (input.searchJobId) {
      await tx.searchResult.upsert({
        where: { searchJobId_businessId: { searchJobId: input.searchJobId, businessId: row.id } },
        update: {},
        create: { searchJobId: input.searchJobId, businessId: row.id },
      });
    }

    return { id: row.id, created: existing === null };
  });
}

export async function getBusiness(tenant: TenantContext, businessId: string) {
  const row = await db().business.findFirst({
    where: { id: businessId, organizationId: tenant.organizationId },
    include: {
      placeIdentifier: { select: { googlePlaceId: true } },
      websiteCandidates: { orderBy: [{ confidence: 'desc' }, { position: 'asc' }] },
      verifications: { orderBy: { verifiedAt: 'desc' }, include: { candidate: true } },
      socialProfiles: true,
      leadScores: { where: { isCurrent: true }, take: 1 },
      recommendations: { where: { isCurrent: true }, orderBy: { strength: 'desc' } },
      aiAnalyses: { orderBy: { createdAt: 'desc' }, take: 10 },
      notes: { orderBy: { createdAt: 'desc' } },
    },
  });

  if (!row) throw notFound('Lead', { businessId });
  return row;
}

export interface LeadFilters {
  readonly city?: string[];
  readonly category?: string[];
  readonly minRating?: number;
  readonly minReviews?: number;
  readonly googleWebsiteStatus?: string[];
  readonly independentWebsiteStatus?: string[];
  readonly digitalPresence?: string[];
  readonly priority?: string[];
  readonly minScore?: number;
  readonly service?: string[];
  readonly searchJobId?: string;
  readonly excludeChains?: boolean;
  readonly search?: string;
}

export type LeadSortField = 'opportunityScore' | 'rating' | 'reviewCount' | 'createdAt' | 'displayName';

/** Builds the tenant-scoped where clause shared by list and export. */
export function leadWhere(tenant: TenantContext, filters: LeadFilters): Prisma.BusinessWhereInput {
  const where: Prisma.BusinessWhereInput = { organizationId: tenant.organizationId };

  if (filters.city?.length) where.city = { in: filters.city };
  if (filters.category?.length) where.primaryCategory = { in: filters.category };
  if (filters.minRating !== undefined) where.rating = { gte: filters.minRating };
  if (filters.minReviews !== undefined) where.reviewCount = { gte: filters.minReviews };
  if (filters.minScore !== undefined) where.opportunityScore = { gte: filters.minScore };
  if (filters.excludeChains) where.isChain = false;

  if (filters.googleWebsiteStatus?.length) {
    where.googleWebsiteStatus = { in: filters.googleWebsiteStatus as never[] };
  }
  if (filters.independentWebsiteStatus?.length) {
    where.independentWebsiteStatus = { in: filters.independentWebsiteStatus as never[] };
  }
  if (filters.digitalPresence?.length) {
    where.digitalPresence = { in: filters.digitalPresence as never[] };
  }
  if (filters.priority?.length) {
    where.leadPriority = { in: filters.priority as never[] };
  }
  if (filters.service?.length) {
    where.recommendations = {
      some: { isCurrent: true, service: { in: filters.service as never[] } },
    };
  }
  if (filters.searchJobId) {
    where.searchResults = { some: { searchJobId: filters.searchJobId } };
  }
  // Case-insensitive substring search over the display name only. Deliberately
  // not a raw SQL LIKE built from user input.
  if (filters.search) {
    where.displayName = { contains: filters.search, mode: 'insensitive' };
  }

  return where;
}

export async function listLeads(
  tenant: TenantContext,
  options: {
    filters?: LeadFilters;
    sortBy?: LeadSortField;
    sortDir?: 'asc' | 'desc';
    page?: number;
    pageSize?: number;
  } = {},
) {
  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, options.pageSize ?? 50));
  const sortBy = options.sortBy ?? 'opportunityScore';
  const sortDir = options.sortDir ?? 'desc';
  const where = leadWhere(tenant, options.filters ?? {});

  const [rows, total] = await Promise.all([
    db().business.findMany({
      where,
      // Nulls last so unscored leads do not occupy the top of a score sort.
      orderBy: [{ [sortBy]: { sort: sortDir, nulls: 'last' } }, { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        recommendations: { where: { isCurrent: true }, orderBy: { strength: 'desc' }, take: 2 },
        verifications: { orderBy: { verifiedAt: 'desc' }, take: 1 },
        socialProfiles: { select: { platform: true } },
      },
    }),
    db().business.count({ where }),
  ]);

  return { rows, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

/** Businesses that passed filtering and still need enrichment. */
export async function pendingEnrichment(
  tenant: TenantContext,
  searchJobId: string,
  limit = 500,
): Promise<Array<{ id: string }>> {
  return db().business.findMany({
    where: {
      organizationId: tenant.organizationId,
      enrichedAt: null,
      searchResults: { some: { searchJobId, passedFilter: true } },
    },
    select: { id: true },
    take: limit,
  });
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/**
 * Deletes expired Google snapshots.
 *
 * An unmonitored retention job is the same as no retention policy, so this
 * returns its count for the caller to log and alert on.
 */
export async function purgeExpiredGoogleSnapshots(now: Date = new Date()): Promise<number> {
  const { count } = await db().googlePlaceSnapshot.deleteMany({
    where: { expiresAt: { lt: now } },
  });
  return count;
}

/** The most recent unexpired snapshot for a place, or null. */
export async function currentGoogleSnapshot(placeIdentifierId: string, now: Date = new Date()) {
  return db().googlePlaceSnapshot.findFirst({
    where: { placeIdentifierId, expiresAt: { gt: now } },
    orderBy: { fetchedAt: 'desc' },
  });
}

/**
 * Two snapshots far enough apart to compute review velocity.
 *
 * This is the upside of a constraint: because Google data must be refreshed
 * rather than hoarded, successive snapshots exist, and review growth is a far
 * better commercial signal than a single review total.
 */
export async function reviewVelocity(
  placeIdentifierId: string,
): Promise<{ perMonth: number; spanDays: number } | null> {
  const snapshots = await db().googlePlaceSnapshot.findMany({
    where: { placeIdentifierId, reviewCount: { not: null } },
    orderBy: { fetchedAt: 'desc' },
    take: 2,
    select: { reviewCount: true, fetchedAt: true },
  });

  if (snapshots.length < 2) return null;
  const [latest, previous] = snapshots as [(typeof snapshots)[0], (typeof snapshots)[0]];

  const spanDays = (latest.fetchedAt.getTime() - previous.fetchedAt.getTime()) / 86_400_000;
  if (spanDays < 1) return null;

  const delta = (latest.reviewCount ?? 0) - (previous.reviewCount ?? 0);
  return { perMonth: (delta / spanDays) * 30, spanDays };
}

// ---------------------------------------------------------------------------
// Cost tracking
// ---------------------------------------------------------------------------

const PROVIDER_ENUM = {
  'google-places': 'GOOGLE_PLACES',
  firecrawl: 'FIRECRAWL',
  groq: 'GROQ',
} as const;

export interface RecordUsageInput {
  readonly provider: keyof typeof PROVIDER_ENUM;
  readonly operation: string;
  readonly units: number;
  readonly unitKind: string;
  readonly costMicros: number;
  readonly durationMs: number;
  readonly status: 'SUCCESS' | 'FAILED' | 'RATE_LIMITED' | 'TIMEOUT' | 'CACHED' | 'SKIPPED_BUDGET';
  readonly errorCode?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly mocked?: boolean;
  readonly requestId?: string;
  readonly jobId?: string;
  readonly searchJobId?: string;
}

export async function recordUsage(
  tenant: TenantContext,
  entries: readonly RecordUsageInput[],
): Promise<void> {
  if (entries.length === 0) return;

  await db().apiUsage.createMany({
    data: entries.map((entry) => ({
      organizationId: tenant.organizationId,
      provider: PROVIDER_ENUM[entry.provider],
      operation: entry.operation,
      units: entry.units,
      unitKind: entry.unitKind,
      costMicros: entry.costMicros,
      durationMs: entry.durationMs,
      status: entry.status,
      errorCode: entry.errorCode ?? null,
      inputTokens: entry.inputTokens ?? null,
      outputTokens: entry.outputTokens ?? null,
      mocked: entry.mocked ?? false,
      requestId: entry.requestId ?? tenant.requestId ?? null,
      jobId: entry.jobId ?? null,
      searchJobId: entry.searchJobId ?? null,
    })),
  });
}

/**
 * Cost roll-up for the usage dashboard.
 *
 * Mocked calls are excluded from spend but counted separately, so development
 * activity never inflates a real cost report.
 */
export async function usageSummary(
  tenant: TenantContext,
  since: Date,
): Promise<{
  byProvider: Array<{ provider: string; calls: number; units: number; costMicros: number }>;
  totalCostMicros: number;
  totalCalls: number;
  mockedCalls: number;
  failures: number;
}> {
  const grouped = await db().apiUsage.groupBy({
    by: ['provider'],
    where: { organizationId: tenant.organizationId, createdAt: { gte: since }, mocked: false },
    _count: { _all: true },
    _sum: { units: true, costMicros: true },
  });

  const [mockedCalls, failures] = await Promise.all([
    db().apiUsage.count({
      where: { organizationId: tenant.organizationId, createdAt: { gte: since }, mocked: true },
    }),
    db().apiUsage.count({
      where: {
        organizationId: tenant.organizationId,
        createdAt: { gte: since },
        status: { in: ['FAILED', 'TIMEOUT', 'RATE_LIMITED'] },
      },
    }),
  ]);

  const byProvider = grouped.map((row) => ({
    provider: row.provider,
    calls: row._count._all,
    units: row._sum.units ?? 0,
    costMicros: row._sum.costMicros ?? 0,
  }));

  return {
    byProvider,
    totalCostMicros: byProvider.reduce((sum, row) => sum + row.costMicros, 0),
    totalCalls: byProvider.reduce((sum, row) => sum + row.calls, 0),
    mockedCalls,
    failures,
  };
}

/** Spend since a point in time, used by the budget guard's slow path. */
export async function spendSince(tenant: TenantContext, since: Date): Promise<number> {
  const result = await db().apiUsage.aggregate({
    where: { organizationId: tenant.organizationId, createdAt: { gte: since }, mocked: false },
    _sum: { costMicros: true },
  });
  return result._sum.costMicros ?? 0;
}

// ---------------------------------------------------------------------------
// Events and audit
// ---------------------------------------------------------------------------

export async function recordEvent(input: {
  organizationId?: string;
  level: 'INFO' | 'WARN' | 'ERROR';
  code: string;
  message: string;
  context?: Prisma.InputJsonValue;
}): Promise<void> {
  await db().systemEvent.create({
    data: {
      organizationId: input.organizationId ?? null,
      level: input.level,
      code: input.code,
      message: input.message,
      context: input.context ?? undefined,
    },
  });
}

export async function recordAudit(
  tenant: TenantContext,
  input: {
    action: string;
    resourceType: string;
    resourceId?: string;
    metadata?: Prisma.InputJsonValue;
  },
): Promise<void> {
  await db().auditLog.create({
    data: {
      organizationId: tenant.organizationId,
      userId: tenant.userId ?? null,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      metadata: input.metadata ?? undefined,
    },
  });
}

/** Exposed so the cost dashboard can name the SKU behind a spend line. */
export function skuLabel(unitKind: string): string {
  return GOOGLE_SKUS[unitKind as GoogleSkuKey]?.label ?? unitKind;
}
