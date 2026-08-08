/**
 * POST /api/export — queues an export.
 *
 * The Google-derived opt-in requires an explicit acknowledgement in the request
 * body. Without it the export is silently downgraded to the safe column set and the
 * response says so — the caller is never left guessing why a column is missing.
 */
import { z } from 'zod';

import { handler } from '@/modules/api/handler';
import { db } from '@/modules/database/client';
import { recordAudit } from '@/modules/database/repositories';
import { getQueue, QUEUE_NAMES } from '@/modules/jobs/queues';
import { jobIds } from '@/lib/ids';
import { decidePolicy } from '@/modules/export/policy';

const csvList = z.array(z.string().trim().min(1).max(60)).max(40).optional();

const bodySchema = z
  .object({
    format: z.enum(['CSV', 'XLSX']),
    filters: z
      .object({
        city: csvList,
        category: csvList,
        priority: csvList,
        service: csvList,
        digitalPresence: csvList,
        independentWebsiteStatus: csvList,
        googleWebsiteStatus: csvList,
        minScore: z.number().int().min(0).max(100).optional(),
        minRating: z.number().min(0).max(5).optional(),
        minReviews: z.number().int().min(0).optional(),
        excludeChains: z.boolean().optional(),
        searchJobId: z.string().min(1).optional(),
      })
      .strict()
      .default({}),
    columns: csvList,
    includeGoogleDerived: z.boolean().default(false),
    /**
     * Must be true to receive Google-derived columns. A separate flag rather than
     * an implicit consequence of the request, because it records a decision.
     */
    acknowledgeGoogleTerms: z.boolean().default(false),
  })
  .strict();

export const POST = handler(
  async ({ tenant, body }) => {
    const decision = decidePolicy({
      includeGoogleDerived: body.includeGoogleDerived,
      acknowledgedTerms: body.acknowledgeGoogleTerms,
    });

    const job = await db().exportJob.create({
      data: {
        organizationId: tenant.organizationId,
        createdByUserId: tenant.userId ?? null,
        format: body.format,
        filters: body.filters as never,
        columns: body.columns ?? [],
        includesGoogleDerived: decision.policy === 'with-google-derived',
      },
      select: { id: true },
    });

    await getQueue(QUEUE_NAMES.export).add(
      'export',
      {
        organizationId: tenant.organizationId,
        ...(tenant.userId !== undefined && { userId: tenant.userId }),
        exportJobId: job.id,
      },
      { jobId: jobIds.export(job.id) },
    );

    await recordAudit(tenant, {
      action: 'export.requested',
      resourceType: 'ExportJob',
      resourceId: job.id,
      metadata: {
        format: body.format,
        policy: decision.policy,
        includesGoogleDerived: decision.policy === 'with-google-derived',
        acknowledged: body.acknowledgeGoogleTerms,
      },
    });

    return {
      exportJobId: job.id,
      policy: decision.policy,
      columns: decision.columns.map((column) => ({
        key: column.key,
        header: column.header,
        provenance: column.provenance,
      })),
      excludedColumns: decision.excludedColumns.map((column) => column.header),
      warnings: decision.warnings,
    };
  },
  { bodySchema, rateLimit: { capacity: 10, refillPerSecond: 0.1 } },
);
