/**
 * Redis connections.
 *
 * Three distinct connections, because BullMQ and ordinary command traffic have
 * incompatible requirements:
 *
 *   - `queueConnection()` — for BullMQ Queue/Worker. BullMQ requires
 *     `maxRetriesPerRequest: null`; a blocking read that gives up mid-wait loses
 *     the job it was holding.
 *   - `cacheConnection()` — ordinary GET/SET/EVAL traffic, with bounded retries
 *     so a Redis outage surfaces as an error instead of hanging a request.
 *   - `subscriberConnection()` — a connection in subscriber mode cannot issue
 *     normal commands, so it must not be shared.
 *
 * A cost note that shapes deployment: BullMQ workers hold blocking reads, which
 * generate very high command volume. On a per-command-billed serverless Redis
 * that can cost more than the entire provider API bill. Co-locate Redis with the
 * worker — see the deployment section of the implementation plan.
 */
import { Redis, type RedisOptions } from 'ioredis';

import { env } from './env';
import { logger } from './logger';

type ConnectionKind = 'queue' | 'cache' | 'subscriber';

const pool = new Map<ConnectionKind, Redis>();

function baseOptions(kind: ConnectionKind): RedisOptions {
  return {
    // Named so `CLIENT LIST` is diagnosable in production.
    connectionName: `leadradar-${kind}`,
    lazyConnect: false,
    enableReadyCheck: true,
    // Fail fast rather than queueing commands forever behind a dead connection.
    enableOfflineQueue: kind !== 'queue',
    connectTimeout: 10_000,
    retryStrategy(attempt) {
      // Exponential with a ceiling, plus jitter so a fleet of workers does not
      // reconnect in lockstep and thunder the server back down.
      const delay = Math.min(attempt * 200, 5_000);
      return delay + Math.floor(Math.random() * 200);
    },
  };
}

function create(kind: ConnectionKind): Redis {
  const options: RedisOptions = {
    ...baseOptions(kind),
    ...(kind === 'queue'
      ? {
          // Mandatory for BullMQ: blocking commands must not be abandoned.
          maxRetriesPerRequest: null,
        }
      : { maxRetriesPerRequest: 3 }),
  };

  const client = new Redis(env().REDIS_URL, options);
  const log = logger().child({ component: 'redis', connection: kind });

  client.on('error', (error: Error) => {
    // Logged, never swallowed. ioredis emits these frequently during a reconnect
    // storm, so this is debug-level to avoid drowning real signal.
    log.debug({ err: error }, 'Redis connection error');
  });
  client.on('ready', () => log.info('Redis connection ready'));
  client.on('end', () => log.warn('Redis connection closed'));

  return client;
}

function get(kind: ConnectionKind): Redis {
  let client = pool.get(kind);
  if (!client) {
    client = create(kind);
    pool.set(kind, client);
  }
  return client;
}

/** Connection for BullMQ Queue and Worker instances. */
export function queueConnection(): Redis {
  return get('queue');
}

/** Connection for caching, rate limiting, and budget token buckets. */
export function cacheConnection(): Redis {
  return get('cache');
}

/** Dedicated subscriber; cannot be used for ordinary commands. */
export function subscriberConnection(): Redis {
  return get('subscriber');
}

/**
 * Closes every connection gracefully. Called from the worker's shutdown handler
 * so in-flight jobs finish and BullMQ can release its locks — killing the
 * process instead leaves jobs stalled until their lock expires.
 */
export async function closeRedis(): Promise<void> {
  const clients = [...pool.entries()];
  pool.clear();

  await Promise.allSettled(
    clients.map(async ([kind, client]) => {
      try {
        await client.quit();
      } catch {
        // A connection that is already gone does not need a graceful close.
        client.disconnect();
      }
      logger().debug({ connection: kind }, 'Redis connection closed');
    }),
  );
}

/** Liveness probe used by the health endpoint. */
/**
 * How long a health check may take before it answers "no".
 *
 * 3 seconds. A healthy PING is sub-millisecond locally and a few milliseconds
 * across a region, so this is generous for any real deployment and far inside
 * any sane probe timeout.
 *
 * The bound exists because the underlying client is deliberately patient:
 * `maxRetriesPerRequest: 3` with a reconnect backoff that climbs to 5s, on top
 * of a 10s connect timeout. Those are right for ordinary commands, which should
 * ride out a blip rather than fail. They are wrong for a health check.
 *
 * Measured with the Redis container actually stopped: `redisHealthy()` took
 * **67 seconds** to return false. A readiness probe that occupies a request for
 * over a minute before admitting a dependency is down is not a health check —
 * the load balancer sees a timeout instead of a 503, and the operator sees a
 * hung endpoint instead of a diagnosis.
 */
const HEALTH_TIMEOUT_MS = 3_000;

export async function redisHealthy(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), HEALTH_TIMEOUT_MS);
  });

  // The ping's own rejection is swallowed here rather than left to race: once
  // the timeout has won, an unhandled rejection would surface later as a crash
  // in an unrelated tick.
  const ping = cacheConnection()
    .ping()
    .then((reply) => reply === 'PONG')
    .catch(() => false);

  try {
    return await Promise.race([ping, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
