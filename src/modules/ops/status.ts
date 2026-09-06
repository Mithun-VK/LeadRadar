/**
 * Operational status.
 *
 * One call that answers every question an operator asks when something looks
 * wrong, in the order they ask them. Assembled from the subsystems that already
 * track their own state — this module measures nothing itself, it correlates.
 *
 * ---------------------------------------------------------------------------
 * ALERTS ARE DERIVED, NOT STORED
 * ---------------------------------------------------------------------------
 *
 * Thresholds live here as constants and are evaluated on read. There is no alert
 * table, no notification queue, and no scheduler firing checks — because the
 * simplest production-grade mechanism compatible with this stack is an endpoint
 * an uptime monitor already polls. Adding an alerting platform would be a second
 * system to keep alive, and a monitoring system that can itself fail silently is
 * worse than none.
 *
 * Each alert carries what is wrong, how bad, and what to do. An alert an operator
 * has to interpret at 3am is an alert that gets ignored.
 */
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { databaseHealthy, db, type TenantContext } from '@/modules/database/client';
import { redisHealthy } from '@/lib/redis';
import { queueDepths, type QueueDepth } from '@/modules/jobs/queues';
import { gmailHealth, type GmailHealth } from '@/modules/email/gmail-health';
import { allControls, type ControlState } from '@/modules/ops/controls';
import { workerStatus, type WorkerStatus } from '@/modules/ops/heartbeat';
import { diskHealth, type DiskHealth, type DiskState } from '@/modules/ops/disk';

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/**
 * Every number here is a judgement, so each carries its reasoning. A threshold
 * without a rationale gets "tuned" until it never fires.
 */
export const THRESHOLDS = {
  /** Worker heartbeat older than this means the worker is gone, not merely busy. */
  workerStaleSeconds: 90,
  /** Waiting jobs on one queue before the backlog is worth a look. */
  queueBacklogWarn: 500,
  /** Waiting jobs before it is an incident: the worker cannot keep up at all. */
  queueBacklogCritical: 5_000,
  /** Dead-lettered jobs before someone must inspect them. */
  deadLetterWarn: 10,
  /**
   * Share of recent sends that failed before it is an alert.
   *
   * 20%, not 1%: individual sends fail for ordinary reasons (a bad address, a
   * transient 5xx) and a tight threshold would fire constantly. One send in five
   * failing is a provider problem, not bad luck.
   */
  sendFailureRate: 0.2,
  /** Minimum sends before the failure rate means anything at all. */
  sendFailureMinSample: 10,
  /** Inbox sync older than this means replies are not being detected. */
  inboxSyncStaleMinutes: 45,
  /** A RUNNING campaign with no send in this long is stuck. */
  stuckCampaignHours: 26,
} as const;

export type AlertSeverity = 'critical' | 'warning';

export interface Alert {
  readonly severity: AlertSeverity;
  readonly code: string;
  /** What is wrong, in one sentence. */
  readonly message: string;
  /** What to do about it. */
  readonly action: string;
}

export interface OpsStatus {
  readonly status: 'ok' | 'degraded' | 'critical';
  readonly checkedAt: string;
  readonly infrastructure: {
    readonly database: boolean;
    readonly databaseLatencyMs: number | null;
    readonly redis: boolean;
    readonly redisLatencyMs: number | null;
  };
  readonly workers: WorkerStatus;
  readonly disk: DiskHealth;
  readonly queues: readonly QueueDepth[];
  readonly gmail: GmailHealth;
  readonly controls: readonly ControlState[];
  readonly email: {
    readonly sentLast24h: number;
    readonly failedLast24h: number;
    readonly failureRate: number | null;
    readonly queued: number;
    readonly lastSyncAt: string | null;
  };
  readonly campaigns: {
    readonly running: number;
    readonly stuck: number;
  };
  readonly alerts: readonly Alert[];
  readonly mockMode: boolean;
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - start };
}

/**
 * Full operational picture for one organization.
 *
 * Never throws. An observability endpoint that fails when the system is unwell is
 * an observability endpoint that is useless exactly when it is needed, so every
 * subsystem read is individually guarded and a failure becomes a reported fact
 * rather than a 500.
 */
export async function opsStatus(tenant: TenantContext): Promise<OpsStatus> {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const org = { organizationId: tenant.organizationId };

  const [dbCheck, redisCheck, workers, queues, gmail, controls, disk] = await Promise.all([
    timed(() => databaseHealthy()).catch(() => ({ value: false, ms: null as number | null })),
    timed(() => redisHealthy()).catch(() => ({ value: false, ms: null as number | null })),
    workerStatus().catch(
      (): WorkerStatus => ({
        alive: false,
        workers: [],
        staleSeconds: null,
        summary: 'Worker status could not be read.',
      }),
    ),
    queueDepths().catch((): QueueDepth[] => []),
    gmailHealth(tenant).catch(
      () =>
        ({
          state: 'DISCONNECTED',
          summary: 'Gmail health could not be read.',
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
        }) as GmailHealth,
    ),
    allControls(tenant).catch((): ControlState[] => []),
    diskHealth(),
  ]);

  const [sent24h, failed24h, queuedMessages, runningCampaigns, stuckCampaigns] = await Promise.all([
    db().emailMessage.count({ where: { ...org, status: 'SENT', sentAt: { gte: since24h } } }).catch(() => 0),
    db()
      .emailMessage.count({
        where: { ...org, status: { in: ['FAILED', 'BOUNCED'] }, updatedAt: { gte: since24h } },
      })
      .catch(() => 0),
    db().emailMessage.count({ where: { ...org, status: { in: ['QUEUED', 'SENDING'] } } }).catch(() => 0),
    db().campaign.count({ where: { ...org, status: 'RUNNING' } }).catch(() => 0),
    /**
     * A campaign that is RUNNING but has sent nothing recently.
     *
     * The most common silent failure in this system: the campaign looks active on
     * the dashboard while the worker is dead, the mailbox is revoked, or the
     * chain of delayed jobs was lost. Nothing else surfaces it.
     */
    db()
      .campaign.count({
        where: {
          ...org,
          status: 'RUNNING',
          activatedAt: { lt: new Date(Date.now() - THRESHOLDS.stuckCampaignHours * 3_600_000) },
          messages: {
            none: { sentAt: { gte: new Date(Date.now() - THRESHOLDS.stuckCampaignHours * 3_600_000) } },
          },
        },
      })
      .catch(() => 0),
  ]);

  const totalSendAttempts = sent24h + failed24h;
  const failureRate = totalSendAttempts > 0 ? failed24h / totalSendAttempts : null;

  // -------------------------------------------------------------------------
  // Alerts
  // -------------------------------------------------------------------------
  const alerts: Alert[] = [];

  /**
   * Disk first, deliberately.
   *
   * When the disk filled to 0.62 GB, PostgreSQL blocked writes while reads kept
   * succeeding — so DATABASE_DOWN never fired, and the true cause was the one
   * thing nothing reported. Placing DISK_LOW ahead of the database alert means
   * that when both fire, the operator reads the cause before the symptom.
   */
  if (disk.state === 'critical' || disk.state === 'warning') {
    alerts.push({
      severity: disk.state === 'critical' ? 'critical' : 'warning',
      code: 'DISK_LOW',
      message: disk.summary,
      action: disk.action ?? 'Free disk space.',
    });
  }

  if (!dbCheck.value) {
    alerts.push({
      severity: 'critical',
      code: 'DATABASE_DOWN',
      message: 'PostgreSQL is unreachable.',
      action:
        'Check the container and disk space. A full disk blocks writes while reads keep working, so health can look partly fine.',
    });
  }

  if (!redisCheck.value) {
    alerts.push({
      severity: 'critical',
      code: 'REDIS_DOWN',
      message: 'Redis is unreachable. No job can be queued or processed.',
      action: 'Check the container. Queued jobs survive a restart; in-flight ones are retried.',
    });
  }

  if (!workers.alive) {
    alerts.push({
      severity: 'critical',
      code: 'NO_WORKER',
      message: 'No worker is running. Discovery, campaigns, and reply detection are all stopped.',
      action: 'Start it with `npm run worker`. Queued jobs resume automatically.',
    });
  } else if (workers.staleSeconds !== null && workers.staleSeconds > THRESHOLDS.workerStaleSeconds) {
    alerts.push({
      severity: 'warning',
      code: 'WORKER_STALE',
      message: `The newest worker heartbeat is ${workers.staleSeconds}s old.`,
      action: 'The worker may be wedged on a long job. Check its logs; restart if it does not recover.',
    });
  }

  for (const queue of queues) {
    if (queue.waiting >= THRESHOLDS.queueBacklogCritical) {
      alerts.push({
        severity: 'critical',
        code: 'QUEUE_BACKLOG',
        message: `Queue "${queue.name}" has ${queue.waiting} jobs waiting.`,
        action: 'The worker cannot keep up. Check worker health before adding capacity.',
      });
    } else if (queue.waiting >= THRESHOLDS.queueBacklogWarn) {
      alerts.push({
        severity: 'warning',
        code: 'QUEUE_BACKLOG',
        message: `Queue "${queue.name}" has ${queue.waiting} jobs waiting.`,
        action: 'Normal after a large search. Investigate if it is not draining.',
      });
    }

    if (queue.deadLettered >= THRESHOLDS.deadLetterWarn) {
      alerts.push({
        severity: 'warning',
        code: 'DEAD_LETTER',
        message: `Queue "${queue.name}" has ${queue.deadLettered} dead-lettered job(s).`,
        action: 'These exhausted their retries and need inspection; they will not retry on their own.',
      });
    }

    if (queue.paused) {
      alerts.push({
        severity: 'warning',
        code: 'QUEUE_PAUSED',
        message: `Queue "${queue.name}" is paused.`,
        action: 'Deliberate, or left over from an incident. Resume it if it should be running.',
      });
    }
  }

  if (gmail.state === 'AUTH_REQUIRED') {
    alerts.push({
      severity: 'critical',
      code: 'GMAIL_AUTH_REQUIRED',
      message: gmail.summary,
      action: 'Reconnect at Dashboard → Email. Retrying will not help.',
    });
  } else if (gmail.state === 'BLOCKED') {
    alerts.push({
      severity: 'critical',
      code: 'GMAIL_BLOCKED',
      message: gmail.summary,
      action: 'Check the last error code. If rate limited, lower the campaign daily limit.',
    });
  } else if (gmail.state === 'DEGRADED') {
    alerts.push({
      severity: 'warning',
      code: 'GMAIL_DEGRADED',
      message: gmail.summary,
      action: 'Watch for it clearing. Sending continues meanwhile.',
    });
  }

  if (
    failureRate !== null &&
    totalSendAttempts >= THRESHOLDS.sendFailureMinSample &&
    failureRate >= THRESHOLDS.sendFailureRate
  ) {
    alerts.push({
      severity: 'critical',
      code: 'HIGH_SEND_FAILURE_RATE',
      message: `${Math.round(failureRate * 100)}% of the last ${totalSendAttempts} sends failed.`,
      action:
        'Pause outbound while you investigate — a run of bounces damages sending reputation for every future campaign.',
    });
  }

  if (gmail.canReadInbox && gmail.lastSyncAt) {
    const staleMinutes = Math.round((Date.now() - gmail.lastSyncAt.getTime()) / 60_000);
    if (staleMinutes > THRESHOLDS.inboxSyncStaleMinutes) {
      alerts.push({
        severity: 'warning',
        code: 'INBOX_SYNC_STALE',
        message: `The inbox has not synced for ${staleMinutes} minutes.`,
        action:
          'Replies are not being detected, so follow-ups may go to people who already answered. Check the worker.',
      });
    }
  }

  if (stuckCampaigns > 0) {
    alerts.push({
      severity: 'warning',
      code: 'STUCK_CAMPAIGN',
      message: `${stuckCampaigns} campaign(s) are RUNNING but have sent nothing for over ${THRESHOLDS.stuckCampaignHours}h.`,
      action:
        'Usually a dead worker, a revoked mailbox, or an exhausted daily limit. Check worker and Gmail health above.',
    });
  }

  const outbound = controls.find((control) => control.name === 'outbound');
  if (outbound?.paused) {
    alerts.push({
      severity: 'warning',
      code: 'OUTBOUND_PAUSED',
      message: `Outbound email is paused: ${outbound.reason ?? 'no reason given'}`,
      action: 'Deliberate if you or a colleague threw the switch. Resume at /api/ops/controls.',
    });
  }

  const critical = alerts.some((alert) => alert.severity === 'critical');

  return {
    status: critical ? 'critical' : alerts.length > 0 ? 'degraded' : 'ok',
    checkedAt: new Date().toISOString(),
    infrastructure: {
      database: dbCheck.value,
      databaseLatencyMs: dbCheck.ms,
      redis: redisCheck.value,
      redisLatencyMs: redisCheck.ms,
    },
    workers,
    disk,
    queues,
    gmail,
    controls,
    email: {
      sentLast24h: sent24h,
      failedLast24h: failed24h,
      failureRate: failureRate === null ? null : Number(failureRate.toFixed(4)),
      queued: queuedMessages,
      lastSyncAt: gmail.lastSyncAt?.toISOString() ?? null,
    },
    campaigns: { running: runningCampaigns, stuck: stuckCampaigns },
    alerts,
    mockMode: env().isMockMode,
  };
}

/**
 * Liveness: is this process able to serve at all?
 *
 * Deliberately shallow — no database, no Redis. Liveness answers "should this
 * container be restarted?", and restarting a healthy web process because
 * Postgres is briefly unavailable turns a database blip into an outage.
 */
export function liveness(): { status: 'ok'; uptimeSeconds: number } {
  return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) };
}

/**
 * Readiness: should this process receive traffic?
 *
 * Deep — the dependencies a request actually needs. A load balancer should stop
 * routing here when these fail, without the process being killed.
 */
export async function readiness(): Promise<{
  status: 'ok' | 'degraded';
  checks: { database: boolean; redis: boolean; disk: DiskState };
  disk: { freeGb: number | null; summary: string };
}> {
  const [database, redis, disk] = await Promise.all([
    databaseHealthy().catch(() => false),
    redisHealthy().catch(() => false),
    diskHealth(),
  ]);

  /**
   * Critical disk makes readiness DEGRADED even though `SELECT 1` still passes.
   *
   * This is the specific lesson of the 0.62 GB incident: PostgreSQL blocked
   * writes while reads kept succeeding, so a read-only probe reported 200 while
   * every login hung. A readiness check that stays green in that state directs
   * the operator away from the cause, which is worse than having no check.
   *
   * Only `critical` degrades. A `warning` is a signal to act, not a reason to
   * pull the instance out of the load balancer.
   */
  const diskCritical = disk.state === 'critical';
  const ready = database && redis && !diskCritical;

  if (!ready) {
    logger().warn(
      { database, redis, disk: disk.state, freeGb: disk.freeGb },
      'Readiness check failed',
    );
  }

  return {
    status: ready ? 'ok' : 'degraded',
    checks: { database, redis, disk: disk.state },
    disk: { freeGb: disk.freeGb, summary: disk.summary },
  };
}
