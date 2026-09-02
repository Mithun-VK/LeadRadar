/**
 * Proposals.
 *
 * ---------------------------------------------------------------------------
 * THIS IS NOT A CONTRACT SYSTEM
 * ---------------------------------------------------------------------------
 *
 * There is no signature, no acceptance token, no audit of who clicked what, and
 * no legal binding. `ACCEPTED` records that a human told LeadRadar the client
 * accepted — it is a CRM note, not an executed agreement.
 *
 * Building a signature flow would create the appearance of a binding agreement
 * without any of the substance: no identity verification, no tamper-evident
 * record, no enforceable terms. An operator who believed a LeadRadar "acceptance"
 * was a contract would discover otherwise at the worst possible moment.
 *
 * `VIEWED` exists in the status enum because the lifecycle asks for it, but
 * NOTHING SETS IT AUTOMATICALLY. View tracking needs a tracking pixel or a hosted
 * proposal page, and neither exists. It is an operator-settable state — "the
 * client told me they'd read it" — not a measurement, and the UI says so.
 */
import { notFound } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { db, type TenantContext } from '@/modules/database/client';

import { createActivity } from './activities';
import { applyLeadEvent } from './leads';
import { moveDealStage } from './deals';

export type ProposalStatus = 'DRAFT' | 'SENT' | 'VIEWED' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED';

export const PROPOSAL_STATUS_LABELS: Record<ProposalStatus, string> = {
  DRAFT: 'Draft',
  SENT: 'Sent',
  VIEWED: 'Viewed',
  ACCEPTED: 'Accepted',
  REJECTED: 'Rejected',
  EXPIRED: 'Expired',
};

/** Statuses a human sets rather than the system measuring. */
export const MANUALLY_SET_STATUSES: readonly ProposalStatus[] = ['VIEWED', 'ACCEPTED', 'REJECTED'];

export interface ScopeLine {
  readonly item: string;
  readonly detail?: string;
}

export interface CreateProposalInput {
  readonly businessId: string;
  readonly dealId?: string | null;
  readonly title: string;
  readonly description?: string | null;
  readonly amountMinor?: number | null;
  readonly currency?: string;
  readonly scope?: readonly ScopeLine[];
  readonly timeline?: string | null;
  readonly terms?: string | null;
  readonly notes?: string | null;
  readonly validUntil?: Date | null;
}

export async function createProposal(tenant: TenantContext, input: CreateProposalInput) {
  const lead = await db().business.findFirst({
    where: { id: input.businessId, organizationId: tenant.organizationId },
    select: { id: true },
  });

  if (!lead) throw notFound('Lead', { businessId: input.businessId });

  const proposal = await db().proposal.create({
    data: {
      organizationId: tenant.organizationId,
      businessId: lead.id,
      dealId: input.dealId ?? null,
      title: input.title,
      description: input.description ?? null,
      amountMinor: input.amountMinor ?? null,
      currency: input.currency ?? 'INR',
      // Always DRAFT. A proposal is never created already sent, because sending
      // is a decision a human makes after reading it.
      status: 'DRAFT',
      scope: input.scope ? (input.scope as never) : undefined,
      timeline: input.timeline ?? null,
      terms: input.terms ?? null,
      notes: input.notes ?? null,
      validUntil: input.validUntil ?? null,
      createdByUserId: tenant.userId ?? null,
    },
  });

  logger().info({ proposalId: proposal.id, businessId: lead.id }, 'Proposal drafted');
  return proposal;
}

export interface UpdateProposalInput {
  readonly title?: string;
  readonly description?: string | null;
  readonly amountMinor?: number | null;
  readonly currency?: string;
  readonly status?: ProposalStatus;
  readonly scope?: readonly ScopeLine[];
  readonly timeline?: string | null;
  readonly terms?: string | null;
  readonly notes?: string | null;
  readonly validUntil?: Date | null;
}

/**
 * Updates a proposal and moves the pipeline where the status implies it.
 *
 * SENT advances the lead and the deal. ACCEPTED does NOT automatically mark the
 * deal won: accepting a proposal is a human's report of what a client said, and
 * closing a deal is the kind of irreversible, revenue-affecting act that should
 * be a deliberate click rather than a side effect. A task is raised instead.
 */
export async function updateProposal(
  tenant: TenantContext,
  proposalId: string,
  input: UpdateProposalInput,
) {
  const existing = await db().proposal.findFirst({
    where: { id: proposalId, organizationId: tenant.organizationId },
    select: { id: true, status: true, businessId: true, dealId: true, title: true },
  });

  if (!existing) throw notFound('Proposal', { proposalId });

  const sending = input.status === 'SENT' && existing.status !== 'SENT';

  const proposal = await db().proposal.update({
    where: { id: existing.id },
    data: {
      ...(input.title !== undefined && { title: input.title }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.amountMinor !== undefined && { amountMinor: input.amountMinor }),
      ...(input.currency !== undefined && { currency: input.currency }),
      ...(input.status !== undefined && { status: input.status }),
      ...(input.scope !== undefined && { scope: input.scope as never }),
      ...(input.timeline !== undefined && { timeline: input.timeline }),
      ...(input.terms !== undefined && { terms: input.terms }),
      ...(input.notes !== undefined && { notes: input.notes }),
      ...(input.validUntil !== undefined && { validUntil: input.validUntil }),
      ...(sending && { sentAt: new Date() }),
    },
  });

  if (sending) {
    await applyLeadEvent(
      tenant,
      existing.businessId,
      'PROPOSAL_SENT',
      `Proposal "${existing.title}" sent`,
      'USER',
    );

    if (existing.dealId) {
      try {
        await moveDealStage(tenant, {
          dealId: existing.dealId,
          to: 'PROPOSAL',
          reason: 'Proposal sent',
          source: 'USER',
          syncLead: false,
        });
      } catch {
        logger().debug({ dealId: existing.dealId }, 'Deal already past the proposal stage');
      }
    }

    await createActivity(tenant, {
      businessId: existing.businessId,
      dealId: existing.dealId,
      type: 'FOLLOW_UP',
      title: `Follow up on the proposal: ${existing.title}`,
      description: 'Chase a response if none has arrived.',
      // Five working days is the conventional chase window, and a proposal that
      // goes unfollowed is the most common way a live deal dies quietly.
      dueAt: new Date(Date.now() + 5 * 86_400_000),
    });
  }

  if (input.status === 'ACCEPTED' && existing.status !== 'ACCEPTED') {
    await createActivity(tenant, {
      businessId: existing.businessId,
      dealId: existing.dealId,
      type: 'TASK',
      title: 'Confirm and close the won deal',
      description:
        'The proposal was marked accepted. Mark the deal WON once the commercial terms are ' +
        'confirmed — LeadRadar does not close deals automatically.',
      dueAt: new Date(),
    });
  }

  return proposal;
}

export async function listProposals(
  tenant: TenantContext,
  filters: { businessId?: string; dealId?: string; statuses?: ProposalStatus[] } = {},
) {
  return db().proposal.findMany({
    where: {
      organizationId: tenant.organizationId,
      ...(filters.businessId && { businessId: filters.businessId }),
      ...(filters.dealId && { dealId: filters.dealId }),
      ...(filters.statuses?.length && { status: { in: filters.statuses } }),
    },
    orderBy: { createdAt: 'desc' },
    include: {
      business: { select: { id: true, displayName: true, city: true } },
      deal: { select: { id: true, name: true, stage: true } },
    },
  });
}

/**
 * Marks overdue proposals expired.
 *
 * Only DRAFT and SENT expire. An accepted or rejected proposal has an outcome,
 * and overwriting it with EXPIRED would destroy the record of what happened.
 */
export async function expireStaleProposals(now: Date = new Date()): Promise<number> {
  const { count } = await db().proposal.updateMany({
    where: {
      validUntil: { lt: now },
      status: { in: ['DRAFT', 'SENT', 'VIEWED'] },
    },
    data: { status: 'EXPIRED' },
  });

  return count;
}
