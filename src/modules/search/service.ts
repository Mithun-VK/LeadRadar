/**
 * Search service — the seam between HTTP and the queue.
 *
 * Parsing and execution are deliberately separate operations. `parse` has no side
 * effects and costs one cheap Groq call; `execute` commits real spend. The user
 * sees the parsed criteria and the cost estimate, then decides. Fusing them would
 * mean a typo becomes a bill.
 */
import { AppError } from '@/lib/errors';
import { env } from '@/lib/env';
import { db, type TenantContext } from '@/modules/database/client';
import { recordAudit, recordUsage } from '@/modules/database/repositories';
import { getQueue, QUEUE_NAMES } from '@/modules/jobs/queues';
import { providers } from '@/modules/providers/registry';
import { confidenceBand, type StructuredQuery } from '@/types/domain';
import { structuredQuerySchema } from '@/schemas/query';

import { estimateSearchCost, type CostEstimate } from './cost-estimator';
import { knownCityNames, resolveCity } from './geography';

export interface ParseResult {
  readonly query: StructuredQuery;
  readonly confidence: number;
  readonly band: 'accept' | 'secondary' | 'manual';
  readonly estimate: CostEstimate;
  /** Locations we could not resolve, so the UI can say so before spending. */
  readonly unresolvedLocations: readonly string[];
  readonly knownCities: readonly string[];
  readonly evidence: readonly string[];
}

/**
 * Parses natural language into a validated query and prices it.
 *
 * No side effects and no discovery spend. The only cost is one Groq call, which is
 * cheaper than a single page fetch.
 */
export async function parseSearchQuery(
  tenant: TenantContext,
  rawQuery: string,
): Promise<ParseResult> {
  const registry = providers();
  const result = await registry.ai.parseQuery(rawQuery);

  if (!result.ok) {
    throw new AppError({
      code: 'QUERY_UNPARSEABLE',
      message: `Query parsing failed: ${result.error.message}`,
      safeMessage:
        'That search could not be understood. Try naming a business type and a city, ' +
        'for example: "dental clinics in Chennai with no website and 50+ reviews".',
      cause: result.error,
    });
  }

  await recordUsage(
    tenant,
    result.value.usage.map((record) => ({
      provider: record.provider,
      operation: record.operation,
      units: record.units,
      unitKind: record.unitKind,
      costMicros: record.estimatedCostMicros,
      durationMs: record.durationMs,
      status: 'SUCCESS' as const,
      ...(record.inputTokens !== undefined && { inputTokens: record.inputTokens }),
      ...(record.outputTokens !== undefined && { outputTokens: record.outputTokens }),
      mocked: record.mocked,
    })),
  );

  const verdict = result.value.data;

  // Re-validated even though the provider already did: defence in depth at the
  // boundary where the query becomes executable.
  const validated = structuredQuerySchema.safeParse(verdict.result);
  if (!validated.success) {
    throw new AppError({
      code: 'AI_SCHEMA_VIOLATION',
      message: `Parsed query failed validation: ${validated.error.message}`,
      safeMessage: 'That search could not be turned into valid filters. Try rephrasing it.',
    });
  }

  const query = validated.data;
  const unresolved = query.locations.filter((location) => resolveCity(location) === null);

  return {
    query,
    confidence: verdict.confidence,
    band: confidenceBand(verdict.confidence),
    estimate: estimateSearchCost(query, { maxResults: env().MAX_RESULTS_PER_SEARCH }),
    unresolvedLocations: unresolved,
    knownCities: knownCityNames(),
    evidence: verdict.evidence,
  };
}

export interface ExecuteOptions {
  readonly projectId?: string | null;
  /** Client must echo the estimate it saw, so it cannot be surprised by a change. */
  readonly acknowledgedCostMicros?: number;
}

/**
 * Creates a SearchJob and enqueues the coordinator.
 *
 * The estimate is recomputed server-side and compared with what the client
 * acknowledged. A client that saw a different number gets rejected rather than
 * silently charged more — the acknowledgement is a consent record, not decoration.
 */
export async function executeSearch(
  tenant: TenantContext,
  rawQuery: string,
  query: StructuredQuery,
  options: ExecuteOptions = {},
): Promise<{ searchJobId: string; estimate: CostEstimate }> {
  const config = env();
  const estimate = estimateSearchCost(query, { maxResults: config.MAX_RESULTS_PER_SEARCH });

  if (
    options.acknowledgedCostMicros !== undefined &&
    estimate.totalCostMicros > options.acknowledgedCostMicros * 1.25
  ) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: `Estimate changed materially since it was shown (${options.acknowledgedCostMicros} -> ${estimate.totalCostMicros})`,
      safeMessage:
        'The cost estimate for this search has changed. Please review the new estimate and run it again.',
    });
  }

  if (estimate.assumptions.cities === 0) {
    throw new AppError({
      code: 'UNSUPPORTED_QUERY',
      message: 'No locations in the query resolve to a known city',
      safeMessage: `None of those locations are supported yet. Currently available: ${knownCityNames().join(', ')}.`,
    });
  }

  if (estimate.googleRequests > config.MAX_GOOGLE_REQUESTS_PER_JOB) {
    throw new AppError({
      code: 'JOB_LIMIT_EXCEEDED',
      message: `Estimated ${estimate.googleRequests} Google requests exceeds the per-job limit of ${config.MAX_GOOGLE_REQUESTS_PER_JOB}`,
      safeMessage:
        `This search would need about ${estimate.googleRequests} discovery requests, above the ` +
        `configured per-job limit of ${config.MAX_GOOGLE_REQUESTS_PER_JOB}. Narrow the cities or categories.`,
    });
  }

  const job = await db().searchJob.create({
    data: {
      organizationId: tenant.organizationId,
      projectId: options.projectId ?? null,
      createdByUserId: tenant.userId ?? null,
      rawQuery,
      structuredQuery: query as never,
      status: 'PENDING',
      estimatedGoogleRequests: estimate.googleRequests,
      estimatedFirecrawlCredits: estimate.firecrawlCredits,
      estimatedGroqCalls: estimate.groqCalls,
      estimatedCostMicros: estimate.totalCostMicros,
    },
    select: { id: true },
  });

  await getQueue(QUEUE_NAMES.search).add(
    'search',
    {
      organizationId: tenant.organizationId,
      ...(tenant.userId !== undefined && { userId: tenant.userId }),
      searchJobId: job.id,
      projectId: options.projectId ?? null,
      query,
    },
    { jobId: `search~${job.id}` },
  );

  await recordAudit(tenant, {
    action: 'search.created',
    resourceType: 'SearchJob',
    resourceId: job.id,
    metadata: {
      categories: query.categories,
      locations: query.locations,
      estimatedCostMicros: estimate.totalCostMicros,
    },
  });

  return { searchJobId: job.id, estimate };
}

/** Job status plus observed-versus-estimated cost, for the progress view. */
export async function getSearchStatus(tenant: TenantContext, searchJobId: string) {
  const job = await db().searchJob.findFirst({
    where: { id: searchJobId, organizationId: tenant.organizationId },
    include: {
      cells: { select: { saturated: true, completedAt: true, requestCount: true } },
    },
  });

  if (!job) {
    throw new AppError({
      code: 'NOT_FOUND',
      message: `Search job ${searchJobId} not found`,
      safeMessage: 'That search could not be found.',
    });
  }

  const cellsTotal = job.cells.length;
  const cellsDone = job.cells.filter((cell) => cell.completedAt !== null).length;

  // Discovery is roughly the first 40% of wall time; enrichment dominates the rest.
  const discoveryProgress = cellsTotal > 0 ? (cellsDone / cellsTotal) * 40 : 0;
  const enrichmentProgress =
    job.filteredCount > 0 ? Math.min(60, (job.enrichedCount / job.filteredCount) * 60) : 0;

  const progress =
    job.status === 'COMPLETED'
      ? 100
      : Math.min(99, Math.round(discoveryProgress + enrichmentProgress));

  return {
    id: job.id,
    status: job.status,
    progress,
    statusMessage: job.statusMessage,
    rawQuery: job.rawQuery,
    counts: {
      discovered: job.discoveredCount,
      filtered: job.filteredCount,
      enriched: job.enrichedCount,
      qualified: job.qualifiedCount,
    },
    cost: {
      estimatedMicros: job.estimatedCostMicros,
      actualMicros: job.actualCostMicros,
      // Surfaced so a systematically wrong estimate is visible rather than buried.
      varianceRatio:
        job.estimatedCostMicros > 0
          ? Number((job.actualCostMicros / job.estimatedCostMicros).toFixed(2))
          : null,
    },
    cells: { total: cellsTotal, completed: cellsDone, saturated: job.cells.filter((c) => c.saturated).length },
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    errorCode: job.errorCode,
  };
}
