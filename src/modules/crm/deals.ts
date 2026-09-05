/**
 * Deals.
 *
 * ---------------------------------------------------------------------------
 * MONEY IS AN INTEGER
 * ---------------------------------------------------------------------------
 *
 * `valueMinor` is paise (or cents), stored as an integer, everywhere. Never a
 * float. Summing floating-point money across a pipeline drifts visibly, and a
 * pipeline total that disagrees with the sum of the rows beneath it is the
 * fastest possible way to lose trust in a revenue dashboard — the one number an
 * operator will check by hand.
 *
 * `null` means "not estimated yet" and is rendered as unknown, never as zero. A
 * deal with no value entered is not a worthless deal, and averaging it in as zero
 * would drag every average down.
 *
 * ---------------------------------------------------------------------------
 * WHY A DEAL IS NOT A LEAD STATUS
 * ---------------------------------------------------------------------------
 *
 * They move together but are not the same thing. One business can produce two
 * deals a year apart; a lost deal does not make the lead worthless. Keeping them
 * separate is what lets "we lost the redesign but won the SEO retainer" be
 * representable.
 */
import type { Prisma } from '@prisma/client';

import { AppError, notFound } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { db, type TenantContext } from '@/modules/database/client';

import { changeLeadStatus } from './leads';
import type { LeadStatus, StatusChangeSource } from './lead-status';

export type DealStage =
  | 'QUALIFICATION'
  | 'DISCOVERY'
  | 'MEETING'
  | 'PROPOSAL'
  | 'NEGOTIATION'
  | 'WON'
  | 'LOST';

export const DEAL_STAGE_ORDER: readonly DealStage[] = [
  'QUALIFICATION',
  'DISCOVERY',
  'MEETING',
  'PROPOSAL',
  'NEGOTIATION',
  'WON',
  'LOST',
];

export const DEAL_STAGE_LABELS: Record<DealStage, string> = {
  QUALIFICATION: 'Qualification',
  DISCOVERY: 'Discovery',
  MEETING: 'Meeting',
  PROPOSAL: 'Proposal',
  NEGOTIATION: 'Negotiation',
  WON: 'Won',
  LOST: 'Lost',
};

export const CLOSED_STAGES: readonly DealStage[] = ['WON', 'LOST'];

/**
 * Default probability per stage.
 *
 * Starting points, not truth. They are editable per deal because a salesperson's
 * read on a specific conversation beats a stage average — and because a weighted
 * pipeline built purely from stage defaults is just a deal count wearing a
 * currency symbol.
 */
export const STAGE_PROBABILITY: Record<DealStage, number> = {
  QUALIFICATION: 10,
  DISCOVERY: 25,
  MEETING: 40,
  PROPOSAL: 60,
  NEGOTIATION: 80,
  WON: 100,
  LOST: 0,
};

/**
 * Stage transitions.
 *
 * Permissive backwards, like the lead table: deals stall and reopen, and forcing
 * an operator to mark something LOST to represent "went quiet" would corrupt the
 * win rate. Terminal stages can be reopened, because a deal marked lost in error
 * must be fixable — but doing so is recorded.
 */
const TRANSITIONS: Record<DealStage, readonly DealStage[]> = {
  QUALIFICATION: ['DISCOVERY', 'MEETING', 'PROPOSAL', 'WON', 'LOST'],
  DISCOVERY: ['MEETING', 'PROPOSAL', 'NEGOTIATION', 'QUALIFICATION', 'WON', 'LOST'],
  MEETING: ['PROPOSAL', 'NEGOTIATION', 'DISCOVERY', 'WON', 'LOST'],
  PROPOSAL: ['NEGOTIATION', 'WON', 'LOST', 'MEETING'],
  NEGOTIATION: ['WON', 'LOST', 'PROPOSAL'],
  WON: ['NEGOTIATION', 'LOST'],
  LOST: ['QUALIFICATION', 'DISCOVERY', 'NEGOTIATION'],
};

export function canMoveStage(from: DealStage, to: DealStage): boolean {
  if (from === to) return true;
  return TRANSITIONS[from].includes(to);
}

export function assertStageMove(from: DealStage, to: DealStage): void {
  if (canMoveStage(from, to)) return;

  throw new AppError({
    code: 'VALIDATION_FAILED',
    message: `A deal cannot move from ${from} to ${to}`,
    safeMessage: `A ${DEAL_STAGE_LABELS[from].toLowerCase()} deal cannot move straight to ${DEAL_STAGE_LABELS[to].toLowerCase()}.`,
    context: { from, to, allowed: TRANSITIONS[from] },
  });
}

/**
 * The lead status a deal stage implies.
 *
 * Deliberately a partial mapping. QUALIFICATION and DISCOVERY imply nothing about
 * the lead — a deal can be created off a reply without the lead having reached
 * SQL yet, and forcing the lead forward would misrepresent the relationship. Only
 * the stages that genuinely mean something happened propagate.
 */
export function leadStatusForStage(stage: DealStage): LeadStatus | null {
  switch (stage) {
    case 'MEETING':
      return 'MEETING';
    case 'PROPOSAL':
      return 'PROPOSAL';
    case 'NEGOTIATION':
      return 'NEGOTIATION';
    case 'WON':
      return 'WON';
    case 'LOST':
      return 'LOST';
    default:
      return null;
  }
}

export interface CreateDealInput {
  readonly businessId: string;
  readonly name: string;
  readonly stage?: DealStage;
  readonly valueMinor?: number | null;
  readonly currency?: string;
  readonly probability?: number | null;
  readonly expectedCloseDate?: Date | null;
  readonly notes?: string | null;
  readonly ownerUserId?: string | null;
  readonly sourceCampaignId?: string | null;
}

export async function createDeal(tenant: TenantContext, input: CreateDealInput) {
  const lead = await db().business.findFirst({
    where: { id: input.businessId, organizationId: tenant.organizationId },
    select: { id: true, displayName: true },
  });

  if (!lead) throw notFound('Lead', { businessId: input.businessId });

  const stage = input.stage ?? 'QUALIFICATION';

  if (input.valueMinor !== undefined && input.valueMinor !== null && input.valueMinor < 0) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'Deal value cannot be negative',
      safeMessage: 'A deal value cannot be negative.',
    });
  }

  /**
   * The campaign that produced this lead is inherited automatically when the
   * caller does not name one. Attribution that relies on a human remembering to
   * pick a campaign is attribution that will be missing for most deals.
   */
  const inferredCampaign =
    input.sourceCampaignId ??
    (
      await db().campaignLead.findFirst({
        where: {
          businessId: lead.id,
          status: { in: ['SENT', 'REPLIED'] },
          campaign: { organizationId: tenant.organizationId },
        },
        orderBy: { sentAt: 'desc' },
        select: { campaignId: true },
      })
    )?.campaignId ??
    null;

  const deal = await db().$transaction(async (tx) => {
    const created = await tx.deal.create({
      data: {
        organizationId: tenant.organizationId,
        businessId: lead.id,
        name: input.name,
        stage,
        valueMinor: input.valueMinor ?? null,
        currency: input.currency ?? 'INR',
        probability: input.probability ?? STAGE_PROBABILITY[stage],
        expectedCloseDate: input.expectedCloseDate ?? null,
        notes: input.notes ?? null,
        ownerUserId: input.ownerUserId ?? tenant.userId ?? null,
        sourceCampaignId: inferredCampaign,
        ...(CLOSED_STAGES.includes(stage) && { closedAt: new Date() }),
      },
    });

    await tx.dealStageHistory.create({
      data: {
        dealId: created.id,
        fromStage: null,
        toStage: stage,
        reason: 'Deal created',
        source: 'USER',
        valueMinorAtChange: created.valueMinor,
        createdByUserId: tenant.userId ?? null,
      },
    });

    return created;
  });

  logger().info({ dealId: deal.id, businessId: lead.id, stage }, 'Deal created');
  return deal;
}

export interface MoveStageInput {
  readonly dealId: string;
  readonly to: DealStage;
  readonly reason?: string;
  readonly lostReason?: string;
  readonly source?: StatusChangeSource;
  /** Propagate the implied lead status. Default true. */
  readonly syncLead?: boolean;
}

/**
 * Moves a deal, records the change, and propagates to the lead.
 *
 * Lead propagation is best-effort: if the lead cannot legally make the implied
 * transition (it is UNSUBSCRIBED, say), the deal still moves and the lead is left
 * alone. Failing the deal move because of a lead-side rule would be surprising and
 * would block legitimate pipeline work.
 */
export async function moveDealStage(tenant: TenantContext, input: MoveStageInput) {
  const deal = await db().deal.findFirst({
    where: { id: input.dealId, organizationId: tenant.organizationId },
    select: { id: true, stage: true, businessId: true, valueMinor: true },
  });

  if (!deal) throw notFound('Deal', { dealId: input.dealId });

  const from = deal.stage as DealStage;
  if (from === input.to) return { changed: false, from, to: input.to };

  assertStageMove(from, input.to);

  if (input.to === 'LOST' && !input.lostReason && !input.reason) {
    // Not merely bureaucratic: "why did we lose?" is the single most useful
    // field in a CRM, and it is never filled in retrospectively.
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'A lost deal needs a reason',
      safeMessage: 'Please record why this deal was lost.',
    });
  }

  const closing = CLOSED_STAGES.includes(input.to);

  await db().$transaction(async (tx) => {
    await tx.deal.update({
      where: { id: deal.id },
      data: {
        stage: input.to,
        probability: STAGE_PROBABILITY[input.to],
        ...(closing ? { closedAt: new Date() } : { closedAt: null }),
        ...(input.to === 'LOST' && { lostReason: input.lostReason ?? input.reason ?? null }),
      },
    });

    await tx.dealStageHistory.create({
      data: {
        dealId: deal.id,
        fromStage: from,
        toStage: input.to,
        reason: input.reason ?? input.lostReason ?? null,
        source: input.source ?? 'USER',
        valueMinorAtChange: deal.valueMinor,
        createdByUserId: tenant.userId ?? null,
      },
    });
  });

  if (input.syncLead !== false) {
    const impliedLeadStatus = leadStatusForStage(input.to);
    if (impliedLeadStatus) {
      try {
        await changeLeadStatus(tenant, {
          businessId: deal.businessId,
          to: impliedLeadStatus,
          reason: `Deal moved to ${DEAL_STAGE_LABELS[input.to]}`,
          source: input.source ?? 'USER',
        });
      } catch {
        // The deal move stands. The lead simply could not follow.
        logger().info(
          { dealId: deal.id, businessId: deal.businessId, impliedLeadStatus },
          'Deal moved but lead status could not follow',
        );
      }
    }
  }

  logger().info({ dealId: deal.id, from, to: input.to }, 'Deal stage changed');
  return { changed: true, from, to: input.to };
}

export interface UpdateDealInput {
  readonly name?: string;
  readonly valueMinor?: number | null;
  readonly currency?: string;
  readonly probability?: number;
  readonly expectedCloseDate?: Date | null;
  readonly notes?: string | null;
  readonly ownerUserId?: string | null;
}

export async function updateDeal(tenant: TenantContext, dealId: string, input: UpdateDealInput) {
  const deal = await db().deal.findFirst({
    where: { id: dealId, organizationId: tenant.organizationId },
    select: { id: true },
  });

  if (!deal) throw notFound('Deal', { dealId });

  if (input.valueMinor !== undefined && input.valueMinor !== null && input.valueMinor < 0) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'Deal value cannot be negative',
      safeMessage: 'A deal value cannot be negative.',
    });
  }

  if (input.probability !== undefined && (input.probability < 0 || input.probability > 100)) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'Probability must be between 0 and 100',
      safeMessage: 'Probability must be between 0 and 100.',
    });
  }

  return db().deal.update({
    where: { id: deal.id },
    data: {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.valueMinor !== undefined && { valueMinor: input.valueMinor }),
      ...(input.currency !== undefined && { currency: input.currency }),
      ...(input.probability !== undefined && { probability: input.probability }),
      ...(input.expectedCloseDate !== undefined && { expectedCloseDate: input.expectedCloseDate }),
      ...(input.notes !== undefined && { notes: input.notes }),
      ...(input.ownerUserId !== undefined && { ownerUserId: input.ownerUserId }),
    },
  });
}

export async function getDeal(tenant: TenantContext, dealId: string) {
  const deal = await db().deal.findFirst({
    where: { id: dealId, organizationId: tenant.organizationId },
    include: {
      business: {
        select: {
          id: true,
          displayName: true,
          city: true,
          primaryEmail: true,
          leadStatus: true,
          leadPriority: true,
          opportunityScore: true,
        },
      },
      owner: { select: { email: true, name: true } },
      sourceCampaign: { select: { id: true, name: true } },
      stageHistory: { orderBy: { createdAt: 'desc' } },
      activities: { orderBy: { createdAt: 'desc' }, take: 50 },
      meetings: { orderBy: { scheduledAt: 'desc' } },
      proposals: { orderBy: { createdAt: 'desc' } },
    },
  });

  if (!deal) throw notFound('Deal', { dealId });
  return deal;
}

export interface DealFilters {
  readonly stages?: DealStage[];
  readonly ownerUserId?: string;
  readonly openOnly?: boolean;
  readonly campaignId?: string;
  /** Rows to return. Capped at {@link MAX_DEALS_PER_QUERY} whatever is asked for. */
  readonly limit?: number;
}

/**
 * Ceiling on one deal query.
 *
 * `listDeals` feeds the Kanban board, which wants "all the deals" — so it had no
 * limit at all. Measured at 1,200 deals that is 328ms at p95, acceptable today
 * and unbounded tomorrow: nothing in the query grows slower than the pipeline
 * does, and a board rendering four thousand cards is not usable anyway.
 *
 * 500 is well above any pipeline a human works and well below the point where
 * the query or the browser struggles. `pipelineTotals` remains uncapped and
 * correct for the headline numbers — it reads three columns and measured 21ms,
 * so the counts stay accurate even when the board itself is truncated.
 */
export const MAX_DEALS_PER_QUERY = 500;

export async function listDeals(tenant: TenantContext, filters: DealFilters = {}) {
  const where: Prisma.DealWhereInput = { organizationId: tenant.organizationId };

  if (filters.stages?.length) where.stage = { in: filters.stages };
  if (filters.ownerUserId) where.ownerUserId = filters.ownerUserId;
  if (filters.campaignId) where.sourceCampaignId = filters.campaignId;
  if (filters.openOnly) where.stage = { notIn: ['WON', 'LOST'] };

  return db().deal.findMany({
    where,
    orderBy: [{ stage: 'asc' }, { valueMinor: { sort: 'desc', nulls: 'last' } }],
    take: Math.min(filters.limit ?? MAX_DEALS_PER_QUERY, MAX_DEALS_PER_QUERY),
    include: {
      business: { select: { id: true, displayName: true, city: true, leadPriority: true } },
      owner: { select: { email: true, name: true } },
    },
  });
}

export interface PipelineTotals {
  readonly stage: DealStage;
  readonly count: number;
  /** Sum of known values. Deals with no value are excluded, not counted as zero. */
  readonly valueMinor: number;
  /** Deals in this stage with no value entered — shown so the total is honest. */
  readonly unvaluedCount: number;
  readonly weightedMinor: number;
}

/**
 * Pipeline totals by stage.
 *
 * Reports `unvaluedCount` alongside the money so the UI can say "₹4.2L across 12
 * deals, 3 not yet valued" rather than implying the total is complete. A pipeline
 * figure that silently omits a third of its deals is worse than no figure.
 */
export async function pipelineTotals(tenant: TenantContext): Promise<PipelineTotals[]> {
  const deals = await db().deal.findMany({
    where: { organizationId: tenant.organizationId },
    select: { stage: true, valueMinor: true, probability: true },
  });

  return DEAL_STAGE_ORDER.map((stage) => {
    const inStage = deals.filter((deal) => deal.stage === stage);
    const valued = inStage.filter((deal) => deal.valueMinor !== null);

    return {
      stage,
      count: inStage.length,
      valueMinor: valued.reduce((sum, deal) => sum + (deal.valueMinor ?? 0), 0),
      unvaluedCount: inStage.length - valued.length,
      weightedMinor: Math.round(
        valued.reduce((sum, deal) => sum + (deal.valueMinor ?? 0) * (deal.probability / 100), 0),
      ),
    };
  });
}

/** Formats minor units for display. Never used for arithmetic. */
export function formatMoney(minor: number | null, currency = 'INR'): string {
  if (minor === null) return '—';

  const major = minor / 100;
  try {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(major);
  } catch {
    return `${currency} ${major.toFixed(0)}`;
  }
}

/** Parses a major-unit amount from a form into minor units. */
export function toMinorUnits(major: number | string | null | undefined): number | null {
  if (major === null || major === undefined || major === '') return null;

  const value = typeof major === 'string' ? Number(major.replace(/[,\s]/g, '')) : major;
  if (!Number.isFinite(value)) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: `"${String(major)}" is not a valid amount`,
      safeMessage: 'That amount could not be understood.',
    });
  }

  return Math.round(value * 100);
}
