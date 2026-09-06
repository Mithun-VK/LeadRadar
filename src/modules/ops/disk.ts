/**
 * Disk headroom.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 *
 * This is the failure that produced the worst incident of the hardening work,
 * and it is worth stating precisely because the shape of it is so misleading.
 *
 * The disk reached 0.62 GB free. PostgreSQL could no longer extend its WAL, so
 * it began blocking WRITES — while READS continued to work perfectly. The
 * consequence:
 *
 *   - `/api/health` returned 200, because its check is `SELECT 1`, a read.
 *   - Every login hung indefinitely (observed: 317 seconds), because a login
 *     WRITES a session row.
 *
 * So every monitor said healthy while the application was unusable. A health
 * check that cannot detect the condition that breaks the system is worse than no
 * health check, because it actively directs the operator away from the cause.
 *
 * The fix is not a cleverer database probe — a write probe would work but would
 * mean writing to the database on every health check, forever, to detect a
 * condition that has a much cheaper signal. The cheaper signal is the disk
 * itself.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MEASURES, AND WHAT IT CANNOT
 * ---------------------------------------------------------------------------
 *
 * It measures free space on the filesystem this PROCESS runs on. In a deployment
 * where Postgres lives on a different host or volume, that is not the same
 * filesystem, and this check can read healthy while the database's disk is full.
 *
 * That limitation is stated in the returned payload rather than hidden, because
 * a monitoring signal whose scope is misunderstood is how the original incident
 * happened in the first place.
 */
import { statfs } from 'node:fs/promises';

import { logger } from '@/lib/logger';

/**
 * Below this, the operator should act soon.
 *
 * 10 GB is the documented operational floor. It is not where Postgres fails —
 * that is closer to zero — it is where there is still comfortable time to react
 * before it does. A warning that fires at the point of failure is an alarm, not
 * a warning.
 */
export const DISK_WARN_BYTES = 10 * 1024 ** 3;

/**
 * Below this, the system is at genuine risk of the silent-write-failure mode.
 *
 * 2 GB, chosen with the incident in mind: the observed failure was at 0.62 GB,
 * and a build, a log rotation, or a large export can consume a gigabyte without
 * anyone noticing. By 2 GB there is no longer room to be surprised.
 */
export const DISK_CRITICAL_BYTES = 2 * 1024 ** 3;

export type DiskState = 'ok' | 'warning' | 'critical' | 'unknown';

export interface DiskHealth {
  readonly state: DiskState;
  readonly freeBytes: number | null;
  readonly totalBytes: number | null;
  readonly freeGb: number | null;
  readonly percentUsed: number | null;
  readonly summary: string;
  /** What the operator should do. Empty when there is nothing to do. */
  readonly action: string | null;
  /**
   * The filesystem measured. Stated because in a split deployment this is NOT
   * necessarily the filesystem PostgreSQL writes to.
   */
  readonly scope: string;
}

const SCOPE_NOTE =
  'Measured on the filesystem of the application process. If PostgreSQL runs on a ' +
  'separate host or volume, this does not observe its disk.';

/**
 * Current disk headroom.
 *
 * Never throws. `statfs` is unavailable on some platforms and containers, and a
 * health check that crashes when it cannot measure something is a health check
 * that takes the system down with it. An unmeasurable disk reports `unknown`,
 * which is honest — and deliberately NOT `ok`, because "we could not look" must
 * never be reported as "it is fine". That conflation is the whole lesson of the
 * incident this module exists for.
 */
export async function diskHealth(path = process.cwd()): Promise<DiskHealth> {
  let freeBytes: number | null = null;
  let totalBytes: number | null = null;

  try {
    const stats = await statfs(path);
    // `bavail` (available to unprivileged users), not `bfree` — the reserved
    // blocks in `bfree` are not usable and counting them overstates headroom.
    freeBytes = stats.bavail * stats.bsize;
    totalBytes = stats.blocks * stats.bsize;
  } catch (error) {
    logger().warn({ err: error, path }, 'Could not read disk statistics');

    return {
      state: 'unknown',
      freeBytes: null,
      totalBytes: null,
      freeGb: null,
      percentUsed: null,
      summary: 'Disk space could not be measured on this platform.',
      action:
        'Check free space manually. Below 10 GB, PostgreSQL can begin blocking writes ' +
        'while reads keep succeeding — health endpoints will look fine while the app hangs.',
      scope: SCOPE_NOTE,
    };
  }

  const freeGb = Number((freeBytes / 1024 ** 3).toFixed(2));
  const percentUsed =
    totalBytes > 0 ? Number((((totalBytes - freeBytes) / totalBytes) * 100).toFixed(1)) : null;

  if (freeBytes < DISK_CRITICAL_BYTES) {
    return {
      state: 'critical',
      freeBytes,
      totalBytes,
      freeGb,
      percentUsed,
      summary: `Only ${freeGb} GB free. PostgreSQL may begin blocking writes.`,
      action:
        'Free space NOW. The failure mode is silent: reads keep working and health checks ' +
        'pass while every write hangs. Do not run `docker system prune --volumes` — that ' +
        'destroys the database volume.',
      scope: SCOPE_NOTE,
    };
  }

  if (freeBytes < DISK_WARN_BYTES) {
    return {
      state: 'warning',
      freeBytes,
      totalBytes,
      freeGb,
      percentUsed,
      summary: `${freeGb} GB free, below the ${DISK_WARN_BYTES / 1024 ** 3} GB operational floor.`,
      action:
        'Free space before it becomes critical. A build, a log rotation, or a large export ' +
        'can consume a gigabyte without anyone noticing.',
      scope: SCOPE_NOTE,
    };
  }

  return {
    state: 'ok',
    freeBytes,
    totalBytes,
    freeGb,
    percentUsed,
    summary: `${freeGb} GB free.`,
    action: null,
    scope: SCOPE_NOTE,
  };
}
