/**
 * The send path.
 *
 * ---------------------------------------------------------------------------
 * THE GUARD CHAIN
 * ---------------------------------------------------------------------------
 *
 * Everything between "a lead is queued" and "an email leaves" lives here, in one
 * function, in a fixed order. It is one function on purpose: a guard chain spread
 * across a worker, a service, and a route handler is a guard chain where someone
 * eventually adds a fourth call site that skips two of them.
 *
 *   0. The outbound kill switch is not thrown — checked first, applies even to
 *      the mock provider, and fails CLOSED if its state cannot be read
 *   1. Sending is enabled at all
 *   2. The campaign is still RUNNING (it may have been paused mid-flight)
 *   3. This lead has not already been sent to — the duplicate-send defence. For
 *      a sequence this is scoped to the specific STEP, and the sequence has not
 *      been terminated by a reply, unsubscribe, or bounce
 *   4. The address is still not suppressed  — re-checked at send time, not
 *      merely at enrolment, because someone may have unsubscribed in between
 *   5. The address is still syntactically valid
 *   6. The campaign's daily limit has room
 *   7. The mailbox's daily limit has room
 *   8. The template renders completely, with no blanks
 *
 * Only then is a message composed and handed to the provider.
 *
 * Note step 4 in particular. Enrolment already checked suppression, and checking
 * again costs a query — but a campaign can sit queued for days, and someone who
 * unsubscribes on Tuesday must not receive Wednesday's message. Re-checking at
 * the moment of sending is the difference between honouring an unsubscribe and
 * merely having honoured it once.
 *
 * Sequences make that argument sharper rather than changing it. The gap between
 * step 1 and step 3 is measured in weeks, so every guard here runs again for
 * every step, against live state — nothing is decided once at enrolment and
 * trusted thereafter.
 */
import { randomToken } from '@/lib/crypto';
import { env } from '@/lib/env';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { db, type TenantContext } from '@/modules/database/client';
import { isSendableEmail } from '@/modules/enrichment/contacts';
import { outboundPaused } from '@/modules/ops/controls';
import type { AiProvider, EmailSendProvider } from '@/modules/providers/contracts';
import { deriveOpportunityFlags } from '@/modules/scoring/flags';

import { accessTokenFor, recordSend, remainingDailyQuota } from './gmail-account';
import { buildMimeMessage, generateMessageId } from './mime';
import { personalize } from './personalization';
import { advanceAfterSend, isTerminalLeadStatus } from './sequence';
import { checkSuppression, suppress } from './suppression';
import { renderEmail } from './templates';

/** Why a send did not happen. Recorded against the lead, never swallowed. */
export type SendBlockReason =
  | 'SENDING_DISABLED'
  | 'CAMPAIGN_NOT_RUNNING'
  | 'ALREADY_SENT'
  | 'SUPPRESSED'
  | 'INVALID_EMAIL'
  | 'CAMPAIGN_DAILY_LIMIT'
  | 'MAILBOX_DAILY_LIMIT'
  | 'TEMPLATE_INCOMPLETE'
  | 'NO_MAILBOX'
  | 'OUTBOUND_PAUSED'
  | 'SEQUENCE_STOPPED';

export interface SendOutcome {
  readonly sent: boolean;
  readonly blocked: SendBlockReason | null;
  readonly messageId: string | null;
  readonly detail: string | null;
  /**
   * True when the block is temporary and the lead should be retried later — a
   * daily limit clears at midnight, while a suppression never does.
   */
  readonly retryLater: boolean;
}

function blocked(reason: SendBlockReason, detail: string, retryLater = false): SendOutcome {
  return { sent: false, blocked: reason, messageId: null, detail, retryLater };
}

function isSameUtcDay(a: Date | null, b: Date): boolean {
  if (!a) return false;
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

export interface SendOneInput {
  readonly campaignId: string;
  readonly businessId: string;
  /** The sequence step being sent. Absent for a single-send campaign. */
  readonly stepId?: string | null;
  /** 1-based step number, used to advance the lead after a confirmed send. */
  readonly stepNumber?: number;
  readonly provider: EmailSendProvider;
  readonly ai?: AiProvider | null;
}

/**
 * Sends one message, or explains why it did not.
 *
 * Never throws for an ordinary refusal: a suppressed address or an exhausted
 * daily limit is a normal outcome to record, not an exception that should fail a
 * worker and drag unrelated leads into a retry.
 */
export async function sendCampaignEmail(
  tenant: TenantContext,
  input: SendOneInput,
): Promise<SendOutcome> {
  const config = env();
  const log = logger().child({
    component: 'email-send',
    campaignId: input.campaignId,
    businessId: input.businessId,
  });

  // --- 0. the kill switch ---------------------------------------------------
  /**
   * First, before any other work, and it applies to the mock provider too.
   *
   * An operator who hits the brake expects everything to stop — being told
   * afterwards that mock sends carried on regardless would make the control
   * untrustworthy, and a control nobody trusts gets bypassed. This also fails
   * CLOSED: if the state cannot be read, sending stops. See modules/ops/controls.
   */
  const killSwitch = await outboundPaused(tenant);
  if (killSwitch.paused) {
    log.warn({ reason: killSwitch.reason }, 'Send blocked by the outbound kill switch');
    return blocked(
      'OUTBOUND_PAUSED',
      killSwitch.reason ?? 'Outbound email is paused for this organization.',
      // Retryable: a pause is expected to be lifted, and the lead should still be
      // waiting in the queue when it is.
      true,
    );
  }

  // --- 1. sending enabled at all -------------------------------------------
  // Checked here as well as at the registry, because this is the last point
  // before a message would actually leave.
  if (!config.EMAIL_SENDING_ENABLED && !input.provider.isMock) {
    return blocked('SENDING_DISABLED', 'Outbound email is disabled on this server.');
  }

  const campaignLead = await db().campaignLead.findFirst({
    where: {
      campaignId: input.campaignId,
      businessId: input.businessId,
      campaign: { organizationId: tenant.organizationId },
    },
    include: {
      campaign: {
        include: {
          template: { select: { subject: true, body: true } },
          gmailAccount: {
            select: { id: true, emailAddress: true, displayName: true, invalidatedAt: true },
          },
        },
      },
      business: {
        include: {
          websiteAnalyses: { where: { isCurrent: true }, take: 1 },
          recommendations: { where: { isCurrent: true }, orderBy: { strength: 'desc' }, take: 1 },
          socialProfiles: { select: { platform: true } },
        },
      },
    },
  });

  if (!campaignLead) {
    return blocked('CAMPAIGN_NOT_RUNNING', 'This lead is not enrolled in the campaign.');
  }

  const { campaign, business } = campaignLead;

  // --- 2. campaign still running -------------------------------------------
  // A campaign paused after queueing must stop immediately. Without this check a
  // paused campaign keeps sending until its queue drains, which is not what
  // "pause" means to the person who clicked it.
  if (campaign.status !== 'RUNNING') {
    return blocked(
      'CAMPAIGN_NOT_RUNNING',
      `The campaign is ${campaign.status.toLowerCase()}.`,
      campaign.status === 'PAUSED',
    );
  }

  // --- 3. never send twice --------------------------------------------------
  /**
   * A sequence step is identified by `input.stepId`. Its absence means this is a
   * single-send campaign, and the checks below are exactly what they were before
   * sequences existed — deliberately, because every campaign created before this
   * feature has no steps and must not acquire follow-up behaviour retroactively.
   */
  const isSequenceStep = input.stepId != null;

  /**
   * Terminal lead states end a sequence permanently.
   *
   * Checked FIRST for a sequence, because a lead that replied between step 1 and
   * step 2 sits at status REPLIED with `sentAt` set — and reporting that as
   * "already sent" would hide the far more important fact that they answered.
   * `stopCampaignsForLead` moves PENDING/QUEUED/SENT enrolments to REPLIED, so
   * this is the check that makes reply-termination bite for follow-ups.
   */
  if (isSequenceStep && isTerminalLeadStatus(campaignLead.status)) {
    return blocked(
      'SEQUENCE_STOPPED',
      `The sequence stopped for this lead (${campaignLead.status.toLowerCase()}).`,
    );
  }

  if (!isSequenceStep && (campaignLead.status === 'SENT' || campaignLead.sentAt !== null)) {
    return blocked('ALREADY_SENT', 'This lead has already been emailed by this campaign.');
  }

  const existingMessage = await db().emailMessage.findFirst({
    where: {
      campaignId: input.campaignId,
      businessId: input.businessId,
      // For a sequence, "already sent" is scoped to THIS step — step 1 having
      // been sent is a precondition for step 2, not an objection to it.
      ...(isSequenceStep ? { campaignStepId: input.stepId } : {}),
      status: { in: ['SENT', 'SENDING'] },
    },
    select: { id: true },
  });

  if (existingMessage) {
    // Belt and braces against a duplicated job. The authoritative guard is the
    // unique constraint on (campaignId, businessId, campaignStepId), which the
    // INSERT below hits before the provider is ever called; this read merely
    // turns the common case into a clean outcome instead of a caught violation.
    return blocked(
      'ALREADY_SENT',
      isSequenceStep
        ? 'This step has already been sent to this lead.'
        : 'A message to this lead already exists for this campaign.',
    );
  }

  /**
   * A lead already skipped at enrolment reports the reason it was skipped FOR.
   *
   * Without this the next check fires first and reports INVALID_EMAIL for a
   * suppressed lead — because enrolment clears `resolvedEmail` when it skips. The
   * outcome is the same either way (nothing is sent), but the reason an operator
   * reads would be wrong, and a wrong reason sends them looking in the wrong
   * place.
   */
  if (campaignLead.status === 'SKIPPED') {
    const reason: SendBlockReason =
      campaignLead.skipReason === 'SUPPRESSED'
        ? 'SUPPRESSED'
        : campaignLead.skipReason === 'TEMPLATE_INCOMPLETE'
          ? 'TEMPLATE_INCOMPLETE'
          : 'INVALID_EMAIL';

    return blocked(
      reason,
      `This lead was skipped at enrolment (${campaignLead.skipReason ?? 'not eligible'}).`,
    );
  }

  const recipient = campaignLead.resolvedEmail;
  if (!recipient || !isSendableEmail(recipient)) {
    return blocked('INVALID_EMAIL', 'No valid recipient address is on file for this lead.');
  }

  // --- 4. suppression, re-checked at send time -----------------------------
  const suppression = await checkSuppression(tenant, recipient);
  if (suppression.suppressed) {
    await db().campaignLead.update({
      where: { id: campaignLead.id },
      data: { status: 'SKIPPED', skipReason: 'SUPPRESSED' },
    });
    log.info({ reason: suppression.reason }, 'Send blocked by the suppression list');
    return blocked('SUPPRESSED', `This address is suppressed (${suppression.reason}).`);
  }

  // --- 5. mailbox present and healthy --------------------------------------
  const account = campaign.gmailAccount;
  if (!account || account.invalidatedAt) {
    return blocked(
      'NO_MAILBOX',
      'No working Gmail account is connected. Reconnect one to resume sending.',
      true,
    );
  }

  // --- 6. campaign daily limit ---------------------------------------------
  const now = new Date();
  const campaignSentToday = isSameUtcDay(campaign.sentCountDate, now) ? campaign.sentCountToday : 0;

  if (campaignSentToday >= campaign.dailyLimit) {
    return blocked(
      'CAMPAIGN_DAILY_LIMIT',
      `This campaign has sent its daily limit of ${campaign.dailyLimit}.`,
      true,
    );
  }

  // --- 7. mailbox daily limit ----------------------------------------------
  // Separate from the campaign limit because Gmail's quota is per mailbox:
  // several campaigns each within their own limit can still exceed what Google
  // allows, and hitting Google's ceiling can suspend sending entirely.
  const mailboxRemaining = await remainingDailyQuota(account.id);
  if (mailboxRemaining <= 0) {
    return blocked(
      'MAILBOX_DAILY_LIMIT',
      `The connected mailbox has reached its daily limit of ${config.EMAIL_DAILY_LIMIT}.`,
      true,
    );
  }

  // --- 8. render, refusing anything incomplete -----------------------------
  if (!campaign.template) {
    return blocked('TEMPLATE_INCOMPLETE', 'The campaign has no template.');
  }

  const flags = deriveOpportunityFlags({
    googleWebsiteStatus: business.googleWebsiteStatus,
    independentWebsiteStatus: business.independentWebsiteStatus,
    observations: business.websiteAnalyses[0]
      ? {
          httpsEnabled: business.websiteAnalyses[0].httpsEnabled,
          hasViewportMeta: business.websiteAnalyses[0].hasViewportMeta,
          hasTitle: business.websiteAnalyses[0].hasTitle,
          titleLength: business.websiteAnalyses[0].titleLength,
          hasMetaDescription: business.websiteAnalyses[0].hasMetaDescription,
          metaDescriptionLength: business.websiteAnalyses[0].metaDescriptionLength,
          h1Count: business.websiteAnalyses[0].h1Count,
          imageCount: business.websiteAnalyses[0].imageCount,
          imagesWithAlt: business.websiteAnalyses[0].imagesWithAlt,
          hasStructuredData: business.websiteAnalyses[0].hasStructuredData,
          hasCanonical: business.websiteAnalyses[0].hasCanonical,
          hasContactPage: business.websiteAnalyses[0].hasContactPage,
          hasBookingIndicator: business.websiteAnalyses[0].hasBookingIndicator,
          hasResponsiveHints: business.websiteAnalyses[0].hasResponsiveHints,
          internalLinkCount: business.websiteAnalyses[0].internalLinkCount,
          externalLinkCount: business.websiteAnalyses[0].externalLinkCount,
          contentLength: business.websiteAnalyses[0].contentLength,
          mixedContentCount: business.websiteAnalyses[0].mixedContentCount,
          isThin: business.websiteAnalyses[0].isThin,
          isParked: business.websiteAnalyses[0].isParked,
          isFreeHosting: business.websiteAnalyses[0].isFreeHosting,
          pageBytes: 0,
          scriptCount: 0,
          htmlUnavailable: false,
        }
      : null,
    seoScore: business.websiteAnalyses[0]?.seoScore ?? null,
    mobileScore: business.websiteAnalyses[0]?.mobileScore ?? null,
    hasEmail: true,
    socialPlatformCount: new Set(business.socialProfiles.map((p) => p.platform)).size,
    rating: business.rating,
    reviewCount: business.reviewCount,
  });

  const { values } = await personalize(
    {
      businessName: business.displayName,
      industry: business.primaryCategory,
      city: business.city,
      verifiedDomain: business.verifiedDomain,
      flags,
      recommendedService: business.recommendations[0]?.service ?? null,
      websiteQualityScore: business.websiteQualityScore,
    },
    {
      senderName: campaign.senderName ?? '',
      companyName: campaign.companyName ?? '',
      ai: campaign.useAiPersonalization ? (input.ai ?? null) : null,
    },
  );

  let rendered;
  try {
    rendered = renderEmail(campaign.template, values);
  } catch (error) {
    await db().campaignLead.update({
      where: { id: campaignLead.id },
      data: { status: 'SKIPPED', skipReason: 'TEMPLATE_INCOMPLETE' },
    });
    return blocked(
      'TEMPLATE_INCOMPLETE',
      error instanceof AppError ? error.safeMessage : 'The template could not be rendered.',
    );
  }

  // --- compose --------------------------------------------------------------
  const unsubscribeToken = randomToken(24);
  const unsubscribeUrl = `${config.APP_PUBLIC_URL.replace(/\/+$/, '')}/unsubscribe/${unsubscribeToken}`;
  const messageIdHeader = generateMessageId(
    randomToken(12),
    new URL(config.APP_PUBLIC_URL).hostname,
  );

  const mime = buildMimeMessage({
    to: recipient,
    from: account.emailAddress,
    fromName: campaign.senderName ?? account.displayName,
    subject: rendered.subject,
    body: rendered.body,
    replyTo: account.emailAddress,
    unsubscribeUrl,
    messageId: messageIdHeader,
  });

  /**
   * The message row is created as SENDING BEFORE the provider call.
   *
   * This ordering matters. If the process dies between the API call and the
   * database write, a row in SENDING is a visible "we do not know whether this
   * was delivered" — which an operator can investigate. Writing the row only
   * afterwards would lose the message entirely and the lead would be retried,
   * producing a duplicate to a real person.
   */
  const message = await db().emailMessage.create({
    data: {
      organizationId: tenant.organizationId,
      campaignId: campaign.id,
      businessId: business.id,
      gmailAccountId: account.id,
      toEmail: recipient,
      fromEmail: account.emailAddress,
      subject: rendered.subject,
      body: rendered.body,
      status: 'SENDING',
      messageIdHeader,
      unsubscribeToken,
      // Carries the unique constraint that makes a concurrent duplicate
      // impossible: (campaignId, businessId, campaignStepId).
      campaignStepId: input.stepId ?? null,
      mocked: input.provider.isMock,
      queuedAt: campaignLead.queuedAt ?? now,
      attempts: 1,
      events: { create: { type: 'SEND_ATTEMPTED', detail: `To ${recipient}` } },
    },
    select: { id: true },
  }).catch((error: unknown) => {
    /**
     * The concurrency control, resolved by the database.
     *
     * P2002 is a unique violation on (campaignId, businessId, campaignStepId):
     * another worker claimed this exact step microseconds earlier and is sending
     * it now. Losing that race is a correct outcome, not an error — this worker
     * simply stops, having sent nothing.
     *
     * Reported as ALREADY_SENT rather than rethrown, so BullMQ does not retry a
     * job whose work another worker is already doing.
     */
    if (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: string }).code === 'P2002'
    ) {
      return null;
    }
    throw error;
  });

  if (!message) {
    log.info('Lost the race to claim this step; another worker is sending it');
    return blocked('ALREADY_SENT', 'Another worker is already sending this step.');
  }

  let accessToken: string;
  try {
    accessToken = await accessTokenFor(account.id, input.provider);
  } catch (error) {
    await failMessage(message.id, campaignLead.id, error);
    throw error instanceof AppError
      ? error
      : new AppError({ code: 'INTERNAL', message: 'Could not obtain a Gmail access token' });
  }

  const result = await input.provider.send({ accessToken, mime, to: recipient });

  if (!result.ok) {
    await failMessage(message.id, campaignLead.id, result.error);

    /**
     * A permanent rejection of the ADDRESS is a bounce, and a bounced address is
     * suppressed immediately. Continuing to mail an address the provider has
     * rejected is precisely what destroys a sender's domain reputation.
     */
    if (result.error.code === 'PROVIDER_BAD_REQUEST') {
      await suppress(tenant, {
        email: recipient,
        reason: 'BOUNCED',
        detail: result.error.message.slice(0, 300),
        sourceMessageId: message.id,
      });
    }

    log.warn({ code: result.error.code, messageId: message.id }, 'Send failed');

    return {
      sent: false,
      blocked: null,
      messageId: message.id,
      detail: result.error.safeMessage,
      retryLater: result.error.isRetryable,
    };
  }

  const sentAt = new Date();

  await db().$transaction(async (tx) => {
    await tx.emailMessage.update({
      where: { id: message.id },
      data: {
        status: 'SENT',
        sentAt,
        providerMessageId: result.value.providerMessageId,
        providerThreadId: result.value.providerThreadId,
        events: { create: { type: 'SENT', detail: result.value.providerMessageId } },
      },
    });

    /**
     * Advance the sequence, or close it.
     *
     * For a sequence this sets the lead back to QUEUED with `nextStepAt` when a
     * further step remains, and to SENT only when none does. For a single-send
     * campaign it is the same flat `SENT` write as before.
     *
     * Deliberately inside the same transaction as the message update: a crash
     * between "message SENT" and "lead advanced" would otherwise leave the lead
     * eligible for a step it already received, and only the unique constraint
     * would stand between that and a duplicate.
     */
    if (isSequenceStep && input.stepNumber !== undefined) {
      await advanceAfterSend(campaignLead.id, campaign.id, input.stepNumber, sentAt, tx);
    } else {
      await tx.campaignLead.update({
        where: { id: campaignLead.id },
        data: { status: 'SENT', sentAt },
      });
    }

    await tx.campaign.update({
      where: { id: campaign.id },
      data: {
        sentCountDate: sentAt,
        sentCountToday: isSameUtcDay(campaign.sentCountDate, sentAt) ? { increment: 1 } : 1,
      },
    });
  });

  await recordSend(account.id);

  log.info({ messageId: message.id, mocked: input.provider.isMock }, 'Email sent');

  return {
    sent: true,
    blocked: null,
    messageId: message.id,
    detail: null,
    retryLater: false,
  };
}

/** Records a failure against both the message and the lead. */
async function failMessage(
  messageId: string,
  campaignLeadId: string,
  error: unknown,
): Promise<void> {
  const appError = error instanceof AppError ? error : null;

  await db().$transaction(async (tx) => {
    await tx.emailMessage.update({
      where: { id: messageId },
      data: {
        status: 'FAILED',
        errorCode: appError?.code ?? 'INTERNAL',
        lastError: (appError?.message ?? String(error)).slice(0, 500),
        events: {
          create: { type: 'FAILED', detail: (appError?.code ?? 'INTERNAL').slice(0, 200) },
        },
      },
    });

    // The lead returns to QUEUED when a retry is worthwhile, so the worker picks
    // it up again; a permanent failure marks it FAILED so it is not retried
    // forever against an address that will never accept mail.
    await tx.campaignLead.update({
      where: { id: campaignLeadId },
      data: { status: appError?.isRetryable ? 'QUEUED' : 'FAILED' },
    });
  });
}

/**
 * Records an unsubscribe.
 *
 * Idempotent, and deliberately tolerant: a mail client that pre-fetches links
 * may hit this more than once, and a second visit must not error at someone who
 * is simply trying to leave.
 */
export async function processUnsubscribe(token: string): Promise<{ acknowledged: boolean }> {
  const message = await db().emailMessage.findUnique({
    where: { unsubscribeToken: token },
    select: { id: true, organizationId: true, toEmail: true, businessId: true },
  });

  // An unknown token still reports success to the visitor. Telling them "that
  // token is invalid" is unhelpful, and confirming which tokens exist would let
  // someone enumerate them.
  if (!message) return { acknowledged: true };

  const tenant: TenantContext = { organizationId: message.organizationId };

  await suppress(tenant, {
    email: message.toEmail,
    reason: 'UNSUBSCRIBED',
    detail: 'Recipient used the unsubscribe link',
    sourceMessageId: message.id,
  });

  await db().$transaction(async (tx) => {
    await tx.emailMessage.update({
      where: { id: message.id },
      data: {
        status: 'UNSUBSCRIBED',
        events: { create: { type: 'UNSUBSCRIBED' } },
      },
    });

    if (message.businessId) {
      // Every campaign, not just this one: the request is "stop emailing me",
      // not "stop emailing me from this particular campaign".
      await tx.campaignLead.updateMany({
        where: {
          businessId: message.businessId,
          status: { in: ['PENDING', 'QUEUED'] },
        },
        data: { status: 'UNSUBSCRIBED', skipReason: 'SUPPRESSED' },
      });
    }
  });

  logger().info({ messageId: message.id }, 'Unsubscribe processed');

  return { acknowledged: true };
}
