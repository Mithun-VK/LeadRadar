/**
 * Campaign lifecycle.
 *
 * ---------------------------------------------------------------------------
 * THE DEFAULT IS THAT NOTHING SENDS
 * ---------------------------------------------------------------------------
 *
 * Discovering leads does not enrol them. Enrolling them does not queue them.
 * Queueing them does not send them. Each of those is a separate, explicit act,
 * and the last one requires a human to activate the campaign after seeing the
 * real rendered text and the real deliverable count.
 *
 * That staging is the whole safety design. The failure this product must never
 * have is "a search finished and emails went out", and it cannot happen here
 * because there is no code path from discovery to sending.
 *
 * Enrolment is where every lead is checked and where unmailable ones are recorded
 * with a reason rather than silently dropped — so the review screen shows an
 * honest number before activation instead of an optimistic one that shrinks
 * afterwards.
 */
import type { Prisma } from '@prisma/client';

import { AppError, notFound } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { db, type TenantContext } from '@/modules/database/client';
import { isSendableEmail } from '@/modules/enrichment/contacts';
import { deriveOpportunityFlags, type FlagDetail } from '@/modules/scoring/flags';
import type { AiProvider } from '@/modules/providers/contracts';

import { personalize } from './personalization';
import { previewEmail, renderEmail } from './templates';
import { filterSuppressed } from './suppression';

export type CampaignStatus = 'DRAFT' | 'READY' | 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'CANCELLED';

/**
 * Permitted status transitions.
 *
 * An explicit table rather than scattered `if` checks, so "can a cancelled
 * campaign start again?" has exactly one answer and it is visible. Notably a
 * COMPLETED or CANCELLED campaign is terminal: restarting one would re-send to
 * leads it already contacted, and the duplicate-send constraint would then reject
 * them one at a time in a confusing way. Copying to a new campaign is the honest
 * path.
 *
 * DRAFT may go straight to RUNNING. An earlier version of this table required
 * DRAFT -> READY -> RUNNING, which was wrong in a way worth recording: nothing in
 * the product ever set READY, so no campaign could be activated at all. READY is
 * a state an operator can move a campaign into deliberately, not a gate on the
 * way to sending — the real gate is `assessReadiness`, which `activateCampaign`
 * enforces independently of this table and which cannot be skipped.
 */
const TRANSITIONS: Record<CampaignStatus, readonly CampaignStatus[]> = {
  DRAFT: ['READY', 'RUNNING', 'CANCELLED'],
  READY: ['RUNNING', 'DRAFT', 'CANCELLED'],
  RUNNING: ['PAUSED', 'COMPLETED', 'CANCELLED'],
  PAUSED: ['RUNNING', 'CANCELLED', 'COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
};

export function canTransition(from: CampaignStatus, to: CampaignStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: CampaignStatus, to: CampaignStatus): void {
  if (!canTransition(from, to)) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: `A campaign cannot move from ${from} to ${to}`,
      safeMessage:
        from === 'COMPLETED' || from === 'CANCELLED'
          ? `This campaign is ${from.toLowerCase()} and cannot be restarted. Duplicate it to run again.`
          : `A ${from.toLowerCase()} campaign cannot be ${to.toLowerCase()}.`,
    });
  }
}

// ---------------------------------------------------------------------------
// Enrolment
// ---------------------------------------------------------------------------

/** Why a lead will not be emailed. Recorded so the count shown is honest. */
export type SkipReason =
  'NO_EMAIL' | 'INVALID_EMAIL' | 'SUPPRESSED' | 'ALREADY_CONTACTED' | 'TEMPLATE_INCOMPLETE';

export const SKIP_REASON_LABELS: Record<SkipReason, string> = {
  NO_EMAIL: 'No email address was found for this business',
  INVALID_EMAIL: 'The address found is not a valid recipient',
  SUPPRESSED: 'This address is on your suppression list',
  ALREADY_CONTACTED: 'This lead was already contacted by another campaign',
  TEMPLATE_INCOMPLETE: 'The template needs details this lead does not have',
};

export interface EnrolmentSummary {
  readonly requested: number;
  readonly enrolled: number;
  readonly skipped: number;
  readonly skipReasons: Record<string, number>;
}

export interface EnrolOptions {
  /**
   * Skip leads already contacted by any other campaign.
   *
   * Default true. Enrolling the same business across three campaigns is how a
   * small operator accidentally becomes a spammer, and the recipient experiences
   * it as exactly that regardless of which campaign each message came from.
   */
  readonly excludeAlreadyContacted?: boolean;
  readonly ai?: AiProvider | null;
}

/**
 * Enrols leads into a campaign, generating a reviewable preview for each.
 *
 * Runs every check the send path will later run, at enrolment time, so the
 * operator sees the true deliverable count on the review screen. Discovering at
 * send time that 300 of 500 leads were unmailable is a bad surprise; showing it
 * before activation is just information.
 */
export async function enrolLeads(
  tenant: TenantContext,
  campaignId: string,
  businessIds: readonly string[],
  options: EnrolOptions = {},
): Promise<EnrolmentSummary> {
  const campaign = await requireCampaign(tenant, campaignId);

  if (campaign.status !== 'DRAFT' && campaign.status !== 'READY') {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: `Leads cannot be added to a ${campaign.status} campaign`,
      safeMessage: 'Pause or duplicate the campaign before changing who it targets.',
    });
  }

  if (!campaign.template) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'Campaign has no template',
      safeMessage: 'Choose an email template before adding leads.',
    });
  }

  const leads = await db().business.findMany({
    where: { id: { in: [...businessIds] }, organizationId: tenant.organizationId },
    include: {
      emailCandidates: { orderBy: { confidence: 'desc' } },
      websiteAnalyses: { where: { isCurrent: true }, take: 1 },
      recommendations: { where: { isCurrent: true }, orderBy: { strength: 'desc' }, take: 1 },
      socialProfiles: { select: { platform: true } },
    },
  });

  const addresses = leads
    .map((lead) => lead.primaryEmail ?? lead.emailCandidates[0]?.email)
    .filter((value): value is string => typeof value === 'string');

  const suppressed = await filterSuppressed(tenant, addresses);

  const alreadyContacted =
    options.excludeAlreadyContacted === false
      ? new Set<string>()
      : new Set(
          (
            await db().campaignLead.findMany({
              where: {
                businessId: { in: leads.map((lead) => lead.id) },
                status: { in: ['SENT', 'QUEUED', 'REPLIED'] },
                campaign: { organizationId: tenant.organizationId },
                NOT: { campaignId },
              },
              select: { businessId: true },
            })
          ).map((row) => row.businessId),
        );

  const skipReasons: Record<string, number> = {};
  let enrolled = 0;
  let skipped = 0;

  const noteSkip = (reason: SkipReason): void => {
    skipReasons[reason] = (skipReasons[reason] ?? 0) + 1;
    skipped += 1;
  };

  for (const lead of leads) {
    const email = lead.primaryEmail ?? lead.emailCandidates[0]?.email ?? null;

    let skipReason: SkipReason | null = null;
    if (!email) skipReason = 'NO_EMAIL';
    else if (!isSendableEmail(email)) skipReason = 'INVALID_EMAIL';
    else if (suppressed.has(email.toLowerCase())) skipReason = 'SUPPRESSED';
    else if (alreadyContacted.has(lead.id)) skipReason = 'ALREADY_CONTACTED';

    let previewSubject: string | null = null;
    let previewBody: string | null = null;

    if (!skipReason) {
      const flags = flagsFor(lead);
      const { values } = await personalize(
        {
          businessName: lead.displayName,
          industry: lead.primaryCategory,
          city: lead.city,
          verifiedDomain: lead.verifiedDomain,
          flags,
          recommendedService: lead.recommendations[0]?.service ?? null,
          websiteQualityScore: lead.websiteQualityScore,
        },
        {
          senderName: campaign.senderName ?? 'the team',
          companyName: campaign.companyName ?? '',
          ai: campaign.useAiPersonalization ? (options.ai ?? null) : null,
        },
      );

      const preview = previewEmail(campaign.template, values);
      if (preview.missing.length > 0) {
        // Refusing here is the point: this lead would have received an email with
        // literal {{placeholders}} or blanks in it.
        skipReason = 'TEMPLATE_INCOMPLETE';
      } else {
        previewSubject = preview.subject;
        previewBody = preview.body;
      }
    }

    await db().campaignLead.upsert({
      where: { campaignId_businessId: { campaignId, businessId: lead.id } },
      update: {
        status: skipReason ? 'SKIPPED' : 'PENDING',
        skipReason,
        resolvedEmail: skipReason ? null : email,
        previewSubject,
        previewBody,
      },
      create: {
        campaignId,
        businessId: lead.id,
        status: skipReason ? 'SKIPPED' : 'PENDING',
        skipReason,
        resolvedEmail: skipReason ? null : email,
        previewSubject,
        previewBody,
      },
    });

    if (skipReason) noteSkip(skipReason);
    else enrolled += 1;
  }

  logger().info(
    { campaignId, requested: businessIds.length, enrolled, skipped },
    'Campaign leads enrolled',
  );

  return { requested: businessIds.length, enrolled, skipped, skipReasons };
}

/** Rebuilds flags from stored analysis, so previews match the lead detail page. */
function flagsFor(lead: {
  googleWebsiteStatus: string;
  independentWebsiteStatus: string;
  rating: number | null;
  reviewCount: number | null;
  primaryEmail: string | null;
  socialProfiles: readonly { platform: string }[];
  websiteAnalyses: readonly {
    httpsEnabled: boolean;
    hasViewportMeta: boolean;
    hasTitle: boolean;
    titleLength: number | null;
    hasMetaDescription: boolean;
    metaDescriptionLength: number | null;
    h1Count: number;
    imageCount: number;
    imagesWithAlt: number;
    hasStructuredData: boolean;
    hasCanonical: boolean;
    hasContactPage: boolean;
    hasBookingIndicator: boolean;
    hasResponsiveHints: boolean;
    internalLinkCount: number;
    externalLinkCount: number;
    contentLength: number;
    mixedContentCount: number;
    isThin: boolean;
    isParked: boolean;
    isFreeHosting: boolean;
    seoScore: number;
    mobileScore: number;
  }[];
}): FlagDetail[] {
  const analysis = lead.websiteAnalyses[0] ?? null;

  return deriveOpportunityFlags({
    googleWebsiteStatus: lead.googleWebsiteStatus,
    independentWebsiteStatus: lead.independentWebsiteStatus,
    observations: analysis
      ? {
          httpsEnabled: analysis.httpsEnabled,
          hasViewportMeta: analysis.hasViewportMeta,
          hasTitle: analysis.hasTitle,
          titleLength: analysis.titleLength,
          hasMetaDescription: analysis.hasMetaDescription,
          metaDescriptionLength: analysis.metaDescriptionLength,
          h1Count: analysis.h1Count,
          imageCount: analysis.imageCount,
          imagesWithAlt: analysis.imagesWithAlt,
          hasStructuredData: analysis.hasStructuredData,
          hasCanonical: analysis.hasCanonical,
          hasContactPage: analysis.hasContactPage,
          hasBookingIndicator: analysis.hasBookingIndicator,
          hasResponsiveHints: analysis.hasResponsiveHints,
          internalLinkCount: analysis.internalLinkCount,
          externalLinkCount: analysis.externalLinkCount,
          contentLength: analysis.contentLength,
          mixedContentCount: analysis.mixedContentCount,
          isThin: analysis.isThin,
          isParked: analysis.isParked,
          isFreeHosting: analysis.isFreeHosting,
          pageBytes: 0,
          scriptCount: 0,
          htmlUnavailable: false,
        }
      : null,
    seoScore: analysis?.seoScore ?? null,
    mobileScore: analysis?.mobileScore ?? null,
    hasEmail: lead.primaryEmail !== null,
    socialPlatformCount: new Set(lead.socialProfiles.map((p) => p.platform)).size,
    rating: lead.rating,
    reviewCount: lead.reviewCount,
  });
}

// ---------------------------------------------------------------------------
// Readiness and activation
// ---------------------------------------------------------------------------

export interface ReadinessReport {
  readonly ready: boolean;
  /** Blocking problems. A campaign with any of these cannot be activated. */
  readonly blockers: readonly string[];
  /** Non-blocking observations the operator should still see. */
  readonly warnings: readonly string[];
  readonly deliverableCount: number;
  readonly skippedCount: number;
  readonly estimatedDays: number;
}

/**
 * Everything that must be true before a campaign may send.
 *
 * Returned as a report rather than a boolean so the UI can show the operator
 * precisely what is missing. "Cannot activate" with no explanation is the kind of
 * dead end that leads someone to work around the tool.
 */
export async function assessReadiness(
  tenant: TenantContext,
  campaignId: string,
): Promise<ReadinessReport> {
  const campaign = await requireCampaign(tenant, campaignId);

  const [deliverable, skipped, account] = await Promise.all([
    db().campaignLead.count({ where: { campaignId, status: 'PENDING' } }),
    db().campaignLead.count({ where: { campaignId, status: 'SKIPPED' } }),
    db().gmailAccount.findFirst({
      where: { organizationId: tenant.organizationId, invalidatedAt: null },
      select: { id: true, emailAddress: true },
    }),
  ]);

  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!campaign.template) blockers.push('No email template is selected.');
  if (!account) {
    blockers.push('No working Gmail account is connected. Connect one in Settings.');
  }
  if (deliverable === 0) {
    blockers.push('No leads in this campaign can be emailed. Add leads with contact addresses.');
  }
  if (!campaign.senderName) blockers.push('Set a sender name so recipients know who is writing.');
  if (!campaign.companyName) {
    blockers.push('Set a company name — an outreach email must identify the sender.');
  }

  if (skipped > 0) {
    warnings.push(`${skipped} lead(s) will be skipped. Review the reasons before activating.`);
  }
  if (campaign.dailyLimit > 100) {
    warnings.push(
      `A daily limit of ${campaign.dailyLimit} is high for a personal Gmail account and risks ` +
        'hitting a sending limit or being classified as bulk mail.',
    );
  }

  const estimatedDays =
    deliverable === 0 ? 0 : Math.ceil(deliverable / Math.max(1, campaign.dailyLimit));
  if (estimatedDays > 30) {
    warnings.push(
      `At ${campaign.dailyLimit} per day this campaign will take about ${estimatedDays} days to finish.`,
    );
  }

  return {
    ready: blockers.length === 0,
    blockers,
    warnings,
    deliverableCount: deliverable,
    skippedCount: skipped,
    estimatedDays,
  };
}

/**
 * Activates a campaign.
 *
 * Refuses unless readiness passes, records who activated it and when, and marks
 * every deliverable lead QUEUED. The audit trail matters: sending is an act with
 * consequences for real recipients, and "who turned this on" must be answerable.
 */
export async function activateCampaign(
  tenant: TenantContext,
  campaignId: string,
): Promise<{ queued: number }> {
  const campaign = await requireCampaign(tenant, campaignId);
  assertTransition(campaign.status as CampaignStatus, 'RUNNING');

  const readiness = await assessReadiness(tenant, campaignId);
  if (!readiness.ready) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: `Campaign is not ready: ${readiness.blockers.join('; ')}`,
      safeMessage: readiness.blockers.join(' '),
      context: { blockers: readiness.blockers },
    });
  }

  /**
   * A campaign already assigned to a mailbox keeps it.
   *
   * This previously always took the organization's first healthy account, which
   * silently reassigned a campaign deliberately set to send from mailbox B over
   * to mailbox A — changing the From address a prospect sees, and breaking reply
   * threading against the mailbox that actually sent the original.
   */
  const account =
    (campaign.gmailAccount && campaign.gmailAccount.invalidatedAt === null
      ? { id: campaign.gmailAccount.id }
      : null) ??
    (await db().gmailAccount.findFirst({
      where: { organizationId: tenant.organizationId, invalidatedAt: null },
      orderBy: { connectedAt: 'desc' },
      select: { id: true },
    }));

  const queued = await db().$transaction(async (tx) => {
    const { count } = await tx.campaignLead.updateMany({
      where: { campaignId, status: 'PENDING' },
      data: { status: 'QUEUED', queuedAt: new Date() },
    });

    await tx.campaign.update({
      where: { id: campaignId },
      data: {
        status: 'RUNNING',
        activatedAt: new Date(),
        activatedByUserId: tenant.userId ?? null,
        gmailAccountId: account?.id ?? null,
      },
    });

    return count;
  });

  logger().info(
    { campaignId, queued, activatedBy: tenant.userId },
    'Campaign activated; leads queued for sending',
  );

  return { queued };
}

export async function setCampaignStatus(
  tenant: TenantContext,
  campaignId: string,
  status: CampaignStatus,
): Promise<void> {
  const campaign = await requireCampaign(tenant, campaignId);
  assertTransition(campaign.status as CampaignStatus, status);

  await db().$transaction(async (tx) => {
    await tx.campaign.update({
      where: { id: campaignId },
      data: {
        status,
        ...(status === 'COMPLETED' || status === 'CANCELLED' ? { completedAt: new Date() } : {}),
      },
    });

    /**
     * Cancelling returns queued leads to PENDING rather than leaving them QUEUED.
     * A queued lead in a cancelled campaign is ambiguous — it looks like work
     * still to do — and the worker must have no way to pick it up later.
     */
    if (status === 'CANCELLED') {
      await tx.campaignLead.updateMany({
        where: { campaignId, status: 'QUEUED' },
        data: { status: 'PENDING', queuedAt: null },
      });
    }
  });

  logger().info({ campaignId, status }, 'Campaign status changed');
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function requireCampaign(tenant: TenantContext, campaignId: string) {
  const campaign = await db().campaign.findFirst({
    where: { id: campaignId, organizationId: tenant.organizationId },
    include: {
      template: { select: { id: true, name: true, subject: true, body: true } },
      gmailAccount: { select: { id: true, emailAddress: true, invalidatedAt: true } },
    },
  });

  if (!campaign) throw notFound('Campaign', { campaignId });
  return campaign;
}

export async function campaignStats(campaignId: string) {
  const [byLeadStatus, byMessageStatus] = await Promise.all([
    db().campaignLead.groupBy({
      by: ['status'],
      where: { campaignId },
      _count: { _all: true },
    }),
    db().emailMessage.groupBy({
      by: ['status'],
      where: { campaignId },
      _count: { _all: true },
    }),
  ]);

  const leads: Record<string, number> = {};
  for (const row of byLeadStatus) leads[row.status] = row._count._all;

  const messages: Record<string, number> = {};
  for (const row of byMessageStatus) messages[row.status] = row._count._all;

  return { leads, messages };
}

export async function listCampaigns(
  tenant: TenantContext,
  options: { status?: string[]; page?: number; pageSize?: number } = {},
) {
  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, options.pageSize ?? 25));

  const where: Prisma.CampaignWhereInput = { organizationId: tenant.organizationId };
  if (options.status?.length) where.status = { in: options.status as never[] };

  const [rows, total] = await Promise.all([
    db().campaign.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        template: { select: { name: true } },
        _count: { select: { leads: true, messages: true } },
      },
    }),
    db().campaign.count({ where }),
  ]);

  return { rows, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

/** Re-exported so route handlers can render a message without duplicating logic. */
export { renderEmail };
