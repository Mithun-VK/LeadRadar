/**
 * PATCH  /api/activities/{id} — update or complete.
 * DELETE /api/activities/{id} — remove, or cancel if it already happened.
 */
import { z } from 'zod';

import { notFound } from '@/lib/errors';
import { handler } from '@/modules/api/handler';
import { deleteActivity, parseDueAt, updateActivity } from '@/modules/crm/activities';

const bodySchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(4_000).nullable().optional(),
    status: z.enum(['OPEN', 'COMPLETED', 'CANCELLED']).optional(),
    dueAt: z.string().nullable().optional(),
    assignedToUserId: z.string().min(1).nullable().optional(),
  })
  .strict();

export const PATCH = handler(
  async ({ tenant, params, body }) => {
    const activity = await updateActivity(tenant, params.id!, {
      ...(body.title !== undefined && { title: body.title }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.status !== undefined && { status: body.status }),
      ...(body.dueAt !== undefined && { dueAt: body.dueAt === null ? null : parseDueAt(body.dueAt) }),
      ...(body.assignedToUserId !== undefined && { assignedToUserId: body.assignedToUserId }),
    });

    return {
      id: activity.id,
      status: activity.status,
      completedAt: activity.completedAt,
      dueAt: activity.dueAt,
    };
  },
  { bodySchema, auditAction: 'activity.update' },
);

export const DELETE = handler(
  async ({ tenant, params }) => {
    const removed = await deleteActivity(tenant, params.id!);
    if (!removed) throw notFound('Activity', { activityId: params.id });

    return { removed: true };
  },
  { auditAction: 'activity.delete' },
);
