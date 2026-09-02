/**
 * GET  /api/leads/{id}/activities — the lead's timeline.
 * POST /api/leads/{id}/activities — log something, or schedule it.
 */
import { z } from 'zod';

import { handler } from '@/modules/api/handler';
import {
  ACTIVITY_TYPE_LABELS,
  createActivity,
  listActivitiesForLead,
  parseDueAt,
  type ActivityType,
} from '@/modules/crm/activities';

const TYPES = Object.keys(ACTIVITY_TYPE_LABELS) as [ActivityType, ...ActivityType[]];

export const GET = handler(async ({ tenant, params }) => {
  const activities = await listActivitiesForLead(tenant, params.id!);

  return {
    rows: activities.map((activity) => ({
      id: activity.id,
      type: activity.type,
      typeLabel: ACTIVITY_TYPE_LABELS[activity.type as ActivityType],
      title: activity.title,
      description: activity.description,
      status: activity.status,
      dueAt: activity.dueAt,
      completedAt: activity.completedAt,
      createdBySystem: activity.createdBySystem,
      assignedTo: activity.assignedTo?.name ?? activity.assignedTo?.email ?? null,
      deal: activity.deal,
      createdAt: activity.createdAt,
    })),
  };
});

const bodySchema = z
  .object({
    type: z.enum(TYPES),
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(4_000).optional(),
    dueAt: z.string().optional(),
    dealId: z.string().min(1).optional(),
  })
  .strict();

export const POST = handler(
  async ({ tenant, params, body }) => {
    const activity = await createActivity(tenant, {
      businessId: params.id!,
      type: body.type,
      title: body.title,
      ...(body.description !== undefined && { description: body.description }),
      dueAt: parseDueAt(body.dueAt),
      ...(body.dealId !== undefined && { dealId: body.dealId }),
    });

    return {
      id: activity.id,
      type: activity.type,
      title: activity.title,
      status: activity.status,
      dueAt: activity.dueAt,
    };
  },
  { bodySchema, auditAction: 'activity.create', rateLimit: { capacity: 60, refillPerSecond: 1 } },
);
