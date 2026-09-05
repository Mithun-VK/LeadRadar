/**
 * GET    /api/campaigns/{id}/steps — the sequence.
 * PUT    /api/campaigns/{id}/steps — replace it wholesale.
 *
 * PUT rather than per-step POST/PATCH/DELETE, deliberately. A sequence is
 * meaningful only as an ordered whole: step numbers must stay contiguous, and
 * editing one step at a time invites a client to leave the campaign halfway
 * through a rename (two step-2s, or a gap at step 3) between requests. Replacing
 * the set in one transaction means the sequence is never observable in an
 * inconsistent state.
 */
import { z } from 'zod';

import { AppError } from '@/lib/errors';
import { handler } from '@/modules/api/handler';
import { db } from '@/modules/database/client';
import { requireCampaign } from '@/modules/email/campaigns';

export const GET = handler(async ({ tenant, params }) => {
  const campaign = await requireCampaign(tenant, params.id!);

  const steps = await db().campaignStep.findMany({
    where: { campaignId: campaign.id },
    orderBy: { stepNumber: 'asc' },
    include: { template: { select: { id: true, name: true, subject: true } } },
  });

  return {
    campaignId: campaign.id,
    /** Zero steps is a valid, meaningful state: a single-send campaign. */
    isSequence: steps.some((step) => step.active),
    steps: steps.map((step) => ({
      id: step.id,
      stepNumber: step.stepNumber,
      delayDays: step.delayDays,
      templateId: step.templateId,
      templateName: step.template?.name ?? null,
      active: step.active,
    })),
  };
});

const stepSchema = z.object({
  /** Days after the PREVIOUS step. Step 1 is sent immediately regardless. */
  delayDays: z.number().int().min(0).max(365),
  templateId: z.string().min(1).nullable().optional(),
  active: z.boolean().optional(),
});

const bodySchema = z
  .object({
    // A cap, not a guess: a twelve-touch sequence to a cold prospect is
    // harassment however it is scheduled, and the limit should be visible in the
    // schema rather than left to the operator's judgement at 2am.
    steps: z.array(stepSchema).max(10),
  })
  .strict();

export const PUT = handler(
  async ({ tenant, params, body, logger }) => {
    const campaign = await requireCampaign(tenant, params.id!);

    /**
     * A running campaign's sequence is frozen.
     *
     * Leads are mid-flight with a `currentStepNumber` that refers to this exact
     * list. Rewriting it underneath them would silently re-send a step to some
     * leads and skip one for others, depending only on where each had got to.
     */
    if (campaign.status === 'RUNNING') {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        message: 'Cannot change the sequence of a running campaign',
        safeMessage:
          'Pause the campaign before changing its steps — leads are part-way through the current sequence.',
      });
    }

    if (campaign.status === 'COMPLETED' || campaign.status === 'CANCELLED') {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        message: `Cannot change the sequence of a ${campaign.status} campaign`,
        safeMessage: 'This campaign has finished. Duplicate it to run a changed sequence.',
      });
    }

    // Every referenced template must belong to this organization. Without this a
    // client could attach another tenant's template by guessing an id.
    const templateIds = body.steps
      .map((step) => step.templateId)
      .filter((id): id is string => typeof id === 'string');

    if (templateIds.length > 0) {
      const found = await db().emailTemplate.count({
        where: { id: { in: templateIds }, organizationId: tenant.organizationId },
      });
      if (found !== new Set(templateIds).size) {
        throw new AppError({
          code: 'NOT_FOUND',
          message: 'A referenced template does not exist in this organization',
          safeMessage: 'One of the selected templates could not be found.',
        });
      }
    }

    const steps = await db().$transaction(async (tx) => {
      await tx.campaignStep.deleteMany({ where: { campaignId: campaign.id } });

      // Step numbers are assigned by position, so they are always contiguous and
      // 1-based no matter what the client sent.
      for (const [index, step] of body.steps.entries()) {
        await tx.campaignStep.create({
          data: {
            campaignId: campaign.id,
            stepNumber: index + 1,
            // Step 1 is immediate by definition; a delay on it would mean the
            // campaign does nothing for days after activation, which is not what
            // "activate" means.
            delayDays: index === 0 ? 0 : step.delayDays,
            templateId: step.templateId ?? null,
            active: step.active ?? true,
          },
        });
      }

      return tx.campaignStep.findMany({
        where: { campaignId: campaign.id },
        orderBy: { stepNumber: 'asc' },
      });
    });

    logger.info({ campaignId: campaign.id, steps: steps.length }, 'Campaign sequence replaced');

    return {
      campaignId: campaign.id,
      isSequence: steps.some((step) => step.active),
      steps: steps.map((step) => ({
        id: step.id,
        stepNumber: step.stepNumber,
        delayDays: step.delayDays,
        templateId: step.templateId,
        active: step.active,
      })),
    };
  },
  { bodySchema, auditAction: 'campaign.steps.replace' },
);
