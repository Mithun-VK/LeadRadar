/**
 * Email queue processors.
 *
 * Two jobs, with a clear division:
 *
 *   - `processSendEmail` sends exactly one message. All the guards live in
 *     `sendCampaignEmail`; this wrapper's only job is to translate the outcome
 *     into the right queue behaviour — retry, stop, or move on.
 *
 *   - `processCampaignTick` decides what to send next. It queues ONE message at
 *     a time with a delay, rather than dumping a campaign's whole queue into
 *     Redis at activation. That difference matters: a queue full of scheduled
 *     sends is nearly impossible to stop, and "pause" must actually pause. With
 *     one-at-a-time scheduling, pausing means the chain simply stops advancing.
 */
import { jobLogger } from '@/lib/logger';
import { env } from '@/lib/env';
import { db, type TenantContext } from '@/modules/database/client';
import { QUEUE_NAMES, getQueue } from '@/modules/jobs/queues';
import {
  campaignTickPayloadSchema,
  parsePayload,
  sendEmailPayloadSchema,
  type CampaignTickPayload,
  type SendEmailPayload,
} from '@/modules/jobs/schemas';
import { providers } from '@/modules/providers/registry';
import { recordEvent } from '@/modules/database/repositories';

import { sendCampaignEmail } from './send';
import {
  activeSteps,
  dueLeads,
  hasPendingWork,
  nextDueAt,
  nextStep,
  stopSequence,
} from './sequence';

function tenantOf(payload: { organizationId: string; userId?: string }): TenantContext {
  return {
    organizationId: payload.organizationId,
    ...(payload.userId !== undefined && { userId: payload.userId }),
  };
}

/** Deterministic id, so a duplicated job cannot produce a second email. */
export function sendJobId(campaignId: string, businessId: string, stepNumber?: number): string {
  // Step-scoped so step 2 is not mistaken for a duplicate of step 1. Omitted for
  // single-send campaigns, keeping their ids byte-identical to before.
  return stepNumber === undefined
    ? `send:${campaignId}:${businessId}`
    : `send:${campaignId}:${businessId}:s${stepNumber}`;
}

export function tickJobId(campaignId: string): string {
  return `tick:${campaignId}`;
}

// ---------------------------------------------------------------------------
// Sending one message
// ---------------------------------------------------------------------------

export async function processSendEmail(
  raw: unknown,
  bullJobId?: string,
): Promise<{ sent: boolean; blocked: string | null }> {
  const payload = parsePayload<SendEmailPayload>(sendEmailPayloadSchema, raw, QUEUE_NAMES.email);
  const tenant = tenantOf(payload);
  const log = jobLogger(bullJobId ?? 'send', QUEUE_NAMES.email, {
    campaignId: payload.campaignId,
    businessId: payload.businessId,
  });

  const registry = providers();

  if (!registry.email) {
    // Not retryable: no amount of waiting configures a provider.
    log.warn('No email provider is configured; refusing to send');
    return { sent: false, blocked: 'SENDING_DISABLED' };
  }

  const outcome = await sendCampaignEmail(tenant, {
    campaignId: payload.campaignId,
    businessId: payload.businessId,
    // Absent for a single-send campaign, which keeps the pre-sequence path.
    ...(payload.stepId !== undefined && { stepId: payload.stepId }),
    ...(payload.stepNumber !== undefined && { stepNumber: payload.stepNumber }),
    provider: registry.email,
    ai: registry.ai,
  });

  /**
   * A transient provider failure is thrown so BullMQ applies its backoff and
   * retry policy. Everything else — suppressed, limit reached, already sent — is
   * a normal outcome that has been recorded and must NOT be retried as if it
   * were an error.
   */
  if (!outcome.sent && outcome.blocked === null && outcome.retryLater) {
    throw new Error(outcome.detail ?? 'Transient send failure');
  }

  // Whatever happened, keep the campaign moving. A blocked lead must not stall
  // the ones behind it.
  await scheduleNextSend(tenant, payload.campaignId, outcome.blocked);

  log.info({ sent: outcome.sent, blocked: outcome.blocked }, 'Send job finished');
  return { sent: outcome.sent, blocked: outcome.blocked };
}

/**
 * Queues the campaign's next message after the configured delay.
 *
 * A daily-limit block schedules the next attempt after the limit resets rather
 * than retrying in two minutes, so a capped campaign stops generating churn for
 * the rest of the day.
 */
async function scheduleNextSend(
  tenant: TenantContext,
  campaignId: string,
  blocked: string | null,
): Promise<void> {
  const dailyLimited = blocked === 'CAMPAIGN_DAILY_LIMIT' || blocked === 'MAILBOX_DAILY_LIMIT';
  const stopped =
    blocked === 'CAMPAIGN_NOT_RUNNING' ||
    blocked === 'SENDING_DISABLED' ||
    blocked === 'NO_MAILBOX';

  if (stopped) return;

  const campaign = await db().campaign.findFirst({
    where: { id: campaignId, organizationId: tenant.organizationId },
    select: { status: true, delaySeconds: true },
  });

  if (!campaign || campaign.status !== 'RUNNING') return;

  const delaySeconds = dailyLimited
    ? secondsUntilNextUtcDay()
    : Math.max(env().EMAIL_MIN_DELAY_SECONDS, campaign.delaySeconds);

  await getQueue(QUEUE_NAMES.email).add(
    'campaign-tick',
    { organizationId: tenant.organizationId, campaignId } satisfies CampaignTickPayload,
    {
      jobId: `${tickJobId(campaignId)}:${Date.now()}`,
      delay: delaySeconds * 1_000,
    },
  );
}

function secondsUntilNextUtcDay(): number {
  const now = new Date();
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 5, 0);
  return Math.max(60, Math.ceil((midnight - now.getTime()) / 1_000));
}

// ---------------------------------------------------------------------------
// Advancing a campaign
// ---------------------------------------------------------------------------

/**
 * Picks the next queued lead and schedules its send.
 *
 * Re-reads the campaign status every tick, which is what makes pause immediate:
 * a paused campaign simply stops scheduling, and no already-scheduled avalanche
 * has to be cancelled because none was ever created.
 */
export async function processCampaignTick(
  raw: unknown,
  bullJobId?: string,
): Promise<{ queued: number; status: string }> {
  const payload = parsePayload<CampaignTickPayload>(
    campaignTickPayloadSchema,
    raw,
    QUEUE_NAMES.email,
  );
  const tenant = tenantOf(payload);
  const log = jobLogger(bullJobId ?? 'tick', QUEUE_NAMES.email, { campaignId: payload.campaignId });

  const campaign = await db().campaign.findFirst({
    where: { id: payload.campaignId, organizationId: tenant.organizationId },
    select: { id: true, status: true, name: true },
  });

  if (!campaign) return { queued: 0, status: 'MISSING' };
  if (campaign.status !== 'RUNNING') {
    log.info({ status: campaign.status }, 'Campaign is not running; tick does nothing');
    return { queued: 0, status: campaign.status };
  }

  const now = new Date();
  const steps = await activeSteps(campaign.id);
  const [due] = await dueLeads(campaign.id, now, 1);

  if (!due) {
    /**
     * Nothing is due — but "nothing due" is not "nothing left".
     *
     * A sequence spends most of its life waiting: every lead may be sitting on a
     * follow-up three days out. Completing the campaign here would abandon all of
     * them. So the campaign finishes only when no lead has pending work at all,
     * and otherwise the tick re-arms for whenever the soonest one comes due.
     */
    if (await hasPendingWork(campaign.id)) {
      const wakeAt = await nextDueAt(campaign.id);
      const delayMs = wakeAt ? Math.max(1_000, wakeAt.getTime() - now.getTime()) : 60_000;

      await getQueue(QUEUE_NAMES.email).add(
        'campaign-tick',
        { organizationId: tenant.organizationId, campaignId: campaign.id },
        { jobId: `${tickJobId(campaign.id)}:wait:${wakeAt?.getTime() ?? Date.now()}`, delay: delayMs },
      );

      log.info({ wakeAt, delayMs }, 'No step due yet; re-armed for the next one');
      return { queued: 0, status: 'WAITING' };
    }

    // Genuinely finished. Completing here rather than leaving it RUNNING means
    // the operator sees a finished campaign instead of one that appears stuck.
    await db().campaign.update({
      where: { id: campaign.id },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });

    await recordEvent({
      organizationId: tenant.organizationId,
      level: 'INFO',
      code: 'CAMPAIGN_COMPLETED',
      message: `Campaign "${campaign.name}" finished sending.`,
      context: { campaignId: campaign.id },
    });

    log.info('Campaign completed; no leads remain queued');
    return { queued: 0, status: 'COMPLETED' };
  }

  /**
   * Which step this lead is owed.
   *
   * A campaign with no steps yields null, and the send runs with no `stepId` —
   * which is precisely the pre-sequence single-send path. That is how existing
   * campaigns keep behaving exactly as they did.
   */
  const step = nextStep(steps, due.currentStepNumber);

  if (steps.length > 0 && !step) {
    // The sequence is complete for this lead but the row was never closed —
    // possible if steps were removed while it waited. Close it rather than
    // looping on a lead that can never be advanced.
    await stopSequence(due.campaignLeadId, 'SEQUENCE_COMPLETE', 'SENT');
    log.info({ businessId: due.businessId }, 'No further steps for lead; sequence closed');
    return { queued: 0, status: 'RUNNING' };
  }

  await getQueue(QUEUE_NAMES.email).add(
    'send',
    {
      organizationId: tenant.organizationId,
      campaignId: campaign.id,
      businessId: due.businessId,
      ...(step && { stepId: step.id, stepNumber: step.stepNumber }),
    } satisfies SendEmailPayload,
    /**
     * Deterministic id, now scoped to the step. A duplicated tick cannot enqueue
     * the same step twice, and step 2 is not mistaken for a duplicate of step 1.
     */
    { jobId: sendJobId(campaign.id, due.businessId, step?.stepNumber) },
  );

  return { queued: 1, status: 'RUNNING' };
}

/**
 * Restarts the send chain for every running campaign.
 *
 * Needed because the chain lives in delayed jobs: if the worker is restarted
 * while a campaign is between messages, nothing would ever wake it again. This
 * runs on a schedule and is idempotent — a campaign that already has a pending
 * tick simply gets one more, and the deterministic send id prevents duplicates.
 */
export async function resumeRunningCampaigns(): Promise<{ resumed: number }> {
  const running = await db().campaign.findMany({
    where: { status: 'RUNNING' },
    select: { id: true, organizationId: true },
  });

  const queue = getQueue(QUEUE_NAMES.email);

  for (const campaign of running) {
    await queue.add(
      'campaign-tick',
      {
        organizationId: campaign.organizationId,
        campaignId: campaign.id,
      } satisfies CampaignTickPayload,
      { jobId: `${tickJobId(campaign.id)}:resume:${Date.now()}` },
    );
  }

  return { resumed: running.length };
}
