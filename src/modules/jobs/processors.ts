/**
 * Job processors — where the pipeline actually runs.
 *
 * Three invariants hold in every processor:
 *
 *   1. Budget is reserved BEFORE the provider call and settled after, so spend
 *      cannot overshoot through concurrency.
 *   2. Usage is persisted whether the call succeeded or not, because a failed
 *      request is frequently still a billed request and cost reporting must be
 *      honest.
 *   3. Ordinary web/provider failure for ONE business never fails the job for the
 *      other thousands. Only unprocessable payloads and infrastructure failures
 *      propagate.
 */
import { GOOGLE_SKUS, usdToMicros } from '@/config/pricing';
import { AppError, isAppError, toAppError } from '@/lib/errors';
import { env } from '@/lib/env';
import { jobLogger } from '@/lib/logger';
import { jobIds } from '@/lib/ids';
import { db, type TenantContext } from '@/modules/database/client';
import {
  pendingEnrichment,
  purgeExpiredGoogleSnapshots,
  placeIdsDueRefresh,
  recordEvent,
  recordPlaceIdRefresh,
  recordUsage,
  reviewVelocity,
  upsertDiscoveredBusiness,
  type RecordUsageInput,
} from '@/modules/database/repositories';
import { enrichBusiness, socialPlatformsOf } from '@/modules/enrichment/pipeline';
import { providers } from '@/modules/providers/registry';
import type { UsageRecord } from '@/modules/providers/contracts';
import { reserveBudget, releaseBudget, settleBudget } from '@/modules/providers/rate-limit';
import { DISCOVERY_SKU } from '@/modules/providers/google-places/field-masks';
import { partitionByFilters } from '@/modules/search/filters';
import {
  MAX_SUBDIVISION_DEPTH,
  makeCell,
  resolveCity,
  seedCells,
  shouldSubdivide,
  subdivide,
} from '@/modules/search/geography';
import { recommendServices, narrativeSignals } from '@/modules/scoring/services';
import { scoreOpportunity } from '@/modules/scoring/opportunity';
import { SIGNALS_VERSION } from '@/modules/scoring/config';
import { detectChain } from '@/modules/leads/normalize';
import { confidenceBand } from '@/types/domain';

import { getQueue, QUEUE_NAMES } from './queues';
import {
  discoverPayloadSchema,
  enrichPayloadSchema,
  maintenancePayloadSchema,
  parsePayload,
  scorePayloadSchema,
  searchJobPayloadSchema,
  type DiscoverPayload,
  type EnrichPayload,
  type MaintenancePayload,
  type ScorePayload,
  type SearchJobPayload,
} from './schemas';

function tenantOf(payload: { organizationId: string; userId?: string; requestId?: string }): TenantContext {
  return {
    organizationId: payload.organizationId,
    ...(payload.userId !== undefined && { userId: payload.userId }),
    ...(payload.requestId !== undefined && { requestId: payload.requestId }),
  };
}

/** Converts provider usage records into persistable rows. */
function toUsageRows(
  records: readonly UsageRecord[],
  context: { jobId?: string; searchJobId?: string; failed?: boolean },
): RecordUsageInput[] {
  return records.map((record) => ({
    provider: record.provider,
    operation: record.operation,
    units: record.units,
    unitKind: record.unitKind,
    costMicros: record.estimatedCostMicros,
    durationMs: record.durationMs,
    status: context.failed ? ('FAILED' as const) : ('SUCCESS' as const),
    ...(record.inputTokens !== undefined && { inputTokens: record.inputTokens }),
    ...(record.outputTokens !== undefined && { outputTokens: record.outputTokens }),
    mocked: record.mocked,
    ...(context.jobId !== undefined && { jobId: context.jobId }),
    ...(context.searchJobId !== undefined && { searchJobId: context.searchJobId }),
  }));
}

/** Budget scopes checked before every billable call. */
async function budgetChecks(tenant: TenantContext) {
  const config = env();
  const rows = await db().budget.findMany({
    where: { organizationId: tenant.organizationId },
    select: { scope: true, limitMicros: true },
  });

  const fromDb = new Map(rows.map((row) => [row.scope, row.limitMicros]));

  return [
    { scope: 'daily' as const, limitMicros: fromDb.get('DAILY') ?? usdToMicros(config.DAILY_BUDGET_USD) },
    { scope: 'monthly' as const, limitMicros: fromDb.get('MONTHLY') ?? usdToMicros(config.MONTHLY_BUDGET_USD) },
  ];
}

// ---------------------------------------------------------------------------
// search — coordinator
// ---------------------------------------------------------------------------

/**
 * Plans the search and fans out one discovery job per (cell, category).
 *
 * Cells start coarse. Subdivision happens reactively in the discovery processor
 * when a cell turns out to be saturated, because saturation is the only evidence
 * that a cell hides more businesses than one request can return.
 */
export async function processSearch(raw: unknown, bullJobId?: string): Promise<{ enqueued: number }> {
  const payload = parsePayload<SearchJobPayload>(searchJobPayloadSchema, raw, QUEUE_NAMES.search);
  const log = jobLogger(bullJobId ?? payload.searchJobId, QUEUE_NAMES.search, {
    searchJobId: payload.searchJobId,
  });

  const cities = payload.query.locations
    .map((location) => resolveCity(location))
    .filter((city): city is NonNullable<typeof city> => city !== null);

  if (cities.length === 0) {
    await db().searchJob.update({
      where: { id: payload.searchJobId },
      data: {
        status: 'FAILED',
        errorCode: 'UNSUPPORTED_QUERY',
        statusMessage: 'None of the requested locations are in the city registry.',
        completedAt: new Date(),
      },
    });
    return { enqueued: 0 };
  }

  await db().searchJob.update({
    where: { id: payload.searchJobId },
    data: { status: 'RUNNING', startedAt: new Date(), progress: 5 },
  });

  const queue = getQueue(QUEUE_NAMES.googlePlaces);
  let enqueued = 0;

  for (const city of cities) {
    for (const category of payload.query.categories) {
      for (const cell of seedCells(city)) {
        await queue.add(
          'discover',
          {
            ...payload,
            category,
            cellKey: cell.cellKey,
            bounds: cell.bounds,
            depth: cell.depth,
            cityName: city.name,
            regionCode: city.regionCode,
            pageIndex: 0,
          } satisfies DiscoverPayload,
          // Deterministic id: a replayed or duplicated coordinator cannot cause
          // the same billable request to run twice.
          { jobId: jobIds.discover(payload.searchJobId, cell.cellKey, category, 0) },
        );
        enqueued += 1;
      }
    }
  }

  log.info({ cities: cities.length, categories: payload.query.categories.length, enqueued }, 'Search planned');
  return { enqueued };
}

// ---------------------------------------------------------------------------
// google-places — discovery
// ---------------------------------------------------------------------------

export async function processDiscover(
  raw: unknown,
  bullJobId?: string,
): Promise<{ discovered: number; passed: number; saturated: boolean }> {
  const payload = parsePayload<DiscoverPayload>(discoverPayloadSchema, raw, QUEUE_NAMES.googlePlaces);
  const tenant = tenantOf(payload);
  const log = jobLogger(bullJobId ?? 'discover', QUEUE_NAMES.googlePlaces, {
    searchJobId: payload.searchJobId,
    cellKey: payload.cellKey,
    category: payload.category,
  });

  const registry = providers();
  const sku = GOOGLE_SKUS[DISCOVERY_SKU];
  const estimated = Math.round(sku.per1000Micros / 1000);

  // Reserve before the call. Overshoot is irreversible; a paused job is not.
  const reservation = await reserveBudget(
    { organizationId: tenant.organizationId, jobId: payload.searchJobId },
    await budgetChecks(tenant),
    estimated,
  );

  const result = await registry.discovery.search({
    textQuery: `${payload.category} in ${payload.cityName}`,
    includedType: undefined,
    locationRestriction: payload.bounds,
    ...(payload.query.minimumRating !== null && { minRating: payload.query.minimumRating }),
    ...(payload.pageToken !== undefined && { pageToken: payload.pageToken }),
    regionCode: payload.regionCode,
    pageSize: 20,
  });

  if (!result.ok) {
    await releaseBudget(reservation.keys, estimated);
    await recordUsage(tenant, [
      {
        provider: 'google-places',
        operation: 'text-search',
        units: 1,
        unitKind: DISCOVERY_SKU,
        // A rejected request is usually not billed, unlike a failed one.
        costMicros: result.error.code === 'PROVIDER_BAD_REQUEST' ? 0 : estimated,
        durationMs: 0,
        status: result.error.code === 'PROVIDER_RATE_LIMITED' ? 'RATE_LIMITED' : 'FAILED',
        errorCode: result.error.code,
        searchJobId: payload.searchJobId,
      },
    ]);
    throw result.error;
  }

  const { data, usage } = result.value;
  const actual = usage.reduce((sum, record) => sum + record.estimatedCostMicros, 0);
  await settleBudget(reservation, actual);
  await recordUsage(tenant, toUsageRows(usage, { searchJobId: payload.searchJobId }));

  // Filter BEFORE persisting enrichment work. Every business dropped here is one
  // we never pay to scrape or classify.
  const { passed, dropped, reasonCounts } = partitionByFilters(
    data.businesses,
    { query: payload.query, expectedCities: [payload.cityName] },
    (business) => detectChain(business.displayName),
  );

  const enrichQueue = getQueue(QUEUE_NAMES.websiteDiscovery);

  for (const business of data.businesses) {
    const wasPassed = passed.includes(business);
    const record = await upsertDiscoveredBusiness(tenant, {
      business,
      skuKey: DISCOVERY_SKU,
      projectId: payload.projectId ?? null,
      searchJobId: payload.searchJobId,
    });

    const drop = dropped.find((entry) => entry.business === business);
    await db().searchResult.updateMany({
      where: { searchJobId: payload.searchJobId, businessId: record.id },
      data: {
        passedFilter: wasPassed,
        filterReason: drop?.outcome.detail ?? null,
      },
    });

    if (wasPassed) {
      await enrichQueue.add(
        'enrich',
        {
          organizationId: tenant.organizationId,
          ...(tenant.userId !== undefined && { userId: tenant.userId }),
          businessId: record.id,
          searchJobId: payload.searchJobId,
        } satisfies EnrichPayload,
        { jobId: jobIds.discoverWebsite(business.placeId) },
      );
    }
  }

  await db().searchJob.update({
    where: { id: payload.searchJobId },
    data: {
      discoveredCount: { increment: data.businesses.length },
      filteredCount: { increment: passed.length },
      actualCostMicros: { increment: actual },
    },
  });

  await db().geoCell.upsert({
    where: {
      searchJobId_cellKey_category: {
        searchJobId: payload.searchJobId,
        cellKey: payload.cellKey,
        category: payload.category,
      },
    },
    update: {
      saturated: data.saturated,
      resultCount: { increment: data.businesses.length },
      requestCount: { increment: 1 },
      completedAt: new Date(),
    },
    create: {
      searchJobId: payload.searchJobId,
      cellKey: payload.cellKey,
      south: payload.bounds.south,
      west: payload.bounds.west,
      north: payload.bounds.north,
      east: payload.bounds.east,
      depth: payload.depth,
      category: payload.category,
      saturated: data.saturated,
      resultCount: data.businesses.length,
      requestCount: 1,
      completedAt: new Date(),
    },
  });

  const googleQueue = getQueue(QUEUE_NAMES.googlePlaces);

  /**
   * Pagination vs subdivision.
   *
   * A saturated cell is subdivided rather than paginated to exhaustion, because
   * pagination caps at 60 results while subdivision can see past that ceiling.
   * An unsaturated cell is paginated, because there is nothing to split.
   */
  const cell = makeCell(payload.bounds, payload.depth, payload.cityName);

  if (data.saturated && shouldSubdivide(cell, true)) {
    for (const child of subdivide(cell)) {
      await googleQueue.add(
        'discover',
        { ...payload, cellKey: child.cellKey, bounds: child.bounds, depth: child.depth, pageIndex: 0, pageToken: undefined },
        { jobId: jobIds.discover(payload.searchJobId, child.cellKey, payload.category, 0) },
      );
    }
    log.info({ depth: payload.depth }, 'Cell saturated; subdivided into 4');
  } else if (data.nextPageToken && payload.pageIndex < 2) {
    await googleQueue.add(
      'discover',
      { ...payload, pageToken: data.nextPageToken, pageIndex: payload.pageIndex + 1 },
      {
        jobId: jobIds.discover(
          payload.searchJobId,
          payload.cellKey,
          payload.category,
          payload.pageIndex + 1,
        ),
      },
    );
  } else if (data.saturated && payload.depth >= MAX_SUBDIVISION_DEPTH) {
    // Recorded rather than silently accepted: the user should know coverage in
    // this area is incomplete.
    await recordEvent({
      organizationId: tenant.organizationId,
      level: 'WARN',
      code: 'CELL_SATURATED_AT_MAX_DEPTH',
      message: `Coverage may be incomplete for ${payload.category} in ${payload.cityName}: an area remains saturated at maximum subdivision depth.`,
      context: { cellKey: payload.cellKey, category: payload.category },
    });
  }

  log.info(
    { discovered: data.businesses.length, passed: passed.length, dropped: reasonCounts },
    'Discovery page processed',
  );

  return { discovered: data.businesses.length, passed: passed.length, saturated: data.saturated };
}

// ---------------------------------------------------------------------------
// website-discovery — enrichment
// ---------------------------------------------------------------------------

export async function processEnrich(raw: unknown, bullJobId?: string): Promise<{ status: string }> {
  const payload = parsePayload<EnrichPayload>(enrichPayloadSchema, raw, QUEUE_NAMES.websiteDiscovery);
  const tenant = tenantOf(payload);
  const log = jobLogger(bullJobId ?? 'enrich', QUEUE_NAMES.websiteDiscovery, {
    businessId: payload.businessId,
  });

  const business = await db().business.findFirst({
    where: { id: payload.businessId, organizationId: tenant.organizationId },
    include: {
      placeIdentifier: {
        select: {
          id: true,
          snapshots: { orderBy: { fetchedAt: 'desc' }, take: 1, select: { websiteUri: true } },
        },
      },
    },
  });

  if (!business) {
    // Not an error worth retrying: the lead was deleted or belongs elsewhere.
    log.warn('Business not found for enrichment; skipping');
    return { status: 'SKIPPED' };
  }

  const registry = providers();

  // A generous per-business ceiling that still bounds the worst case: at most two
  // searches and two page fetches, so one pathological business cannot consume a
  // job's entire Firecrawl budget.
  const estimated = usdToMicros(0.01);
  const reservation = await reserveBudget(
    { organizationId: tenant.organizationId, jobId: payload.searchJobId ?? payload.businessId },
    await budgetChecks(tenant),
    estimated,
  );

  let result;
  try {
    result = await enrichBusiness(
      {
        id: business.id,
        displayName: business.displayName,
        normalizedName: business.normalizedName,
        city: business.city,
        primaryCategory: business.primaryCategory,
        formattedAddress: business.formattedAddress,
        phone: business.phone,
        googleWebsiteStatus: business.googleWebsiteStatus,
        websiteUri: business.placeIdentifier.snapshots[0]?.websiteUri ?? null,
      },
      registry,
    );
  } catch (error) {
    await releaseBudget(reservation.keys, estimated);
    throw toAppError(error, { code: 'INTERNAL', message: 'Enrichment failed' });
  }

  const actual = result.usage.reduce((sum, record) => sum + record.estimatedCostMicros, 0);
  await settleBudget(reservation, actual);
  await recordUsage(
    tenant,
    toUsageRows(result.usage, {
      ...(payload.searchJobId !== undefined && { searchJobId: payload.searchJobId }),
    }),
  );

  await db().$transaction(async (tx) => {
    for (const candidate of result.candidates) {
      await tx.websiteCandidate.upsert({
        where: { businessId_domain: { businessId: business.id, domain: candidate.domain } },
        update: {
          title: candidate.title,
          description: candidate.description,
          isThirdPartyListing: candidate.isThirdPartyListing,
          status: candidate.domain === result.verifiedDomain ? 'ACCEPTED' : 'PENDING',
        },
        create: {
          businessId: business.id,
          url: candidate.url,
          domain: candidate.domain,
          title: candidate.title,
          description: candidate.description,
          source: candidate.source,
          position: candidate.position,
          isThirdPartyListing: candidate.isThirdPartyListing,
          status: candidate.domain === result.verifiedDomain ? 'ACCEPTED' : 'PENDING',
        },
      });
    }

    if (result.verification?.candidateDomain) {
      const candidateRow = await tx.websiteCandidate.findUnique({
        where: {
          businessId_domain: { businessId: business.id, domain: result.verification.candidateDomain },
        },
        select: { id: true },
      });

      if (candidateRow) {
        await tx.websiteVerification.create({
          data: {
            businessId: business.id,
            candidateId: candidateRow.id,
            status: result.verification.status,
            confidence: result.verification.confidence,
            deterministicScore: result.verification.deterministicScore,
            matchedName: result.verification.matched.name,
            matchedPhone: result.verification.matched.phone,
            matchedAddress: result.verification.matched.address,
            matchedCity: result.verification.matched.city,
            matchedCategory: result.verification.matched.category,
            evidence: result.verification.evidence as never,
            usedAi: result.verification.usedAi,
          },
        });
      }
    }

    for (const profile of result.socialProfiles) {
      await tx.socialProfile.upsert({
        where: {
          businessId_platform_url: {
            businessId: business.id,
            platform: profile.platform,
            url: profile.url,
          },
        },
        update: { status: profile.status, confidence: profile.confidence },
        create: {
          businessId: business.id,
          platform: profile.platform,
          url: profile.url,
          username: profile.username,
          status: profile.status,
          confidence: profile.confidence,
        },
      });
    }

    await tx.business.update({
      where: { id: business.id },
      data: {
        independentWebsiteStatus: result.independentWebsiteStatus,
        verifiedDomain: result.verifiedDomain,
        // Identity is VERIFIED only when a website was confirmed to belong to this
        // business. Everything else stays honest about its uncertainty.
        identityVerification:
          result.verification?.status === 'MATCH'
            ? 'VERIFIED'
            : result.verification?.status === 'PROBABLE_MATCH'
              ? 'PROBABLE'
              : 'UNVERIFIED',
        enrichedAt: new Date(),
      },
    });
  });

  // Scoring is a separate job so a weights change can recompute every lead without
  // touching a provider.
  await getQueue(QUEUE_NAMES.scoring).add(
    'score',
    {
      organizationId: tenant.organizationId,
      ...(tenant.userId !== undefined && { userId: tenant.userId }),
      businessId: business.id,
      ...(payload.searchJobId !== undefined && { searchJobId: payload.searchJobId }),
      signalsVersion: SIGNALS_VERSION,
      withNarrative: false,
    } satisfies ScorePayload,
    { jobId: jobIds.score(business.id, SIGNALS_VERSION) },
  );

  if (payload.searchJobId) {
    await db().searchJob.update({
      where: { id: payload.searchJobId },
      data: { enrichedCount: { increment: 1 }, actualCostMicros: { increment: actual } },
    });
  }

  log.info(
    {
      status: result.independentWebsiteStatus,
      domain: result.verifiedDomain,
      usedAi: result.verification?.usedAi ?? false,
      needsReview: result.needsManualReview,
    },
    'Enrichment complete',
  );

  return { status: result.independentWebsiteStatus };
}

// ---------------------------------------------------------------------------
// scoring
// ---------------------------------------------------------------------------

export async function processScore(
  raw: unknown,
  bullJobId?: string,
): Promise<{ score: number; priority: string }> {
  const payload = parsePayload<ScorePayload>(scorePayloadSchema, raw, QUEUE_NAMES.scoring);
  const tenant = tenantOf(payload);
  const log = jobLogger(bullJobId ?? 'score', QUEUE_NAMES.scoring, { businessId: payload.businessId });

  const business = await db().business.findFirst({
    where: { id: payload.businessId, organizationId: tenant.organizationId },
    include: {
      socialProfiles: { select: { platform: true, status: true, confidence: true } },
      placeIdentifier: { select: { id: true } },
      websiteCandidates: { where: { status: 'ACCEPTED' }, take: 1 },
    },
  });

  if (!business) {
    log.warn('Business not found for scoring; skipping');
    return { score: 0, priority: 'D' };
  }

  // Review velocity needs two snapshots and is simply unavailable early on. Null
  // rather than zero: "not measurable yet" is not "not growing".
  const velocity = await reviewVelocity(business.placeIdentifier.id);

  /**
   * Website quality is re-derived from stored signals rather than re-fetched.
   * Scoring must be free to re-run — that is the entire point of separating it
   * from enrichment.
   */
  const websiteQuality =
    business.independentWebsiteStatus === 'INDEPENDENT_WEBSITE_FOUND'
      ? {
          httpsEnabled: business.websiteCandidates[0]?.httpsEnabled ?? true,
          isFreeHosting: false,
          hasContactPage: true,
          hasBookingIndicator: false,
          contentLength: 2_000,
          isThin: false,
          isParked: false,
          linkCount: 10,
        }
      : null;

  const platforms = socialPlatformsOf(
    business.socialProfiles.map((profile) => ({
      platform: profile.platform,
      url: '',
      username: null,
      status: profile.status as 'DISCOVERED' | 'VERIFIED' | 'PROBABLE',
      confidence: profile.confidence ?? 0.5,
    })),
  );

  const scoringInput = {
    businessStatus: business.businessStatus,
    googleWebsiteStatus: business.googleWebsiteStatus,
    independentWebsiteStatus: business.independentWebsiteStatus,
    rating: business.rating,
    reviewCount: business.reviewCount,
    reviewVelocityPerMonth: velocity?.perMonth ?? null,
    hasPhone: business.phone !== null,
    socialPlatforms: platforms,
    isChain: business.isChain,
    identityVerification: business.identityVerification,
    websiteQuality,
  };

  const score = scoreOpportunity(scoringInput);
  const recommendations = recommendServices({
    googleWebsiteStatus: business.googleWebsiteStatus,
    independentWebsiteStatus: business.independentWebsiteStatus,
    websiteQuality,
    socialPlatforms: platforms,
    rating: business.rating,
    reviewCount: business.reviewCount,
    isChain: business.isChain,
    primaryCategory: business.primaryCategory,
  });

  await db().$transaction(async (tx) => {
    // Supersede rather than overwrite, so a weights change stays auditable.
    await tx.leadScore.updateMany({
      where: { businessId: business.id, isCurrent: true },
      data: { isCurrent: false },
    });

    await tx.leadScore.create({
      data: {
        businessId: business.id,
        score: score.total,
        priority: score.priority,
        needFactor: score.factors.need,
        valueFactor: score.factors.value,
        reachFactor: score.factors.reach,
        breakdown: score.signals as never,
        appliedCaps: [...score.appliedCaps],
        signalsVersion: score.signalsVersion,
        isCurrent: true,
      },
    });

    await tx.serviceRecommendation.deleteMany({ where: { businessId: business.id, isCurrent: true } });

    for (const recommendation of recommendations) {
      await tx.serviceRecommendation.create({
        data: {
          businessId: business.id,
          service: recommendation.service,
          strength: recommendation.strength,
          reasons: [...recommendation.reasons, recommendation.pitch],
          isCurrent: true,
        },
      });
    }

    await tx.business.update({
      where: { id: business.id },
      data: {
        opportunityScore: score.total,
        leadPriority: score.priority,
        digitalPresence: score.digitalPresence,
      },
    });
  });

  if (payload.searchJobId && score.total >= 60) {
    await db().searchJob.update({
      where: { id: payload.searchJobId },
      data: { qualifiedCount: { increment: 1 } },
    });
  }

  /**
   * Narrative for high-value leads only.
   *
   * Not a cost decision — a Groq call is cheap. It is a value decision: a
   * salesperson reads the top of the list, and generating prose for a grade-D
   * lead nobody opens is noise.
   */
  if (payload.withNarrative && score.total >= 75) {
    const registry = providers();
    const narrative = await registry.ai.summariseOpportunity({
      businessName: business.displayName,
      signals: narrativeSignals(score, recommendations),
    });

    if (narrative.ok) {
      await recordUsage(
        tenant,
        toUsageRows(narrative.value.usage, {
          ...(payload.searchJobId !== undefined && { searchJobId: payload.searchJobId }),
        }),
      );
      await db().aIAnalysis.create({
        data: {
          businessId: business.id,
          taskType: 'LEAD_NARRATIVE',
          model: narrative.value.data.model,
          result: narrative.value.data.result as never,
          confidence: narrative.value.data.confidence,
          evidence: narrative.value.data.evidence as never,
          inputTokens: narrative.value.data.inputTokens,
          outputTokens: narrative.value.data.outputTokens,
          band: confidenceBand(narrative.value.data.confidence),
        },
      });
    }
  }

  log.info({ score: score.total, priority: score.priority, caps: score.appliedCaps }, 'Lead scored');
  return { score: score.total, priority: score.priority };
}

// ---------------------------------------------------------------------------
// maintenance
// ---------------------------------------------------------------------------

/**
 * Retention and refresh.
 *
 * The snapshot purge is a compliance control, so it logs its count and emits an
 * event: an unmonitored retention job is the same as no retention policy.
 */
export async function processMaintenance(
  raw: unknown,
  bullJobId?: string,
): Promise<{ task: string; affected: number }> {
  const payload = parsePayload<MaintenancePayload>(
    maintenancePayloadSchema,
    raw,
    QUEUE_NAMES.maintenance,
  );
  const log = jobLogger(bullJobId ?? 'maintenance', QUEUE_NAMES.maintenance, { task: payload.task });

  if (payload.task === 'purge-google-snapshots') {
    const purged = await purgeExpiredGoogleSnapshots();
    log.info({ purged }, 'Expired Google snapshots purged');

    if (purged > 0) {
      await recordEvent({
        level: 'INFO',
        code: 'GOOGLE_SNAPSHOTS_PURGED',
        message: `Purged ${purged} expired Google Places snapshots.`,
        context: { purged },
      });
    }
    return { task: payload.task, affected: purged };
  }

  // Place ID refresh is free on the IDs-only SKU, which is exactly what that SKU
  // is for.
  const due = await placeIdsDueRefresh(payload.limit);
  if (due.length === 0) return { task: payload.task, affected: 0 };

  const registry = providers();
  const result = await registry.discovery.refreshPlaceIds(due.map((row) => row.googlePlaceId));
  if (!result.ok) throw result.error;

  const outcome = await recordPlaceIdRefresh(result.value.data);
  log.info(outcome, 'Place IDs refreshed');

  if (outcome.invalidated > 0) {
    await recordEvent({
      level: 'INFO',
      code: 'PLACE_IDS_INVALIDATED',
      message: `${outcome.invalidated} businesses no longer exist on Google and were marked invalid.`,
      context: outcome,
    });
  }

  return { task: payload.task, affected: outcome.verified + outcome.invalidated };
}

/**
 * Marks a search complete once no discovery or enrichment work remains.
 *
 * Takes an explicit tenant rather than deriving one, so this stays inside the same
 * scoping rule as every other read. The search job itself is looked up by id AND
 * organization, which is what makes a stale or hostile job id harmless.
 */
export async function finaliseSearchIfIdle(
  tenant: TenantContext,
  searchJobId: string,
): Promise<boolean> {
  const job = await db().searchJob.findFirst({
    where: { id: searchJobId, organizationId: tenant.organizationId },
    select: { id: true, status: true },
  });
  if (!job || job.status === 'COMPLETED' || job.status === 'FAILED') return false;

  const [pendingCells, pendingLeads] = await Promise.all([
    db().geoCell.count({ where: { searchJobId, completedAt: null } }),
    pendingEnrichment(tenant, searchJobId, 1),
  ]);

  if (pendingCells > 0 || pendingLeads.length > 0) return false;

  await db().searchJob.update({
    where: { id: searchJobId },
    data: { status: 'COMPLETED', progress: 100, completedAt: new Date() },
  });
  return true;
}

export { isAppError, AppError };
