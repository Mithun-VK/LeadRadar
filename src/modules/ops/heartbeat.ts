/**
 * Worker liveness.
 *
 * ---------------------------------------------------------------------------
 * WHY REDIS WITH A TTL, AND NOT A DATABASE TABLE
 * ---------------------------------------------------------------------------
 *
 * A heartbeat is a claim that expires. Writing it to Postgres means either a
 * `lastSeenAt` column that must be swept by yet another job, or a table that
 * grows forever — and in both cases the reader has to decide what "stale" means
 * by doing date arithmetic on every read.
 *
 * A Redis key with a TTL encodes staleness in the storage itself. The key exists
 * or it does not; if the worker stops writing it, it disappears on its own. No
 * sweeper, no schema, no cleanup job that can itself fail and leave a dead worker
 * looking alive.
 *
 * The failure mode also points the right way. If Redis is down, the heartbeat
 * reads as absent — the worker is reported as unhealthy. That is correct rather
 * than merely convenient: a worker that cannot reach Redis genuinely cannot
 * process jobs, because the queue lives there.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DELIBERATELY DOES NOT DO
 * ---------------------------------------------------------------------------
 *
 * It does not restart anything, page anyone, or pause campaigns. It answers one
 * question — "is a worker alive, and when did it last say so?" — and leaves the
 * decision to an operator or an uptime monitor. A heartbeat that takes action is
 * a heartbeat that takes the wrong action at 3am.
 */
import { hostname } from 'node:os';

import { logger } from '@/lib/logger';
import { cacheConnection } from '@/lib/redis';

/** How often a worker writes its heartbeat. */
export const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * How long a heartbeat survives without being refreshed.
 *
 * Three intervals, not one. A single missed write is ordinary — a long job, a GC
 * pause, a slow Redis round trip — and treating it as death would report a
 * healthy worker as dead several times an hour, which trains an operator to
 * ignore the signal. Three consecutive misses is not noise.
 */
export const HEARTBEAT_TTL_SECONDS = (HEARTBEAT_INTERVAL_MS / 1000) * 3;

const KEY_PREFIX = 'leadradar:worker:heartbeat:';

export interface WorkerBeat {
  readonly workerId: string;
  readonly host: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly beatAt: string;
  readonly queues: readonly string[];
  /** Jobs completed and failed since this process started. */
  readonly processed: number;
  readonly failed: number;
}

export interface WorkerStatus {
  readonly alive: boolean;
  readonly workers: readonly WorkerBeat[];
  /** Seconds since the most recent beat from any worker, or null if none. */
  readonly staleSeconds: number | null;
  readonly summary: string;
}

/** Stable within a process, unique across processes on the same host. */
const workerId = `${hostname()}:${process.pid}`;
const startedAt = new Date().toISOString();

let counters = { processed: 0, failed: 0 };
let timer: NodeJS.Timeout | null = null;

/** Called by the worker's job wrapper. Cheap and in-memory. */
export function countJob(outcome: 'processed' | 'failed'): void {
  counters[outcome] += 1;
}

async function writeBeat(queues: readonly string[]): Promise<void> {
  const beat: WorkerBeat = {
    workerId,
    host: hostname(),
    pid: process.pid,
    startedAt,
    beatAt: new Date().toISOString(),
    queues,
    processed: counters.processed,
    failed: counters.failed,
  };

  try {
    await cacheConnection().set(
      `${KEY_PREFIX}${workerId}`,
      JSON.stringify(beat),
      'EX',
      HEARTBEAT_TTL_SECONDS,
    );
  } catch (error) {
    // A failed heartbeat must never take down the worker it describes. The key
    // simply expires, and the worker is correctly reported as unhealthy.
    logger().warn({ err: error, workerId }, 'Could not write worker heartbeat');
  }
}

/**
 * Starts beating. Returns a stop function for graceful shutdown.
 *
 * `unref()` so the timer never holds the process open — a worker draining on
 * SIGTERM should exit when its jobs finish, not linger for the next beat.
 */
export function startHeartbeat(queues: readonly string[]): () => Promise<void> {
  void writeBeat(queues);

  timer = setInterval(() => void writeBeat(queues), HEARTBEAT_INTERVAL_MS);
  timer.unref();

  return async () => {
    if (timer) clearTimeout(timer);
    timer = null;
    // Removed on clean shutdown so a deliberately stopped worker reads as absent
    // immediately, rather than looking alive for another 45 seconds.
    await cacheConnection()
      .del(`${KEY_PREFIX}${workerId}`)
      .catch(() => undefined);
  };
}

/** Every worker currently beating. */
export async function workerStatus(): Promise<WorkerStatus> {
  let beats: WorkerBeat[] = [];

  try {
    const redis = cacheConnection();
    const keys = await redis.keys(`${KEY_PREFIX}*`);

    if (keys.length > 0) {
      const values = await redis.mget(...keys);
      beats = values
        .filter((value): value is string => value !== null)
        .map((value) => {
          try {
            return JSON.parse(value) as WorkerBeat;
          } catch {
            return null;
          }
        })
        .filter((beat): beat is WorkerBeat => beat !== null);
    }
  } catch (error) {
    logger().warn({ err: error }, 'Could not read worker heartbeats');
    return {
      alive: false,
      workers: [],
      staleSeconds: null,
      summary: 'Redis is unreachable, so worker health cannot be determined.',
    };
  }

  if (beats.length === 0) {
    return {
      alive: false,
      workers: [],
      staleSeconds: null,
      summary:
        'No worker is running. Discovery, campaigns, and reply detection are all stopped.',
    };
  }

  const newest = Math.max(...beats.map((b) => new Date(b.beatAt).getTime()));
  const staleSeconds = Math.round((Date.now() - newest) / 1000);

  return {
    alive: true,
    workers: beats,
    staleSeconds,
    summary: `${beats.length} worker(s) running, last beat ${staleSeconds}s ago.`,
  };
}

/** Test-only: clears the in-process counters. */
export function resetCounters(): void {
  counters = { processed: 0, failed: 0 };
}
