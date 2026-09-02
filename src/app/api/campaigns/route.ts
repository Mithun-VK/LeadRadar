/**
 * GET  /api/v1 campaigns — list.
 * POST /api/campaigns     — create a DRAFT.
 *
 * A newly created campaign is always DRAFT and always empty. There is no
 * parameter that creates one already running, and none that enrols leads at
 * creation time: activation must be a separate, deliberate act after a human has
 * seen what will be sent.
 */
import { z } from 'zod';

import { handler } from '@/modules/api/handler';
import { env } from '@/lib/env';
import { db } from '@/modules/database/client';
import { campaignStats, listCampaigns } from '@/modules/email/campaigns';

const csv = z
  .string()
  .optional()
  .transform((value) =>
    value
      ? value
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean)
      : undefined,
  );

const querySchema = z
  .object({
    status: csv,
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

export const GET = handler(
  async ({ tenant, query }) => {
    const result = await listCampaigns(tenant, {
      ...(query.status && { status: query.status }),
      ...(query.page !== undefined && { page: query.page }),
      ...(query.pageSize !== undefined && { pageSize: query.pageSize }),
    });

    return {
      ...result,
      rows: await Promise.all(
        result.rows.map(async (row) => ({
          id: row.id,
          name: row.name,
          description: row.description,
          status: row.status,
          templateName: row.template?.name ?? null,
          dailyLimit: row.dailyLimit,
          delaySeconds: row.delaySeconds,
          useAiPersonalization: row.useAiPersonalization,
          leadCount: row._count.leads,
          messageCount: row._count.messages,
          activatedAt: row.activatedAt,
          completedAt: row.completedAt,
          createdAt: row.createdAt,
          stats: await campaignStats(row.id),
        })),
      ),
    };
  },
  { querySchema },
);

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).optional(),
    templateId: z.string().min(1).optional(),
    senderName: z.string().trim().min(1).max(80).optional(),
    companyName: z.string().trim().min(1).max(120).optional(),
    /**
     * Bounded in the schema, not merely warned about in the UI. A four-figure
     * daily limit on a personal Gmail account does not send four thousand emails
     * — it gets the account rate limited, and possibly suspended.
     */
    dailyLimit: z.number().int().min(1).max(500).optional(),
    delaySeconds: z.number().int().min(5).max(86_400).optional(),
    useAiPersonalization: z.boolean().optional(),
  })
  .strict();

export const POST = handler(
  async ({ tenant, body }) => {
    const config = env();

    const campaign = await db().campaign.create({
      data: {
        organizationId: tenant.organizationId,
        createdByUserId: tenant.userId ?? null,
        name: body.name,
        description: body.description ?? null,
        templateId: body.templateId ?? null,
        senderName: body.senderName ?? null,
        companyName: body.companyName ?? null,
        dailyLimit: body.dailyLimit ?? Math.min(50, config.EMAIL_DAILY_LIMIT),
        // Never below the server's floor, whatever the request asked for.
        delaySeconds: Math.max(config.EMAIL_MIN_DELAY_SECONDS, body.delaySeconds ?? 120),
        useAiPersonalization: body.useAiPersonalization ?? false,
        // Always DRAFT. There is no code path that creates a running campaign.
        status: 'DRAFT',
      },
      select: { id: true, name: true, status: true, dailyLimit: true, delaySeconds: true },
    });

    return campaign;
  },
  {
    bodySchema: createSchema,
    auditAction: 'campaign.create',
    rateLimit: { capacity: 20, refillPerSecond: 0.2 },
  },
);
