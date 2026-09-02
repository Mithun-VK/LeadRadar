/**
 * GET  /api/deals — the pipeline, with per-stage totals.
 * POST /api/deals — open an opportunity against a lead.
 */
import { z } from 'zod';

import { handler } from '@/modules/api/handler';
import {
  DEAL_STAGE_LABELS,
  DEAL_STAGE_ORDER,
  createDeal,
  formatMoney,
  listDeals,
  pipelineTotals,
  toMinorUnits,
  type DealStage,
} from '@/modules/crm/deals';

const STAGES = DEAL_STAGE_ORDER as unknown as [DealStage, ...DealStage[]];

const csv = z
  .string()
  .optional()
  .transform((value) =>
    value ? value.split(',').map((entry) => entry.trim()).filter(Boolean) : undefined,
  );

const querySchema = z
  .object({
    stage: csv,
    openOnly: z.enum(['true', 'false']).optional(),
    campaignId: z.string().min(1).optional(),
  })
  .strict();

export const GET = handler(
  async ({ tenant, query }) => {
    const [deals, totals] = await Promise.all([
      listDeals(tenant, {
        ...(query.stage && { stages: query.stage as DealStage[] }),
        ...(query.openOnly === 'true' && { openOnly: true }),
        ...(query.campaignId && { campaignId: query.campaignId }),
      }),
      pipelineTotals(tenant),
    ]);

    return {
      rows: deals.map((deal) => ({
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
        owner: deal.owner?.name ?? deal.owner?.email ?? null,
        business: deal.business,
        createdAt: deal.createdAt,
      })),
      // `unvaluedCount` travels with every total so the UI can say "₹4.2L across
      // 12 deals, 3 not yet valued" rather than implying the figure is complete.
      totals: totals.map((total) => ({
        ...total,
        stageLabel: DEAL_STAGE_LABELS[total.stage],
        valueLabel: formatMoney(total.valueMinor),
        weightedLabel: formatMoney(total.weightedMinor),
      })),
      stages: DEAL_STAGE_ORDER.map((stage) => ({ stage, label: DEAL_STAGE_LABELS[stage] })),
    };
  },
  { querySchema },
);

const bodySchema = z
  .object({
    businessId: z.string().min(1),
    name: z.string().trim().min(1).max(200),
    stage: z.enum(STAGES).optional(),
    /** Major units, as a person types them. Converted to integer minor units. */
    value: z.union([z.number(), z.string()]).nullable().optional(),
    currency: z.string().trim().length(3).optional(),
    probability: z.number().int().min(0).max(100).optional(),
    expectedCloseDate: z.string().optional(),
    notes: z.string().trim().max(4_000).optional(),
    sourceCampaignId: z.string().min(1).optional(),
  })
  .strict();

export const POST = handler(
  async ({ tenant, body }) => {
    const expectedCloseDate = body.expectedCloseDate ? new Date(body.expectedCloseDate) : null;

    const deal = await createDeal(tenant, {
      businessId: body.businessId,
      name: body.name,
      ...(body.stage !== undefined && { stage: body.stage }),
      valueMinor: toMinorUnits(body.value),
      ...(body.currency !== undefined && { currency: body.currency }),
      ...(body.probability !== undefined && { probability: body.probability }),
      expectedCloseDate:
        expectedCloseDate && !Number.isNaN(expectedCloseDate.getTime()) ? expectedCloseDate : null,
      ...(body.notes !== undefined && { notes: body.notes }),
      ...(body.sourceCampaignId !== undefined && { sourceCampaignId: body.sourceCampaignId }),
    });

    return {
      id: deal.id,
      name: deal.name,
      stage: deal.stage,
      valueMinor: deal.valueMinor,
      valueLabel: formatMoney(deal.valueMinor, deal.currency),
      probability: deal.probability,
    };
  },
  { bodySchema, auditAction: 'deal.create', rateLimit: { capacity: 30, refillPerSecond: 0.5 } },
);
