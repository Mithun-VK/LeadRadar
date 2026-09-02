/**
 * POST /api/deals/{id}/stage — move a deal.
 *
 * Where the Kanban board's drag-and-drop lands. Every move is validated,
 * recorded with the value at the time, and propagated to the lead where the
 * stage implies something about the relationship.
 */
import { z } from 'zod';

import { handler } from '@/modules/api/handler';
import {
  DEAL_STAGE_LABELS,
  DEAL_STAGE_ORDER,
  moveDealStage,
  type DealStage,
} from '@/modules/crm/deals';

const STAGES = DEAL_STAGE_ORDER as unknown as [DealStage, ...DealStage[]];

const bodySchema = z
  .object({
    stage: z.enum(STAGES),
    reason: z.string().trim().max(500).optional(),
    /**
     * Required by the service when moving to LOST. Not merely bureaucratic:
     * "why did we lose?" is the most useful field in a CRM and is never filled
     * in retrospectively.
     */
    lostReason: z.string().trim().max(500).optional(),
  })
  .strict();

export const POST = handler(
  async ({ tenant, params, body, logger }) => {
    const result = await moveDealStage(tenant, {
      dealId: params.id!,
      to: body.stage,
      ...(body.reason !== undefined && { reason: body.reason }),
      ...(body.lostReason !== undefined && { lostReason: body.lostReason }),
      source: 'USER',
    });

    logger.info({ dealId: params.id, ...result }, 'Deal stage changed via API');

    return {
      ...result,
      stageLabel: DEAL_STAGE_LABELS[result.to],
    };
  },
  { bodySchema, auditAction: 'deal.stage', rateLimit: { capacity: 60, refillPerSecond: 1 } },
);
