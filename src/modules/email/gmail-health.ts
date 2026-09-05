/**
 * Gmail provider health.
 *
 * Answers one operational question — "is Gmail working, and if not, since when?"
 * — without an operator reading logs or guessing from a stalled campaign.
 *
 * ---------------------------------------------------------------------------
 * WHY FACTS RATHER THAN A STATUS COLUMN
 * ---------------------------------------------------------------------------
 *
 * The stored data is a set of timestamped facts (last auth, last send, last
 * sync, last error, consecutive failures) and the status is DERIVED from them on
 * read. The reverse — writing a status column — loses the information that
 * matters during an incident: not "it is broken" but "it last worked at 14:02,
 * and has failed eleven times since".
 *
 * Deriving also means the status cannot go stale. A written status is a claim
 * about the past that nothing updates when circumstances change; a derived one
 * is recomputed from the evidence every time it is read.
 */
import { db, type TenantContext } from '@/modules/database/client';
import { logger } from '@/lib/logger';
import { grantsRead } from '@/modules/providers/gmail/schemas';

/**
 * Consecutive failures before the provider is considered blocked rather than
 * merely degraded.
 *
 * Five, not one: a single timeout is ordinary internet weather, and treating it
 * as an outage would have campaigns stopping constantly. Five in a row is not
 * weather.
 */
export const BLOCKED_AFTER_CONSECUTIVE_FAILURES = 5;

/**
 * Health states, ordered by severity.
 *
 * - HEALTHY: recent success, no failure streak.
 * - DEGRADED: failing, but plausibly transiently. Sending continues.
 * - BLOCKED: failing persistently. Campaigns should stop.
 * - AUTH_REQUIRED: the grant is dead. No amount of retrying fixes it; a human
 *   must reconnect. Distinct from BLOCKED because the remedy is different.
 * - DISCONNECTED: no mailbox at all.
 */
export type GmailHealthState =
  | 'HEALTHY'
  | 'DEGRADED'
  | 'BLOCKED'
  | 'AUTH_REQUIRED'
  | 'DISCONNECTED';

export interface GmailHealth {
  readonly state: GmailHealthState;
  /** One sentence an operator can act on. Never contains a token or raw body. */
  readonly summary: string;
  readonly emailAddress: string | null;
  readonly connectedAt: Date | null;
  readonly lastAuthAt: Date | null;
  readonly lastSendAt: Date | null;
  readonly lastSyncAt: Date | null;
  readonly lastErrorAt: Date | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorDetail: string | null;
  readonly consecutiveFailures: number;
  readonly sentToday: number;
  /** True when the granted scopes permit inbox reads. */
  readonly canReadInbox: boolean;
  /** True when campaigns should not attempt to send right now. */
  readonly shouldStopSending: boolean;
}

function isToday(date: Date | null): boolean {
  if (!date) return false;
  const now = new Date();
  return (
    date.getUTCFullYear() === now.getUTCFullYear() &&
    date.getUTCMonth() === now.getUTCMonth() &&
    date.getUTCDate() === now.getUTCDate()
  );
}

/** The current state of the connected mailbox. */
export async function gmailHealth(tenant: TenantContext): Promise<GmailHealth> {
  const account = await db().gmailAccount.findFirst({
    where: { organizationId: tenant.organizationId },
    orderBy: { connectedAt: 'desc' },
    select: {
      emailAddress: true,
      connectedAt: true,
      grantedScopes: true,
      invalidatedAt: true,
      invalidatedCode: true,
      lastAuthAt: true,
      lastSendAt: true,
      lastSyncAt: true,
      lastErrorAt: true,
      lastErrorCode: true,
      lastErrorDetail: true,
      consecutiveFailures: true,
      sentCountToday: true,
      sentCountDate: true,
    },
  });

  if (!account) {
    return {
      state: 'DISCONNECTED',
      summary: 'No Gmail account is connected. Campaigns cannot send.',
      emailAddress: null,
      connectedAt: null,
      lastAuthAt: null,
      lastSendAt: null,
      lastSyncAt: null,
      lastErrorAt: null,
      lastErrorCode: null,
      lastErrorDetail: null,
      consecutiveFailures: 0,
      sentToday: 0,
      canReadInbox: false,
      shouldStopSending: true,
    };
  }

  const base = {
    emailAddress: account.emailAddress,
    connectedAt: account.connectedAt,
    lastAuthAt: account.lastAuthAt,
    lastSendAt: account.lastSendAt,
    lastSyncAt: account.lastSyncAt,
    lastErrorAt: account.lastErrorAt,
    lastErrorCode: account.lastErrorCode,
    lastErrorDetail: account.lastErrorDetail,
    consecutiveFailures: account.consecutiveFailures,
    sentToday: isToday(account.sentCountDate) ? account.sentCountToday : 0,
    canReadInbox: grantsRead(account.grantedScopes),
  };

  /**
   * An invalidated grant outranks a failure streak.
   *
   * The two are often present together — a revoked token produces failures — but
   * the remedy differs completely: retrying fixes DEGRADED and never fixes
   * AUTH_REQUIRED. Reporting the fixable-looking one would send an operator to
   * wait instead of to reconnect.
   */
  if (account.invalidatedAt) {
    return {
      ...base,
      state: 'AUTH_REQUIRED',
      summary:
        `Google rejected the stored credentials (${account.invalidatedCode ?? 'revoked'}). ` +
        'Reconnect the account — retrying will not help.',
      shouldStopSending: true,
    };
  }

  if (account.consecutiveFailures >= BLOCKED_AFTER_CONSECUTIVE_FAILURES) {
    return {
      ...base,
      state: 'BLOCKED',
      summary:
        `${account.consecutiveFailures} consecutive Gmail failures` +
        `${account.lastErrorCode ? ` (last: ${account.lastErrorCode})` : ''}. ` +
        'Sending is stopped until this clears.',
      shouldStopSending: true,
    };
  }

  if (account.consecutiveFailures > 0) {
    return {
      ...base,
      state: 'DEGRADED',
      summary:
        `${account.consecutiveFailures} recent Gmail failure(s)` +
        `${account.lastErrorCode ? ` (last: ${account.lastErrorCode})` : ''}. ` +
        'Still sending; watch for this clearing.',
      // Deliberately keeps sending. A transient wobble that halted every campaign
      // would cause more disruption than the wobble.
      shouldStopSending: false,
    };
  }

  return {
    ...base,
    state: 'HEALTHY',
    summary: account.lastSendAt
      ? `Working. Last send ${account.lastSendAt.toISOString()}.`
      : 'Connected. Nothing sent yet.',
    shouldStopSending: false,
  };
}

/** Operations whose success or failure moves the health state. */
export type GmailOperation = 'auth' | 'send' | 'sync';

/**
 * Records a success, clearing any failure streak.
 *
 * Clearing on ANY success is deliberate: the streak measures "is it broken right
 * now", not a lifetime error count. One good send after four failures means the
 * provider is working again.
 */
export async function recordSuccess(
  accountId: string,
  operation: GmailOperation,
  at: Date = new Date(),
): Promise<void> {
  await db()
    .gmailAccount.update({
      where: { id: accountId },
      data: {
        ...(operation === 'auth' && { lastAuthAt: at }),
        ...(operation === 'send' && { lastSendAt: at, lastUsedAt: at }),
        ...(operation === 'sync' && { lastSyncAt: at }),
        consecutiveFailures: 0,
        lastErrorAt: null,
        lastErrorCode: null,
        lastErrorDetail: null,
      },
    })
    .catch((error: unknown) => {
      // Telemetry must never break the operation it describes.
      logger().warn({ err: error, accountId }, 'Could not record Gmail success');
    });
}

/**
 * Records a failure.
 *
 * `detail` is truncated and is expected to be an already-safe message. Nothing
 * here logs or stores a token, an authorization code, or a raw response body —
 * provider errors routinely echo the request, and for Google that request can
 * carry credentials.
 */
export async function recordFailure(
  accountId: string,
  code: string,
  detail: string | null,
  at: Date = new Date(),
): Promise<void> {
  await db()
    .gmailAccount.update({
      where: { id: accountId },
      data: {
        lastErrorAt: at,
        lastErrorCode: code.slice(0, 64),
        lastErrorDetail: detail ? detail.slice(0, 300) : null,
        consecutiveFailures: { increment: 1 },
      },
    })
    .catch((error: unknown) => {
      logger().warn({ err: error, accountId }, 'Could not record Gmail failure');
    });
}

/**
 * Where the next inbox sync should resume from.
 *
 * Clamped to `maxLookbackDays` in both directions. The upper clamp is the
 * important one: without it, a mailbox that stores nothing never advances its
 * cursor and its query window grows a day per day, until the request is large
 * enough that Gmail's quota refuses it — and then replies stop being detected
 * entirely, silently.
 */
export function resumeFrom(
  cursor: Date | null,
  now: Date,
  maxLookbackDays: number,
  initialLookbackDays: number,
): Date {
  const floor = new Date(now.getTime() - maxLookbackDays * 86_400_000);

  if (!cursor) {
    return new Date(now.getTime() - initialLookbackDays * 86_400_000);
  }

  // A cursor in the future (clock skew, restored backup) would query nothing at
  // all, silently. Treat it as "now minus the usual window".
  if (cursor.getTime() > now.getTime()) {
    return new Date(now.getTime() - initialLookbackDays * 86_400_000);
  }

  return cursor.getTime() < floor.getTime() ? floor : cursor;
}

/** Advances the sync cursor after a successful sync. */
export async function advanceCursor(accountId: string, to: Date): Promise<void> {
  await db()
    .gmailAccount.update({ where: { id: accountId }, data: { inboxCursor: to } })
    .catch((error: unknown) => {
      logger().warn({ err: error, accountId }, 'Could not advance the inbox cursor');
    });
}
