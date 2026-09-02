/**
 * POST /api/leads/{id}/status — move a lead through the pipeline.
 * GET  /api/leads/{id}/status — its history.
 *
 * Every change is validated against the transition table and recorded, in one
 * transaction. There is no parameter that skips either.
 */
import { z } from 'zod';

import { handler } from '@/modules/api/handler';
import { changeLeadStatus, leadStatusHistory } from '@/modules/crm/leads';
import {
  LEAD_STATUS_LABELS,
  LEAD_STATUS_ORDER,
  allowedTransitions,
  type LeadStatus,
} from '@/modules/crm/lead-status';
import { db } from '@/modules/database/client';

export const GET = handler(async ({ tenant, params }) => {
  const [history, lead] = await Promise.all([
    leadStatusHistory(tenant, params.id!),
    db().business.findFirst({
      where: { id: params.id!, organizationId: tenant.organizationId },
      select: { leadStatus: true },
    }),
  ]);

  const current = (lead?.leadStatus ?? 'NEW') as LeadStatus;

  return {
    current,
    currentLabel: LEAD_STATUS_LABELS[current],
    // The UI renders exactly these as buttons, so an operator is never offered a
    // move the server would refuse.
    allowedNext: allowedTransitions(current).map((status) => ({
      status,
      label: LEAD_STATUS_LABELS[status],
    })),
    history: history.map((entry) => ({
      id: entry.id,
      fromStatus: entry.fromStatus,
      toStatus: entry.toStatus,
      reason: entry.reason,
      source: entry.source,
      by: entry.createdBy?.name ?? entry.createdBy?.email ?? null,
      createdAt: entry.createdAt,
    })),
  };
});

const bodySchema = z
  .object({
    status: z.enum(LEAD_STATUS_ORDER as unknown as [LeadStatus, ...LeadStatus[]]),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

export const POST = handler(
  async ({ tenant, params, body }) => {
    const result = await changeLeadStatus(tenant, {
      businessId: params.id!,
      to: body.status,
      ...(body.reason !== undefined && { reason: body.reason }),
      // Always USER from this route: a human clicked something. Worker-driven
      // changes go through applyLeadEvent and record SYSTEM or EMAIL.
      source: 'USER',
    });

    return {
      ...result,
      allowedNext: allowedTransitions(result.to).map((status) => ({
        status,
        label: LEAD_STATUS_LABELS[status],
      })),
    };
  },
  { bodySchema, auditAction: 'lead.status', rateLimit: { capacity: 60, refillPerSecond: 1 } },
);
