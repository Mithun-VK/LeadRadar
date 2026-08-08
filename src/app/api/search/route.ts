/**
 * POST /api/search — commits a search to the queue.
 * GET  /api/search — recent searches for the tenant.
 */
import { z } from 'zod';

import { handler } from '@/modules/api/handler';
import { db } from '@/modules/database/client';
import { structuredQuerySchema } from '@/schemas/query';
import { executeSearch } from '@/modules/search/service';

const createSchema = z
  .object({
    rawQuery: z.string().trim().min(3).max(1_000),
    query: structuredQuerySchema,
    projectId: z.string().min(1).nullable().optional(),
    /**
     * The estimate the user actually saw. Compared server-side so a stale client
     * cannot silently authorise more spend than was shown.
     */
    acknowledgedCostMicros: z.number().int().nonnegative().optional(),
  })
  .strict();

export const POST = handler(
  async ({ tenant, body }) =>
    executeSearch(tenant, body.rawQuery, body.query, {
      projectId: body.projectId ?? null,
      ...(body.acknowledgedCostMicros !== undefined && {
        acknowledgedCostMicros: body.acknowledgedCostMicros,
      }),
    }),
  {
    bodySchema: createSchema,
    // Tighter than parse: each of these commits real money.
    rateLimit: { capacity: 5, refillPerSecond: 0.05 },
    auditAction: 'search.created',
  },
);

export const GET = handler(async ({ tenant }) => {
  const jobs = await db().searchJob.findMany({
    where: { organizationId: tenant.organizationId },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: {
      id: true,
      rawQuery: true,
      status: true,
      progress: true,
      discoveredCount: true,
      filteredCount: true,
      qualifiedCount: true,
      estimatedCostMicros: true,
      actualCostMicros: true,
      createdAt: true,
      completedAt: true,
    },
  });
  return { jobs };
});
