/**
 * Gmail inbox synchronisation and reply handling.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS STORED, AND WHAT IS NOT
 * ---------------------------------------------------------------------------
 *
 * Reading a mailbox means seeing messages that have nothing to do with
 * LeadRadar — the operator's accountant, their family, their other customers.
 * Two rules bound what survives the sync:
 *
 *   1. A message is stored ONLY if it matches a lead. Matching happens in
 *      memory; unmatched messages are discarded and never written. That filter
 *      lives here rather than in the provider, so the rule exists in exactly one
 *      place regardless of how many providers are added later.
 *   2. Stored bodies carry `bodyExpiresAt` and are purged by the retention job.
 *      The classification outcome is durable because it drives the pipeline; the
 *      raw third-party text is not, because we have no continuing need for it.
 *
 * ---------------------------------------------------------------------------
 * MATCHING
 * ---------------------------------------------------------------------------
 *
 * Strongest signal first, and no guessing:
 *
 *   1. `In-Reply-To` matches a Message-ID we generated. Near-certain.
 *   2. Thread id matches a thread we started. Very strong.
 *   3. Sender address matches a lead we actually emailed. Strong, and the only
 *      one that can be wrong — two leads sharing an address, which the unique
 *      constraint on EmailCandidate makes rare but not impossible.
 *
 * There is deliberately no fuzzy matching on name or domain. A misattributed
 * reply moves the wrong lead through the pipeline and stops the wrong campaign,
 * and neither is worth the extra match rate.
 */
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { db, type TenantContext } from '@/modules/database/client';
import { normalizeEmail } from '@/modules/enrichment/contacts';
import type { AiProvider, EmailSendProvider, InboundMessage } from '@/modules/providers/contracts';
import { grantsRead } from '@/modules/providers/gmail/schemas';
import { applyLeadEvent, markEmailInvalid, recordTouch } from '@/modules/crm/leads';
import { ensureSystemActivity } from '@/modules/crm/activities';

import { accessTokenFor } from './gmail-account';
import { advanceCursor, recordFailure, recordSuccess, resumeFrom } from './gmail-health';
import { actionsFor, classifyIntent, type IntentResult } from './intent';
import { suppress } from './suppression';

/** How long a stored reply body is kept. See docs/DATA_RETENTION.md. */
export const BODY_RETENTION_DAYS = 90;

/** How far back a sync looks when it has never run. */
const INITIAL_LOOKBACK_DAYS = 7;
/**
 * Hard ceiling on how far back a sync will ever look.
 *
 * Bounds the worst case if the cursor is lost, restored from an old backup, or
 * never advanced: the query stays a fixed size instead of growing until Gmail's
 * quota refuses it.
 */
const MAX_LOOKBACK_DAYS = 30;

export interface SyncResult {
  readonly fetched: number;
  readonly matched: number;
  readonly stored: number;
  readonly replies: number;
  readonly skippedNoScope: boolean;
}

interface MatchTarget {
  readonly businessId: string;
  readonly campaignId: string | null;
  readonly outboundMessageId: string | null;
}

/**
 * Synchronises one connected mailbox.
 *
 * Never throws for an ordinary condition — a missing scope, an empty mailbox, an
 * unmatched message are all normal. Only a genuine infrastructure failure
 * propagates, so a scheduled sync does not fill the dead-letter queue with
 * expected outcomes.
 */
export async function syncInbox(
  tenant: TenantContext,
  provider: EmailSendProvider,
  options: { ai?: AiProvider | null; maxMessages?: number } = {},
): Promise<SyncResult> {
  const log = logger().child({ component: 'inbox-sync', organizationId: tenant.organizationId });

  const account = await db().gmailAccount.findFirst({
    where: { organizationId: tenant.organizationId, invalidatedAt: null },
    select: {
      id: true,
      emailAddress: true,
      grantedScopes: true,
      lastUsedAt: true,
      inboxCursor: true,
    },
  });

  if (!account) {
    return { fetched: 0, matched: 0, stored: 0, replies: 0, skippedNoScope: false };
  }

  /**
   * An account connected before read access was requested keeps working for
   * sending and is simply not synced. Failing loudly here would break outbound
   * mail for an operator who has done nothing wrong; the UI prompts them to
   * reconnect instead.
   */
  if (!provider.isMock && !grantsRead(account.grantedScopes)) {
    log.info(
      { accountId: account.id },
      'Connected mailbox has no read scope; skipping sync until reconnected',
    );
    return { fetched: 0, matched: 0, stored: 0, replies: 0, skippedNoScope: true };
  }

  /**
   * Resume from the PERSISTED cursor, clamped.
   *
   * This previously derived the resume point from the newest stored inbound
   * message, which advances only when something matched. A mailbox that receives
   * no matching replies therefore never advanced, and the query window grew by a
   * day every day: an organization whose last reply was six months ago would ask
   * Gmail for a 180-day window every ten minutes, until the quota refused it and
   * reply detection stopped silently. The clamp bounds the worst case; the
   * cursor, advanced after every successful sync below, prevents it arising.
   */
  const startedAt = new Date();
  const since = resumeFrom(
    account.inboxCursor,
    startedAt,
    MAX_LOOKBACK_DAYS,
    INITIAL_LOOKBACK_DAYS,
  );

  const accessToken = await accessTokenFor(account.id, provider);
  const fetched = await provider.fetchInbox({
    accessToken,
    since,
    ...(options.maxMessages !== undefined && { maxMessages: options.maxMessages }),
  });

  if (!fetched.ok) {
    const error =
      fetched.error instanceof AppError
        ? fetched.error
        : new AppError({ code: 'PROVIDER_UNAVAILABLE', message: 'Inbox fetch failed' });

    // Recorded before rethrowing, so a repeatedly failing sync becomes visible as
    // DEGRADED and then BLOCKED rather than only as log noise.
    await recordFailure(account.id, error.code, error.safeMessage ?? null);
    throw error;
  }

  const messages = fetched.value;
  let matched = 0;
  let stored = 0;
  let replies = 0;

  for (const message of messages) {
    // Our own sent mail comes back in the same query. Treating it as a reply
    // would have the system replying to itself.
    if (message.isFromSelf) continue;
    if (normalizeEmail(message.fromEmail) === normalizeEmail(account.emailAddress)) continue;

    const target = await matchMessage(tenant, message);
    // Unmatched: read, not stored. This is the retention rule in action.
    if (!target) continue;

    matched += 1;

    const outcome = await recordInboundMessage(tenant, message, target, options.ai ?? null);
    if (outcome.stored) stored += 1;
    if (outcome.isReply) replies += 1;
  }

  /**
   * Advance the cursor to when the sync STARTED, not to now.
   *
   * A message that arrived while the sync was running would otherwise fall in the
   * gap between the two instants and never be read. Re-reading a few seconds of
   * overlap is free — `recordInboundMessage` is idempotent on
   * (organizationId, messageId) — whereas a missed reply is not recoverable.
   */
  await advanceCursor(account.id, startedAt);
  await recordSuccess(account.id, 'sync', startedAt);

  log.info({ fetched: messages.length, matched, stored, replies }, 'Inbox sync complete');

  return { fetched: messages.length, matched, stored, replies, skippedNoScope: false };
}

/** Finds the lead a message belongs to, or null. */
async function matchMessage(
  tenant: TenantContext,
  message: InboundMessage,
): Promise<MatchTarget | null> {
  // 1. In-Reply-To against a Message-ID we generated.
  if (message.inReplyTo) {
    const header = message.inReplyTo.replace(/^<|>$/g, '');
    const outbound = await db().emailMessage.findFirst({
      where: { organizationId: tenant.organizationId, messageIdHeader: header },
      select: { id: true, businessId: true, campaignId: true },
    });

    if (outbound?.businessId) {
      return {
        businessId: outbound.businessId,
        campaignId: outbound.campaignId,
        outboundMessageId: outbound.id,
      };
    }
  }

  // 2. Thread id against a thread we started.
  const byThread = await db().emailMessage.findFirst({
    where: { organizationId: tenant.organizationId, providerThreadId: message.threadId },
    orderBy: { sentAt: 'desc' },
    select: { id: true, businessId: true, campaignId: true },
  });

  if (byThread?.businessId) {
    return {
      businessId: byThread.businessId,
      campaignId: byThread.campaignId,
      outboundMessageId: byThread.id,
    };
  }

  // 3. Sender address against a lead we actually emailed. The `toEmail` join is
  // what keeps this from matching a lead we merely know about.
  const normalised = normalizeEmail(message.fromEmail);
  if (!normalised) return null;

  const byAddress = await db().emailMessage.findFirst({
    where: {
      organizationId: tenant.organizationId,
      toEmail: normalised,
      status: { in: ['SENT', 'REPLIED'] },
    },
    orderBy: { sentAt: 'desc' },
    select: { id: true, businessId: true, campaignId: true },
  });

  if (byAddress?.businessId) {
    return {
      businessId: byAddress.businessId,
      campaignId: byAddress.campaignId,
      outboundMessageId: byAddress.id,
    };
  }

  return null;
}

/**
 * Stores a matched message, classifies it, and applies the consequences.
 *
 * Idempotent on `(organizationId, messageId)`: a re-sync that sees the same
 * message again does nothing rather than stopping a campaign twice or raising a
 * duplicate task.
 */
async function recordInboundMessage(
  tenant: TenantContext,
  message: InboundMessage,
  target: MatchTarget,
  ai: AiProvider | null,
): Promise<{ stored: boolean; isReply: boolean }> {
  const existing = await db().emailConversation.findUnique({
    where: {
      organizationId_messageId: {
        organizationId: tenant.organizationId,
        messageId: message.providerMessageId,
      },
    },
    select: { id: true },
  });

  if (existing) return { stored: false, isReply: false };

  const conversation = await db().emailConversation.create({
    data: {
      organizationId: tenant.organizationId,
      businessId: target.businessId,
      campaignId: target.campaignId,
      threadId: message.threadId,
      messageId: message.providerMessageId,
      direction: 'INBOUND',
      fromEmail: message.fromEmail,
      toEmail: message.toEmail,
      subject: message.subject,
      body: message.body,
      bodyExpiresAt: new Date(Date.now() + BODY_RETENTION_DAYS * 24 * 60 * 60 * 1000),
      receivedAt: message.receivedAt,
      inReplyToMessageId: target.outboundMessageId,
    },
    select: { id: true },
  });

  const intent = await classifyIntent(
    { subject: message.subject, body: message.body },
    ai,
  );

  await db().emailIntent.create({
    data: {
      conversationId: conversation.id,
      intent: intent.intent,
      confidence: intent.confidence,
      source: intent.source,
      reason: intent.reason,
      model: intent.model,
      actedOn: false,
    },
  });

  const isReply = await applyIntent(tenant, target, intent, conversation.id);
  return { stored: true, isReply };
}

/**
 * Applies the consequences of a classified reply.
 *
 * Every irreversible act here is gated on deterministic evidence or high
 * confidence; everything else raises work for a person. See `actionsFor`.
 */
export async function applyIntent(
  tenant: TenantContext,
  target: MatchTarget,
  intent: IntentResult,
  conversationId: string,
): Promise<boolean> {
  const actions = actionsFor(intent);
  const log = logger().child({ component: 'reply-handler', businessId: target.businessId });

  // An out-of-office is not a reply and must not stop a sequence.
  if (intent.intent === 'OUT_OF_OFFICE') {
    log.info('Auto-reply detected; sequence continues');
    return false;
  }

  await recordTouch(tenant, target.businessId, 'INBOUND');

  if (actions.stopCampaign) {
    await stopCampaignsForLead(tenant, target.businessId, target.campaignId);
  }

  if (actions.suppressPermanently) {
    const conversation = await db().emailConversation.findUnique({
      where: { id: conversationId },
      select: { fromEmail: true },
    });

    if (conversation) {
      await suppress(tenant, {
        email: conversation.fromEmail,
        reason: 'UNSUBSCRIBED',
        detail: intent.reason ?? 'Replied asking to be removed',
      });
    }
  }

  if (actions.markEmailInvalid) {
    await markEmailInvalid(tenant, target.businessId);
  }

  if (actions.leadEvent) {
    await applyLeadEvent(
      tenant,
      target.businessId,
      actions.leadEvent,
      `Reply classified as ${intent.intent}`,
      intent.source === 'AI' ? 'AI' : 'EMAIL',
    );
  }

  if (actions.task) {
    await ensureSystemActivity(tenant, {
      businessId: target.businessId,
      type: intent.intent === 'MEETING_REQUEST' ? 'MEETING' : 'FOLLOW_UP',
      title: actions.task.title,
      description: actions.task.description,
      // Due now: these are replies from real people waiting on an answer.
      dueAt: new Date(),
    });
  }

  await db().emailIntent.updateMany({
    where: { conversationId },
    data: { actedOn: true },
  });

  log.info(
    { intent: intent.intent, source: intent.source, confidence: intent.confidence },
    'Reply handled',
  );

  return true;
}

/**
 * Stops sending to one lead.
 *
 * Marks the lead's enrolments REPLIED rather than pausing the whole campaign:
 * one person replying must not stop outreach to the other 400 businesses. When
 * `campaignId` is given the reply is attributed to that campaign, but every
 * enrolment is stopped regardless — a lead who replies to one campaign should not
 * keep receiving another.
 */
export async function stopCampaignsForLead(
  tenant: TenantContext,
  businessId: string,
  campaignId: string | null,
): Promise<{ stopped: number }> {
  const { count } = await db().campaignLead.updateMany({
    where: {
      businessId,
      campaign: { organizationId: tenant.organizationId },
      status: { in: ['PENDING', 'QUEUED'] },
    },
    data: { status: 'REPLIED' },
  });

  // The enrolment that produced the reply is marked even if it had already sent,
  // so campaign stats show the reply against the right campaign.
  if (campaignId) {
    await db().campaignLead.updateMany({
      where: { campaignId, businessId, status: 'SENT' },
      data: { status: 'REPLIED' },
    });

    await db().emailMessage.updateMany({
      where: { campaignId, businessId, status: 'SENT' },
      data: { status: 'REPLIED' },
    });
  }

  if (count > 0) {
    logger().info({ businessId, stopped: count }, 'Pending sends stopped after a reply');
  }

  return { stopped: count };
}

/**
 * Purges expired reply bodies.
 *
 * The conversation row survives — it is what makes "this lead replied on the
 * 3rd" answerable, and it contains no third-party prose. Only the body goes.
 */
export async function purgeExpiredBodies(now: Date = new Date()): Promise<number> {
  const { count } = await db().emailConversation.updateMany({
    where: { bodyExpiresAt: { lt: now }, body: { not: null } },
    data: { body: null, bodyExpiresAt: null },
  });

  return count;
}

export async function listConversations(tenant: TenantContext, businessId: string) {
  return db().emailConversation.findMany({
    where: { organizationId: tenant.organizationId, businessId },
    orderBy: { receivedAt: 'desc' },
    include: { intent: true, campaign: { select: { id: true, name: true } } },
  });
}
