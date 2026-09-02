/**
 * Job payload schemas.
 *
 * Validated on the way in AND on the way out of Redis. That is not paranoia: a
 * payload written by a previous deployment can be replayed by a worker running new
 * code, so the queue is effectively an untyped external boundary and must be
 * treated as one.
 *
 * Every payload carries `organizationId`, so a worker can never operate without a
 * tenant, and `searchJobId` where applicable, so spend is always attributable.
 */
import { z } from 'zod';

import { AppError } from '@/lib/errors';
import { structuredQuerySchema } from '@/schemas/query';

const tenantFields = {
  organizationId: z.string().min(1),
  userId: z.string().min(1).optional(),
  requestId: z.string().min(1).optional(),
};

/** Coordinates one search: plans cells, then fans out discovery jobs. */
export const searchJobPayloadSchema = z
  .object({
    ...tenantFields,
    searchJobId: z.string().min(1),
    projectId: z.string().min(1).nullable().optional(),
    query: structuredQuerySchema,
  })
  .strict();

export type SearchJobPayload = z.infer<typeof searchJobPayloadSchema>;

/** One billable Text Search request: one cell, one category, one page. */
export const discoverPayloadSchema = z
  .object({
    ...tenantFields,
    searchJobId: z.string().min(1),
    projectId: z.string().min(1).nullable().optional(),
    category: z.string().min(1),
    cellKey: z.string().min(1),
    bounds: z
      .object({
        south: z.number().min(-90).max(90),
        west: z.number().min(-180).max(180),
        north: z.number().min(-90).max(90),
        east: z.number().min(-180).max(180),
      })
      .strict(),
    depth: z.number().int().min(0).max(6),
    cityName: z.string().min(1),
    regionCode: z.string().length(2),
    pageToken: z.string().optional(),
    pageIndex: z.number().int().min(0).max(2),
    query: structuredQuerySchema,
  })
  .strict();

export type DiscoverPayload = z.infer<typeof discoverPayloadSchema>;

/** Enriches one business: website discovery, verification, social. */
export const enrichPayloadSchema = z
  .object({
    ...tenantFields,
    businessId: z.string().min(1),
    searchJobId: z.string().min(1).optional(),
  })
  .strict();

export type EnrichPayload = z.infer<typeof enrichPayloadSchema>;

/** Scores one business. Cheap, deterministic, and re-runnable. */
export const scorePayloadSchema = z
  .object({
    ...tenantFields,
    businessId: z.string().min(1),
    searchJobId: z.string().min(1).optional(),
    /** Present so a weights change recomputes without re-spending API budget. */
    signalsVersion: z.string().min(1),
    /** Generate an AI narrative. Reserved for high-scoring leads. */
    withNarrative: z.boolean().default(false),
  })
  .strict();

export type ScorePayload = z.infer<typeof scorePayloadSchema>;

export const exportPayloadSchema = z
  .object({
    ...tenantFields,
    exportJobId: z.string().min(1),
  })
  .strict();

export type ExportPayload = z.infer<typeof exportPayloadSchema>;

/**
 * Sends one campaign email.
 *
 * Deliberately one lead per job rather than a batch. A batch job that fails
 * halfway leaves an ambiguous "which of these forty were sent?" — and resolving
 * that ambiguity wrongly means either a duplicate to a real person or a lead
 * silently never contacted. One lead per job makes the unit of retry the same as
 * the unit of delivery.
 */
export const sendEmailPayloadSchema = z
  .object({
    ...tenantFields,
    campaignId: z.string().min(1),
    businessId: z.string().min(1),
  })
  .strict();

export type SendEmailPayload = z.infer<typeof sendEmailPayloadSchema>;

/** Advances a running campaign: queues the next batch within its limits. */
export const campaignTickPayloadSchema = z
  .object({
    ...tenantFields,
    campaignId: z.string().min(1),
  })
  .strict();

export type CampaignTickPayload = z.infer<typeof campaignTickPayloadSchema>;

/** Synchronises one organization's connected mailbox. */
export const inboxSyncPayloadSchema = z
  .object({
    ...tenantFields,
    maxMessages: z.number().int().min(1).max(200).optional(),
  })
  .strict();

export type InboxSyncPayload = z.infer<typeof inboxSyncPayloadSchema>;

export const maintenancePayloadSchema = z
  .object({
    task: z.enum([
      'purge-google-snapshots',
      'refresh-place-ids',
      'campaign-scheduler',
      'inbox-sync',
      'purge-email-bodies',
    ]),
    limit: z.number().int().min(1).max(5_000).default(500),
  })
  .strict();

export type MaintenancePayload = z.infer<typeof maintenancePayloadSchema>;

/**
 * Parses a payload read from Redis.
 *
 * A payload that fails validation is unprocessable rather than transient — a
 * schema change means retrying will fail identically — so it is marked
 * non-retryable and goes straight to the dead-letter queue for inspection.
 */
export function parsePayload<T>(schema: z.ZodType<T>, raw: unknown, queue: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message:
        `Job payload on queue '${queue}' failed validation: ` +
        parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
      retryability: 'never',
      context: { queue },
    });
  }
  return parsed.data;
}
