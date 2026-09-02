/**
 * Lead lifecycle service.
 *
 * The single place a lead's status changes. Every path — a user clicking
 * "Qualify", a worker recording a send, a classified reply, a CSV import — goes
 * through `changeLeadStatus`, which validates the transition and writes history
 * in the same transaction.
 *
 * That "same transaction" is the point. A status that changed without a history
 * row is an unexplained pipeline movement, and the first time someone asks "why
 * is this lead marked WON?" and the answer is missing, the history stops being
 * trusted. Making it atomic means the two cannot diverge.
 */
import type { Prisma } from '@prisma/client';

import { notFound } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { db, type TenantContext } from '@/modules/database/client';

import {
  assertTransition,
  canTransition,
  statusForEvent,
  type LeadStatus,
  type StatusChangeSource,
} from './lead-status';

export interface ChangeStatusInput {
  readonly businessId: string;
  readonly to: LeadStatus;
  readonly reason?: string;
  readonly source: StatusChangeSource;
  /** Skip the transition check. Only for reconciliation, never for user input. */
  readonly force?: boolean;
}

export interface ChangeStatusResult {
  readonly changed: boolean;
  readonly from: LeadStatus;
  readonly to: LeadStatus;
}

/**
 * Changes a lead's status, validating and recording it.
 *
 * A no-op (status already equals the target) returns `changed: false` and writes
 * NO history row. Without that, an idempotent worker would fill the timeline with
 * "CONTACTED → CONTACTED" entries and bury the real events.
 */
export async function changeLeadStatus(
  tenant: TenantContext,
  input: ChangeStatusInput,
  tx?: Prisma.TransactionClient,
): Promise<ChangeStatusResult> {
  const client = tx ?? db();

  const lead = await client.business.findFirst({
    where: { id: input.businessId, organizationId: tenant.organizationId },
    select: { id: true, leadStatus: true },
  });

  if (!lead) throw notFound('Lead', { businessId: input.businessId });

  const from = lead.leadStatus as LeadStatus;
  if (from === input.to) return { changed: false, from, to: input.to };

  if (!input.force) assertTransition(from, input.to);

  const apply = async (t: Prisma.TransactionClient): Promise<void> => {
    await t.business.update({
      where: { id: lead.id },
      data: { leadStatus: input.to },
    });

    await t.leadStatusHistory.create({
      data: {
        businessId: lead.id,
        fromStatus: from,
        toStatus: input.to,
        reason: input.reason ?? null,
        source: input.source,
        createdByUserId: tenant.userId ?? null,
      },
    });
  };

  // Reuse the caller's transaction when there is one, so a status change that is
  // part of a larger operation rolls back with it.
  if (tx) await apply(tx);
  else await db().$transaction(apply);

  logger().info(
    { businessId: lead.id, from, to: input.to, source: input.source },
    'Lead status changed',
  );

  return { changed: true, from, to: input.to };
}

/**
 * Applies the status implied by an event, if any, and if it is legal.
 *
 * Silent when the event implies no change or the transition is not permitted.
 * That silence is deliberate: these are called from workers processing thousands
 * of leads, and an out-of-order event must not fail a job. The transition table
 * is the guard, and `statusForEvent` already declines to drag a lead backwards.
 */
export async function applyLeadEvent(
  tenant: TenantContext,
  businessId: string,
  event: Parameters<typeof statusForEvent>[0],
  reason: string,
  source: StatusChangeSource = 'SYSTEM',
  tx?: Prisma.TransactionClient,
): Promise<ChangeStatusResult | null> {
  const client = tx ?? db();

  const lead = await client.business.findFirst({
    where: { id: businessId, organizationId: tenant.organizationId },
    select: { leadStatus: true },
  });

  if (!lead) return null;

  const current = lead.leadStatus as LeadStatus;
  const target = statusForEvent(event, current);

  if (target === null || target === current) return null;
  if (!canTransition(current, target)) return null;

  return changeLeadStatus(tenant, { businessId, to: target, reason, source }, tx);
}

/** Records a touch. Separate from status because a follow-up is a touch but not a stage change. */
export async function recordTouch(
  tenant: TenantContext,
  businessId: string,
  kind: 'OUTBOUND' | 'INBOUND',
  at: Date = new Date(),
  tx?: Prisma.TransactionClient,
): Promise<void> {
  const client = tx ?? db();

  const lead = await client.business.findFirst({
    where: { id: businessId, organizationId: tenant.organizationId },
    select: { id: true, firstTouchAt: true },
  });

  if (!lead) return;

  await client.business.update({
    where: { id: lead.id },
    data: {
      // First touch is written once and never moved: it is the anchor for
      // "how long from first contact to close".
      ...(lead.firstTouchAt === null && kind === 'OUTBOUND' && { firstTouchAt: at }),
      lastTouchAt: at,
      ...(kind === 'INBOUND' && { lastReplyAt: at }),
    },
  });
}

/** Marks an address undeliverable. Distinct from suppression, which is about consent. */
export async function markEmailInvalid(
  tenant: TenantContext,
  businessId: string,
  tx?: Prisma.TransactionClient,
): Promise<void> {
  const client = tx ?? db();

  await client.business.updateMany({
    where: { id: businessId, organizationId: tenant.organizationId },
    data: { emailInvalid: true },
  });
}

export async function leadStatusHistory(tenant: TenantContext, businessId: string) {
  const lead = await db().business.findFirst({
    where: { id: businessId, organizationId: tenant.organizationId },
    select: { id: true },
  });

  if (!lead) throw notFound('Lead', { businessId });

  return db().leadStatusHistory.findMany({
    where: { businessId: lead.id },
    orderBy: { createdAt: 'desc' },
    include: { createdBy: { select: { email: true, name: true } } },
  });
}

/**
 * Counts by status, for the funnel.
 *
 * One grouped query rather than eleven counts. At 100,000 leads the difference
 * between one aggregate and eleven table scans is the difference between a
 * dashboard that loads and one nobody opens.
 */
export async function leadStatusCounts(
  tenant: TenantContext,
  since?: Date,
): Promise<Record<LeadStatus, number>> {
  const rows = await db().business.groupBy({
    by: ['leadStatus'],
    where: {
      organizationId: tenant.organizationId,
      ...(since && { createdAt: { gte: since } }),
    },
    _count: { _all: true },
  });

  const counts = {} as Record<LeadStatus, number>;
  for (const row of rows) counts[row.leadStatus as LeadStatus] = row._count._all;
  return counts;
}

/**
 * Qualifies leads in bulk.
 *
 * Used by the leads table's "qualify selected" action. Leads that cannot legally
 * transition are skipped and counted rather than failing the batch — an operator
 * selecting 200 rows, three of which are already contacted, wants the other 197
 * qualified, not an error.
 */
export async function qualifyLeads(
  tenant: TenantContext,
  businessIds: readonly string[],
  reason = 'Qualified in bulk from the leads table',
): Promise<{ qualified: number; skipped: number }> {
  let qualified = 0;
  let skipped = 0;

  for (const businessId of businessIds) {
    try {
      const result = await changeLeadStatus(tenant, {
        businessId,
        to: 'QUALIFIED',
        reason,
        source: 'USER',
      });
      if (result.changed) qualified += 1;
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }

  return { qualified, skipped };
}
