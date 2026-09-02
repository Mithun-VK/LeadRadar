/**
 * GET   /api/deals/{id}
 * PATCH /api/deals/{id}
 */
import { z } from 'zod';

import { handler } from '@/modules/api/handler';
import {
  DEAL_STAGE_LABELS,
  formatMoney,
  getDeal,
  toMinorUnits,
  updateDeal,
  type DealStage,
} from '@/modules/crm/deals';

export const GET = handler(async ({ tenant, params }) => {
  const deal = await getDeal(tenant, params.id!);

  return {
    id: deal.id,
    name: deal.name,
    stage: deal.stage,
    stageLabel: DEAL_STAGE_LABELS[deal.stage as DealStage],
    valueMinor: deal.valueMinor,
    valueLabel: formatMoney(deal.valueMinor, deal.currency),
    currency: deal.currency,
    probability: deal.probability,
    expectedCloseDate: deal.expectedCloseDate,
    closedAt: deal.closedAt,
    lostReason: deal.lostReason,
    notes: deal.notes,
    owner: deal.owner?.name ?? deal.owner?.email ?? null,
    business: deal.business,
    sourceCampaign: deal.sourceCampaign,
    stageHistory: deal.stageHistory.map((entry) => ({
      id: entry.id,
      fromStage: entry.fromStage,
      toStage: entry.toStage,
      reason: entry.reason,
      source: entry.source,
      valueLabel: formatMoney(entry.valueMinorAtChange, deal.currency),
      createdAt: entry.createdAt,
    })),
    activities: deal.activities,
    meetings: deal.meetings,
    proposals: deal.proposals.map((proposal) => ({
      ...proposal,
      amountLabel: formatMoney(proposal.amountMinor, proposal.currency),
    })),
  };
});

const bodySchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    value: z.union([z.number(), z.string()]).nullable().optional(),
    currency: z.string().trim().length(3).optional(),
    probability: z.number().int().min(0).max(100).optional(),
    expectedCloseDate: z.string().nullable().optional(),
    notes: z.string().trim().max(4_000).nullable().optional(),
    ownerUserId: z.string().min(1).nullable().optional(),
  })
  .strict();

export const PATCH = handler(
  async ({ tenant, params, body }) => {
    const expectedCloseDate =
      body.expectedCloseDate === undefined
        ? undefined
        : body.expectedCloseDate === null
          ? null
          : new Date(body.expectedCloseDate);

    const deal = await updateDeal(tenant, params.id!, {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.value !== undefined && { valueMinor: toMinorUnits(body.value) }),
      ...(body.currency !== undefined && { currency: body.currency }),
      ...(body.probability !== undefined && { probability: body.probability }),
      ...(expectedCloseDate !== undefined && {
        expectedCloseDate:
          expectedCloseDate && !Number.isNaN(expectedCloseDate.getTime()) ? expectedCloseDate : null,
      }),
      ...(body.notes !== undefined && { notes: body.notes }),
      ...(body.ownerUserId !== undefined && { ownerUserId: body.ownerUserId }),
    });

    return {
      id: deal.id,
      name: deal.name,
      valueMinor: deal.valueMinor,
      valueLabel: formatMoney(deal.valueMinor, deal.currency),
      probability: deal.probability,
    };
  },
  { bodySchema, auditAction: 'deal.update' },
);
