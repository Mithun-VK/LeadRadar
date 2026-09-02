/**
 * POST /api/campaigns/{id}/status — start, pause, resume, cancel, complete.
 *
 * One endpoint rather than four, because the interesting logic is the transition
 * table, and four endpoints would each need to consult it anyway. Activation is
 * the only action that requires an explicit acknowledgement, because it is the
 * only one that causes email to reach real people.
 */
import { z } from 'zod';

import { AppError } from '@/lib/errors';
import { handler } from '@/modules/api/handler';
import {
  activateCampaign,
  assessReadiness,
  requireCampaign,
  setCampaignStatus,
} from '@/modules/email/campaigns';
import { QUEUE_NAMES, getQueue } from '@/modules/jobs/queues';
import { tickJobId } from '@/modules/email/worker';

const bodySchema = z
  .object({
    action: z.enum(['start', 'pause', 'resume', 'cancel', 'complete']),
    /**
     * Required for `start`, and deliberately not defaulted.
     *
     * A campaign activation sends real email to real strangers under the
     * operator's own address. The client must state that this is intended; a
     * request that merely arrives is not enough.
     */
    acknowledgeSending: z.boolean().optional(),
  })
  .strict();

export const POST = handler(
  async ({ tenant, params, body, logger }) => {
    const campaignId = params.id!;
    const campaign = await requireCampaign(tenant, campaignId);

    if (body.action === 'start' || body.action === 'resume') {
      if (body.acknowledgeSending !== true) {
        const readiness = await assessReadiness(tenant, campaignId);
        throw new AppError({
          code: 'VALIDATION_FAILED',
          message: 'Sending was not acknowledged',
          safeMessage:
            `This will send up to ${readiness.deliverableCount} real emails from your ` +
            'connected Gmail account. Confirm to continue.',
          context: { deliverableCount: readiness.deliverableCount },
        });
      }
    }

    if (body.action === 'start') {
      const result = await activateCampaign(tenant, campaignId);

      // Kick the send chain. From here the worker schedules each subsequent
      // message itself, one at a time, honouring the delay.
      await getQueue(QUEUE_NAMES.email).add(
        'campaign-tick',
        { organizationId: tenant.organizationId, campaignId },
        { jobId: `${tickJobId(campaignId)}:start:${Date.now()}` },
      );

      logger.info({ campaignId, queued: result.queued }, 'Campaign started');
      return { status: 'RUNNING', queued: result.queued };
    }

    if (body.action === 'resume') {
      await setCampaignStatus(tenant, campaignId, 'RUNNING');
      await getQueue(QUEUE_NAMES.email).add(
        'campaign-tick',
        { organizationId: tenant.organizationId, campaignId },
        { jobId: `${tickJobId(campaignId)}:resume:${Date.now()}` },
      );
      return { status: 'RUNNING' };
    }

    const target =
      body.action === 'pause' ? 'PAUSED' : body.action === 'cancel' ? 'CANCELLED' : 'COMPLETED';

    await setCampaignStatus(tenant, campaignId, target);

    logger.info({ campaignId, from: campaign.status, to: target }, 'Campaign status changed');
    return { status: target };
  },
  {
    bodySchema,
    auditAction: 'campaign.status',
    rateLimit: { capacity: 20, refillPerSecond: 0.2 },
  },
);
