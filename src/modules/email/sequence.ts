/**
 * Campaign sequences — the follow-up engine.
 *
 * ---------------------------------------------------------------------------
 * THE SHAPE OF THE PROBLEM
 * ---------------------------------------------------------------------------
 *
 * A single-send campaign has one safety question: "did we already mail this
 * lead?" A sequence has a harder one, asked repeatedly over days: "is it STILL
 * appropriate to mail this lead?" Between step 1 on Monday and step 2 on
 * Thursday the recipient may have replied, unsubscribed, bounced, or been
 * suppressed by someone else's campaign entirely.
 *
 * So eligibility is not evaluated once at enrolment and cached. It is
 * re-evaluated immediately before every step, against live state. That is the
 * central design commitment of this module, and the reason the engine schedules
 * one step at a time rather than laying out the whole sequence in advance: a
 * plan written on Monday cannot know what Thursday looks like.
 *
 * ---------------------------------------------------------------------------
 * IDEMPOTENCY
 * ---------------------------------------------------------------------------
 *
 * There is no lock and no SELECT FOR UPDATE. `EmailMessage` carries a unique
 * constraint on `(campaignId, businessId, campaignStepId)`, and its row is
 * INSERTed as SENDING *before* the provider is called. Two workers racing the
 * same (lead, step) therefore resolve in the database: one INSERT wins, the
 * other raises a unique violation and never reaches the send.
 *
 * This also survives the nastier case — a worker that sends successfully and
 * then dies before recording the result. The row already exists in SENDING, so
 * a retry collides with it and refuses rather than sending a second copy. An
 * operator is left with a message whose delivery is *unknown*, which is
 * recoverable; a duplicate in a stranger's inbox is not.
 *
 * ---------------------------------------------------------------------------
 * BACKWARD COMPATIBILITY
 * ---------------------------------------------------------------------------
 *
 * A campaign with no steps behaves exactly as it did before this module existed:
 * one send, then COMPLETED. That is not an accident of the code — it is asserted
 * by tests, because every campaign created before sequences has zero steps and
 * must not suddenly start sending follow-ups to people it already contacted.
 */
import type { Prisma } from '@prisma/client';

import { logger } from '@/lib/logger';
import { db, type TenantContext } from '@/modules/database/client';

/**
 * Lead-level states from which no further step may ever be sent.
 *
 * `REPLIED` is the one that matters most: `stopCampaignsForLead` (in inbox-sync)
 * moves PENDING/QUEUED/SENT enrolments here when a reply arrives, so a sequence
 * waiting between steps is terminated by the existing reply handler without this
 * module needing to know anything about inbox synchronisation.
 */
export const TERMINAL_LEAD_STATUSES = [
  'REPLIED',
  'UNSUBSCRIBED',
  'SKIPPED',
  'FAILED',
] as const;

export type TerminalLeadStatus = (typeof TERMINAL_LEAD_STATUSES)[number];

export function isTerminalLeadStatus(status: string): status is TerminalLeadStatus {
  return (TERMINAL_LEAD_STATUSES as readonly string[]).includes(status);
}

/** Why a sequence stopped, for the audit trail and the campaign screen. */
export type SequenceStopReason =
  | 'SEQUENCE_COMPLETE'
  | 'REPLIED'
  | 'UNSUBSCRIBED'
  | 'SUPPRESSED'
  | 'BOUNCED'
  | 'FAILED'
  | 'CAMPAIGN_STOPPED';

export interface SequenceStep {
  readonly id: string;
  readonly stepNumber: number;
  readonly delayDays: number;
  readonly templateId: string | null;
}

/**
 * Active steps for a campaign, in order.
 *
 * Inactive steps are filtered out rather than skipped later, so "step 3 is
 * disabled" means the sequence runs 1 → 2 → 4 rather than stalling at 3.
 */
export async function activeSteps(campaignId: string): Promise<SequenceStep[]> {
  const rows = await db().campaignStep.findMany({
    where: { campaignId, active: true },
    orderBy: { stepNumber: 'asc' },
    select: { id: true, stepNumber: true, delayDays: true, templateId: true },
  });

  return rows;
}

/** True when this campaign is a sequence rather than a single send. */
export async function hasSequence(campaignId: string): Promise<boolean> {
  const count = await db().campaignStep.count({ where: { campaignId, active: true } });
  return count > 0;
}

/**
 * The step that should run next for a lead, or null when the sequence is done.
 *
 * Derived from `currentStepNumber` rather than from a stored pointer to the next
 * step: a pointer can drift when steps are added, removed, or disabled midway
 * through a running campaign, and a drifted pointer either skips a message or
 * repeats one.
 */
export function nextStep(
  steps: readonly SequenceStep[],
  currentStepNumber: number,
): SequenceStep | null {
  return steps.find((step) => step.stepNumber > currentStepNumber) ?? null;
}

/**
 * When a step becomes due.
 *
 * `delayDays` is relative to the PREVIOUS step, so inserting a step does not
 * silently reschedule every later one. Step 1 is immediate.
 *
 * Computed in UTC from an explicit `from` instant. Nothing here reads the
 * server's local timezone — a follow-up interval must not change because a
 * worker moved region or a host observed daylight saving.
 */
export function dueAt(step: SequenceStep, from: Date): Date {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  return new Date(from.getTime() + Math.max(0, step.delayDays) * MS_PER_DAY);
}

export interface AdvanceResult {
  readonly finished: boolean;
  readonly nextStepNumber: number | null;
  readonly nextDueAt: Date | null;
}

/**
 * Records that a step was sent and schedules whatever follows.
 *
 * Advances only AFTER a confirmed send. A crash between the send and this call
 * leaves `currentStepNumber` behind, so the step is retried — and the retry
 * collides with the existing EmailMessage row and refuses. Losing the advance is
 * therefore safe; losing the duplicate-send guard would not be.
 */
export async function advanceAfterSend(
  campaignLeadId: string,
  campaignId: string,
  sentStepNumber: number,
  sentAt: Date,
  tx?: Prisma.TransactionClient,
): Promise<AdvanceResult> {
  const client = tx ?? db();
  const steps = await activeSteps(campaignId);
  const upcoming = nextStep(steps, sentStepNumber);

  if (!upcoming) {
    await client.campaignLead.update({
      where: { id: campaignLeadId },
      data: {
        status: 'SENT',
        currentStepNumber: sentStepNumber,
        nextStepAt: null,
        sentAt,
      },
    });

    return { finished: true, nextStepNumber: null, nextDueAt: null };
  }

  const due = dueAt(upcoming, sentAt);

  await client.campaignLead.update({
    where: { id: campaignLeadId },
    data: {
      /**
       * QUEUED, not SENT. The lead is waiting for its next step, and QUEUED is
       * exactly what `stopCampaignsForLead` looks for when a reply arrives — so
       * reusing it means reply-termination works for sequences without the
       * inbox-sync code knowing sequences exist.
       */
      status: 'QUEUED',
      currentStepNumber: sentStepNumber,
      nextStepAt: due,
      sentAt,
    },
  });

  return { finished: false, nextStepNumber: upcoming.stepNumber, nextDueAt: due };
}

/**
 * Ends a sequence for one lead without sending anything further.
 *
 * Clears `nextStepAt` so the scheduler stops considering the lead at all, rather
 * than relying on a downstream guard to reject it every tick forever.
 */
export async function stopSequence(
  campaignLeadId: string,
  reason: SequenceStopReason,
  status: 'REPLIED' | 'UNSUBSCRIBED' | 'SKIPPED' | 'FAILED' | 'SENT',
  skipReason?: string,
): Promise<void> {
  await db().campaignLead.update({
    where: { id: campaignLeadId },
    data: {
      status,
      nextStepAt: null,
      ...(skipReason !== undefined && { skipReason }),
    },
  });

  logger().info({ campaignLeadId, reason, status }, 'Sequence stopped for lead');
}

export interface DueLead {
  readonly campaignLeadId: string;
  readonly businessId: string;
  readonly campaignId: string;
  readonly organizationId: string;
  readonly currentStepNumber: number;
}

/**
 * Leads whose next step is due now.
 *
 * Includes leads that have never been sent to (`nextStepAt` null and
 * `currentStepNumber` 0), which is how a freshly activated campaign starts, and
 * leads whose scheduled time has passed.
 *
 * Ordered by due time so a backlog drains oldest-first rather than starving the
 * leads that have waited longest.
 */
export async function dueLeads(
  campaignId: string,
  now: Date,
  limit = 1,
): Promise<DueLead[]> {
  const rows = await db().campaignLead.findMany({
    where: {
      campaignId,
      status: 'QUEUED',
      OR: [{ nextStepAt: null }, { nextStepAt: { lte: now } }],
    },
    orderBy: [{ nextStepAt: { sort: 'asc', nulls: 'first' } }, { queuedAt: 'asc' }],
    take: limit,
    select: {
      id: true,
      businessId: true,
      currentStepNumber: true,
      campaign: { select: { id: true, organizationId: true } },
    },
  });

  return rows.map((row) => ({
    campaignLeadId: row.id,
    businessId: row.businessId,
    campaignId: row.campaign.id,
    organizationId: row.campaign.organizationId,
    currentStepNumber: row.currentStepNumber,
  }));
}

/**
 * Whether any lead in this campaign still has work scheduled.
 *
 * Distinguishes "waiting for a follow-up that is days away" from "genuinely
 * finished". Without it a campaign would be marked COMPLETED the moment its
 * first pass finished, and every pending follow-up would be silently abandoned.
 */
export async function hasPendingWork(campaignId: string): Promise<boolean> {
  const count = await db().campaignLead.count({
    where: { campaignId, status: { in: ['PENDING', 'QUEUED'] } },
  });
  return count > 0;
}

/** The soonest moment any lead in this campaign becomes due, or null. */
export async function nextDueAt(campaignId: string): Promise<Date | null> {
  const row = await db().campaignLead.findFirst({
    where: { campaignId, status: 'QUEUED', nextStepAt: { not: null } },
    orderBy: { nextStepAt: 'asc' },
    select: { nextStepAt: true },
  });

  return row?.nextStepAt ?? null;
}

/**
 * Every step already sent to a lead, for the campaign screen and for tests.
 *
 * Reads EmailMessage rather than a counter, because the messages are the record
 * of what actually happened — a counter can disagree with reality after a crash.
 */
export async function sentSteps(
  tenant: TenantContext,
  campaignId: string,
  businessId: string,
): Promise<Array<{ stepId: string | null; status: string; sentAt: Date | null }>> {
  const rows = await db().emailMessage.findMany({
    where: { organizationId: tenant.organizationId, campaignId, businessId },
    orderBy: { createdAt: 'asc' },
    select: { campaignStepId: true, status: true, sentAt: true },
  });

  return rows.map((row) => ({
    stepId: row.campaignStepId,
    status: row.status,
    sentAt: row.sentAt,
  }));
}
