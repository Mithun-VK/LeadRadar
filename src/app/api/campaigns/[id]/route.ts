/**
 * GET   /api/campaigns/{id} — full detail, including readiness and previews.
 * PATCH /api/campaigns/{id} — edit settings.
 *
 * The GET returns the readiness report alongside the campaign, because the two
 * are always needed together: an operator looking at a campaign is deciding
 * whether to activate it, and that decision needs the blockers in the same view.
 */
import { z } from 'zod';

import { AppError } from '@/lib/errors';
import { env } from '@/lib/env';
import { handler } from '@/modules/api/handler';
import { db } from '@/modules/database/client';
import {
  assessReadiness,
  campaignStats,
  requireCampaign,
  SKIP_REASON_LABELS,
} from '@/modules/email/campaigns';

export const GET = handler(async ({ tenant, params }) => {
  const campaign = await requireCampaign(tenant, params.id!);
  const [readiness, stats, leads] = await Promise.all([
    assessReadiness(tenant, campaign.id),
    campaignStats(campaign.id),
    db().campaignLead.findMany({
      where: { campaignId: campaign.id },
      orderBy: [{ status: 'asc' }, { enrolledAt: 'asc' }],
      take: 200,
      include: {
        business: {
          select: {
            id: true,
            displayName: true,
            city: true,
            primaryCategory: true,
            opportunityScore: true,
            leadPriority: true,
            websiteQualityScore: true,
          },
        },
      },
    }),
  ]);

  return {
    id: campaign.id,
    name: campaign.name,
    description: campaign.description,
    status: campaign.status,
    senderName: campaign.senderName,
    companyName: campaign.companyName,
    dailyLimit: campaign.dailyLimit,
    delaySeconds: campaign.delaySeconds,
    useAiPersonalization: campaign.useAiPersonalization,
    template: campaign.template,
    sendingFrom: campaign.gmailAccount?.emailAddress ?? null,
    mailboxHealthy: campaign.gmailAccount ? campaign.gmailAccount.invalidatedAt === null : false,
    activatedAt: campaign.activatedAt,
    completedAt: campaign.completedAt,
    createdAt: campaign.createdAt,
    readiness,
    stats,
    leads: leads.map((lead) => ({
      businessId: lead.businessId,
      businessName: lead.business.displayName,
      city: lead.business.city,
      category: lead.business.primaryCategory,
      opportunityScore: lead.business.opportunityScore,
      leadPriority: lead.business.leadPriority,
      websiteQualityScore: lead.business.websiteQualityScore,
      status: lead.status,
      skipReason: lead.skipReason,
      skipReasonLabel: lead.skipReason
        ? (SKIP_REASON_LABELS[lead.skipReason as keyof typeof SKIP_REASON_LABELS] ??
          lead.skipReason)
        : null,
      email: lead.resolvedEmail,
      // The exact text that will be sent. Shown before activation so a human
      // reviews real messages rather than a template.
      previewSubject: lead.previewSubject,
      previewBody: lead.previewBody,
      sentAt: lead.sentAt,
    })),
  };
});

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    templateId: z.string().min(1).nullable().optional(),
    senderName: z.string().trim().min(1).max(80).nullable().optional(),
    companyName: z.string().trim().min(1).max(120).nullable().optional(),
    dailyLimit: z.number().int().min(1).max(500).optional(),
    delaySeconds: z.number().int().min(5).max(86_400).optional(),
    useAiPersonalization: z.boolean().optional(),
  })
  .strict();

export const PATCH = handler(
  async ({ tenant, params, body }) => {
    const campaign = await requireCampaign(tenant, params.id!);

    /**
     * A terminal campaign is immutable. Editing a completed campaign's template
     * would silently rewrite the record of what was actually sent to real people,
     * and the stored message bodies would then disagree with the campaign.
     */
    if (campaign.status === 'COMPLETED' || campaign.status === 'CANCELLED') {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        message: `A ${campaign.status} campaign cannot be edited`,
        safeMessage: 'This campaign has finished. Duplicate it to run a changed version.',
      });
    }

    const updated = await db().campaign.update({
      where: { id: campaign.id },
      data: {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.description !== undefined && { description: body.description }),
        ...(body.templateId !== undefined && { templateId: body.templateId }),
        ...(body.senderName !== undefined && { senderName: body.senderName }),
        ...(body.companyName !== undefined && { companyName: body.companyName }),
        ...(body.dailyLimit !== undefined && { dailyLimit: body.dailyLimit }),
        ...(body.delaySeconds !== undefined && {
          delaySeconds: Math.max(env().EMAIL_MIN_DELAY_SECONDS, body.delaySeconds),
        }),
        ...(body.useAiPersonalization !== undefined && {
          useAiPersonalization: body.useAiPersonalization,
        }),
      },
      select: { id: true, name: true, status: true, dailyLimit: true, delaySeconds: true },
    });

    return updated;
  },
  { bodySchema: patchSchema, auditAction: 'campaign.update' },
);
