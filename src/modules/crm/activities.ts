/**
 * Sales activities.
 *
 * One model covers both what happened and what is due, because the lead timeline
 * shows them interleaved. A separate "task" table would mean merging two sorted
 * lists in every view that matters, and the two would inevitably drift on things
 * like "who owns this".
 *
 * The system creates activities too — a classified pricing request raises
 * "Respond to pricing enquiry" rather than sending a price itself. That is the
 * human-in-the-loop boundary made concrete: automation produces WORK, a person
 * produces COMMITMENTS.
 */
import type { Prisma } from '@prisma/client';

import { AppError, notFound } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { db, type TenantContext } from '@/modules/database/client';

export type ActivityType =
  | 'EMAIL'
  | 'CALL'
  | 'MEETING'
  | 'NOTE'
  | 'FOLLOW_UP'
  | 'PROPOSAL'
  | 'TASK';

export type ActivityStatus = 'OPEN' | 'COMPLETED' | 'CANCELLED';

export const ACTIVITY_TYPE_LABELS: Record<ActivityType, string> = {
  EMAIL: 'Email',
  CALL: 'Call',
  MEETING: 'Meeting',
  NOTE: 'Note',
  FOLLOW_UP: 'Follow-up',
  PROPOSAL: 'Proposal',
  TASK: 'Task',
};

/**
 * Types that record something that already happened.
 *
 * These are created COMPLETED, because "an email was sent" is not a task someone
 * needs to tick off. Creating them OPEN would fill the work queue with history.
 */
const RETROSPECTIVE_TYPES: readonly ActivityType[] = ['EMAIL', 'NOTE'];

export interface CreateActivityInput {
  readonly businessId: string;
  readonly dealId?: string | null;
  readonly type: ActivityType;
  readonly title: string;
  readonly description?: string | null;
  readonly dueAt?: Date | null;
  readonly assignedToUserId?: string | null;
  readonly createdBySystem?: boolean;
}

export async function createActivity(
  tenant: TenantContext,
  input: CreateActivityInput,
  tx?: Prisma.TransactionClient,
) {
  const client = tx ?? db();

  const lead = await client.business.findFirst({
    where: { id: input.businessId, organizationId: tenant.organizationId },
    select: { id: true },
  });

  if (!lead) throw notFound('Lead', { businessId: input.businessId });

  const retrospective = RETROSPECTIVE_TYPES.includes(input.type) && !input.dueAt;

  return client.salesActivity.create({
    data: {
      organizationId: tenant.organizationId,
      businessId: lead.id,
      dealId: input.dealId ?? null,
      type: input.type,
      title: input.title,
      description: input.description ?? null,
      status: retrospective ? 'COMPLETED' : 'OPEN',
      completedAt: retrospective ? new Date() : null,
      dueAt: input.dueAt ?? null,
      assignedToUserId: input.assignedToUserId ?? tenant.userId ?? null,
      createdByUserId: tenant.userId ?? null,
      createdBySystem: input.createdBySystem ?? false,
    },
  });
}

/**
 * Creates a system activity only if an equivalent one is not already open.
 *
 * Without this, a lead who sends three messages asking about price gets three
 * identical "Respond to pricing enquiry" tasks, and the work queue becomes noise
 * that people stop reading. Keyed on type + title + lead, which is coarse but
 * matches how these are actually generated.
 */
export async function ensureSystemActivity(
  tenant: TenantContext,
  input: CreateActivityInput,
  tx?: Prisma.TransactionClient,
): Promise<{ created: boolean; id: string | null }> {
  const client = tx ?? db();

  const existing = await client.salesActivity.findFirst({
    where: {
      organizationId: tenant.organizationId,
      businessId: input.businessId,
      type: input.type,
      title: input.title,
      status: 'OPEN',
    },
    select: { id: true },
  });

  if (existing) return { created: false, id: existing.id };

  const activity = await createActivity(
    tenant,
    { ...input, createdBySystem: true },
    tx,
  );

  logger().info(
    { businessId: input.businessId, type: input.type, title: input.title },
    'System activity raised',
  );

  return { created: true, id: activity.id };
}

export interface UpdateActivityInput {
  readonly title?: string;
  readonly description?: string | null;
  readonly status?: ActivityStatus;
  readonly dueAt?: Date | null;
  readonly assignedToUserId?: string | null;
}

export async function updateActivity(
  tenant: TenantContext,
  activityId: string,
  input: UpdateActivityInput,
) {
  const existing = await db().salesActivity.findFirst({
    where: { id: activityId, organizationId: tenant.organizationId },
    select: { id: true, status: true },
  });

  if (!existing) throw notFound('Activity', { activityId });

  if (existing.status !== 'OPEN' && input.status === 'OPEN') {
    // Reopening is allowed; this guard only exists to make the intent explicit
    // rather than silently permitting it as a side effect.
    logger().info({ activityId }, 'Activity reopened');
  }

  const completing = input.status === 'COMPLETED' && existing.status !== 'COMPLETED';

  return db().salesActivity.update({
    where: { id: existing.id },
    data: {
      ...(input.title !== undefined && { title: input.title }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.status !== undefined && { status: input.status }),
      ...(input.dueAt !== undefined && { dueAt: input.dueAt }),
      ...(input.assignedToUserId !== undefined && { assignedToUserId: input.assignedToUserId }),
      // Stamped by the server, never taken from the client: a completion time a
      // caller can set is a completion time that can be backdated.
      ...(completing && { completedAt: new Date() }),
      ...(input.status === 'OPEN' && { completedAt: null }),
    },
  });
}

export async function deleteActivity(tenant: TenantContext, activityId: string): Promise<boolean> {
  const existing = await db().salesActivity.findFirst({
    where: { id: activityId, organizationId: tenant.organizationId },
    select: { id: true, createdBySystem: true, status: true },
  });

  if (!existing) return false;

  /**
   * A completed activity is history and is cancelled rather than deleted.
   *
   * Deleting the record that a call happened rewrites the past, and the lead
   * timeline is the thing an operator uses to remember what was said. Only
   * never-actioned work can be removed outright.
   */
  if (existing.status === 'COMPLETED') {
    await db().salesActivity.update({
      where: { id: existing.id },
      data: { status: 'CANCELLED' },
    });
    return true;
  }

  await db().salesActivity.delete({ where: { id: existing.id } });
  return true;
}

export async function listActivitiesForLead(tenant: TenantContext, businessId: string) {
  /**
   * Confirm the lead is ours before answering.
   *
   * The query below is already tenant-scoped, so another tenant's lead id
   * returns an empty list and nothing leaks. But it returned **200** where every
   * sibling resource route returns 404, which the cross-tenant penetration test
   * flagged: a route that answers 200 for an id it does not own reads as
   * success, and "success, no rows" is a different claim than "no such lead".
   *
   * Consistency, as defence in depth — not a fix for a live leak.
   */
  const lead = await db().business.findFirst({
    where: { id: businessId, organizationId: tenant.organizationId },
    select: { id: true },
  });
  if (!lead) throw notFound('Lead', { businessId });

  return db().salesActivity.findMany({
    where: { organizationId: tenant.organizationId, businessId },
    orderBy: [{ status: 'asc' }, { dueAt: 'asc' }, { createdAt: 'desc' }],
    include: {
      assignedTo: { select: { email: true, name: true } },
      deal: { select: { id: true, name: true, stage: true } },
    },
  });
}

export interface DueFilters {
  readonly overdueOnly?: boolean;
  readonly withinDays?: number;
  readonly types?: ActivityType[];
  readonly limit?: number;
}

/**
 * Open work, soonest first.
 *
 * Powers the `/sales` queue. Activities with no due date sort last rather than
 * first: an undated "think about this sometime" must not outrank a call due in an
 * hour.
 */
export async function listDueActivities(tenant: TenantContext, filters: DueFilters = {}) {
  const where: Prisma.SalesActivityWhereInput = {
    organizationId: tenant.organizationId,
    status: 'OPEN',
  };

  if (filters.overdueOnly) {
    where.dueAt = { lt: new Date() };
  } else if (filters.withinDays !== undefined) {
    where.dueAt = {
      lte: new Date(Date.now() + filters.withinDays * 24 * 60 * 60 * 1000),
    };
  }

  if (filters.types?.length) where.type = { in: filters.types };

  return db().salesActivity.findMany({
    where,
    orderBy: [{ dueAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
    take: filters.limit ?? 100,
    include: {
      business: {
        select: {
          id: true,
          displayName: true,
          city: true,
          leadStatus: true,
          leadPriority: true,
          primaryEmail: true,
        },
      },
      deal: { select: { id: true, name: true, stage: true, valueMinor: true, currency: true } },
    },
  });
}

/** Open-activity counts by type, for the work-queue header. */
export async function openActivityCounts(
  tenant: TenantContext,
): Promise<Record<string, number>> {
  const rows = await db().salesActivity.groupBy({
    by: ['type'],
    where: { organizationId: tenant.organizationId, status: 'OPEN' },
    _count: { _all: true },
  });

  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.type] = row._count._all;
  return counts;
}

/** Guards a due date supplied by a client. */
export function parseDueAt(value: string | null | undefined): Date | null {
  if (!value) return null;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: `"${value}" is not a valid date`,
      safeMessage: 'That due date could not be understood.',
    });
  }

  return date;
}
