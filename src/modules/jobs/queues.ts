/**
 * Queue definitions.
 *
 * Why any of this is asynchronous: a five-city, two-category search fans out to
 * hundreds of paginated provider requests against three third-party rate limits,
 * and takes minutes to tens of minutes. That cannot live in an HTTP request. The
 * queue also buys retry isolation (one dead website must not fail a search of
 * 4,000), resumability after a crash, fair provider pacing, and a single place to
 * enforce spend.
 *
 * Concurrency is bounded everywhere. An unbounded worker pool would defeat the
 * rate limiter by queueing thousands of simultaneous waiters, and would spend the
 * budget faster than the guard can observe it.
 */
import {
  Queue,
  QueueEvents,
  Worker,
  type JobsOptions,
  type Processor,
  type WorkerOptions,
} from 'bullmq';

import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { queueConnection } from '@/lib/redis';

export const QUEUE_NAMES = {
  search: 'search',
  googlePlaces: 'google-places',
  websiteDiscovery: 'website-discovery',
  websiteVerification: 'website-verification',
  firecrawl: 'firecrawl',
  groq: 'groq',
  scoring: 'scoring',
  export: 'export',
  email: 'email',
  maintenance: 'maintenance',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/** Dead-letter queue name for a source queue. */
export function deadLetterName(queue: QueueName): string {
  return `${queue}-dlq`;
}

/**
 * Per-queue policy.
 *
 * `attempts` differs by failure character rather than by importance: provider
 * calls fail transiently and deserve retries, while scoring is pure computation
 * whose failure means a bug, and retrying a bug three times just delays the
 * report.
 */
export interface QueuePolicy {
  readonly attempts: number;
  readonly backoffMs: number;
  readonly timeoutMs: number;
  readonly concurrency: number;
  /** Completed/failed jobs retained, so the UI can show recent history. */
  readonly keepCompleted: number;
  readonly keepFailed: number;
}

function scaledConcurrency(base: number): number {
  // MAX_CONCURRENT_JOBS is the operator's global dial; per-queue values scale
  // from it so one setting controls total load.
  const max = env().MAX_CONCURRENT_JOBS;
  return Math.max(1, Math.min(base, max));
}

export function policyFor(queue: QueueName): QueuePolicy {
  switch (queue) {
    case 'search':
      // One coordinator per search; the fan-out happens in child jobs.
      return {
        attempts: 2,
        backoffMs: 2_000,
        timeoutMs: 300_000,
        concurrency: scaledConcurrency(3),
        keepCompleted: 200,
        keepFailed: 500,
      };
    case 'google-places':
      return {
        attempts: 4,
        backoffMs: 1_500,
        timeoutMs: 60_000,
        concurrency: scaledConcurrency(4),
        keepCompleted: 100,
        keepFailed: 500,
      };
    case 'website-discovery':
    case 'website-verification':
    case 'firecrawl':
      // Web fetching is the slowest and most failure-prone stage; more retries,
      // longer timeouts, and concurrency capped by the Firecrawl plan.
      return {
        attempts: 3,
        backoffMs: 3_000,
        timeoutMs: 120_000,
        concurrency: scaledConcurrency(6),
        keepCompleted: 100,
        keepFailed: 1_000,
      };
    case 'groq':
      return {
        attempts: 3,
        backoffMs: 2_000,
        timeoutMs: 60_000,
        concurrency: scaledConcurrency(3),
        keepCompleted: 100,
        keepFailed: 500,
      };
    case 'scoring':
      // Pure computation: a failure is a bug, not bad luck.
      return {
        attempts: 2,
        backoffMs: 500,
        timeoutMs: 30_000,
        concurrency: scaledConcurrency(8),
        keepCompleted: 100,
        keepFailed: 500,
      };
    case 'export':
      return {
        attempts: 2,
        backoffMs: 2_000,
        timeoutMs: 300_000,
        concurrency: scaledConcurrency(2),
        keepCompleted: 100,
        keepFailed: 200,
      };
    case 'email':
      /**
       * Concurrency ONE, always — never scaled from MAX_CONCURRENT_JOBS.
       *
       * Every other queue here fetches data; this one sends mail from a real
       * person's mailbox. Parallel sending defeats the inter-message delay that
       * makes a campaign look like correspondence rather than a blast, and it is
       * the fastest way to trip Gmail's per-account rate limit — which does not
       * merely slow the campaign, it can suspend sending outright.
       *
       * Retries are few and slow for the same reason: a message whose delivery
       * status is unclear must not be re-sent eagerly at a real recipient. The
       * backoff is a full minute rather than seconds.
       */
      return {
        attempts: 3,
        backoffMs: 60_000,
        timeoutMs: 60_000,
        concurrency: 1,
        keepCompleted: 500,
        keepFailed: 1_000,
      };
    case 'maintenance':
      return {
        attempts: 2,
        backoffMs: 10_000,
        timeoutMs: 300_000,
        concurrency: 1,
        keepCompleted: 50,
        keepFailed: 100,
      };
  }
}

export function defaultJobOptions(queue: QueueName): JobsOptions {
  const policy = policyFor(queue);
  return {
    attempts: policy.attempts,
    // Jitter is applied by BullMQ's exponential strategy; without backoff a
    // rate-limited batch would retry in lockstep and reproduce the burst.
    backoff: { type: 'exponential', delay: policy.backoffMs },
    removeOnComplete: { count: policy.keepCompleted },
    removeOnFail: { count: policy.keepFailed },
  };
}

const queues = new Map<string, Queue>();

export function getQueue(name: QueueName): Queue {
  let queue = queues.get(name);
  if (!queue) {
    queue = new Queue(name, {
      connection: queueConnection(),
      defaultJobOptions: defaultJobOptions(name),
    });
    queues.set(name, queue);
  }
  return queue;
}

/** DLQ is a plain queue with no automatic retry: it exists to be inspected. */
export function getDeadLetterQueue(source: QueueName): Queue {
  const name = deadLetterName(source);
  let queue = queues.get(name);
  if (!queue) {
    queue = new Queue(name, {
      connection: queueConnection(),
      defaultJobOptions: { attempts: 1, removeOnComplete: false, removeOnFail: false },
    });
    queues.set(name, queue);
  }
  return queue;
}

export interface WorkerHandle {
  readonly worker: Worker;
  readonly events: QueueEvents;
}

/**
 * Creates a worker with the queue's policy applied, plus dead-letter routing.
 *
 * A job that exhausts its attempts is moved to the DLQ with its original payload
 * and failure trail. Without that, a permanently failing job is silently dropped
 * once BullMQ trims it, and the operator learns nothing.
 */
export function createWorker<T = unknown, R = unknown>(
  name: QueueName,
  processor: Processor<T, R>,
  overrides: Partial<WorkerOptions> = {},
): WorkerHandle {
  const policy = policyFor(name);
  const log = logger().child({ component: 'worker', queue: name });

  const worker = new Worker<T, R>(name, processor, {
    connection: queueConnection(),
    concurrency: policy.concurrency,
    // Stalled jobs are re-queued; a low limit prevents a crash-looping worker
    // from reprocessing the same job forever.
    maxStalledCount: 2,
    stalledInterval: 30_000,
    lockDuration: policy.timeoutMs + 30_000,
    ...overrides,
  });

  worker.on('failed', (job, error) => {
    const attemptsMade = job?.attemptsMade ?? 0;
    const exhausted = attemptsMade >= policy.attempts;

    log.warn(
      { jobId: job?.id, attemptsMade, exhausted, err: error },
      exhausted ? 'Job failed permanently; moving to dead-letter queue' : 'Job failed; will retry',
    );

    if (exhausted && job) {
      void getDeadLetterQueue(name)
        .add(
          'dead-letter',
          {
            originalQueue: name,
            originalJobId: job.id,
            originalName: job.name,
            payload: job.data,
            failedReason: error.message,
            attemptsMade,
            failedAt: new Date().toISOString(),
          },
          { jobId: `dlq~${name}~${job.id}` },
        )
        .catch((dlqError: unknown) => {
          // Log rather than throw: losing the DLQ write must not also crash the
          // worker and take out unrelated jobs.
          log.error({ err: dlqError, jobId: job.id }, 'Failed to write to dead-letter queue');
        });
    }
  });

  worker.on('error', (error) => {
    log.error({ err: error }, 'Worker error');
  });

  const events = new QueueEvents(name, { connection: queueConnection() });

  return { worker, events };
}

/**
 * Pauses a queue. Used when a budget is exhausted: in-flight jobs finish, nothing
 * new starts, and the operator can resume after raising the limit.
 */
export async function pauseQueue(name: QueueName): Promise<void> {
  await getQueue(name).pause();
  logger().warn({ queue: name }, 'Queue paused');
}

export async function resumeQueue(name: QueueName): Promise<void> {
  await getQueue(name).resume();
  logger().info({ queue: name }, 'Queue resumed');
}

export interface QueueDepth {
  readonly name: string;
  readonly waiting: number;
  readonly active: number;
  readonly delayed: number;
  readonly failed: number;
  readonly completed: number;
  readonly paused: boolean;
  readonly deadLettered: number;
}

/** Depth snapshot for the ops dashboard. */
export async function queueDepths(): Promise<QueueDepth[]> {
  const names = Object.values(QUEUE_NAMES);

  return Promise.all(
    names.map(async (name) => {
      const queue = getQueue(name);
      const counts = await queue.getJobCounts(
        'waiting',
        'active',
        'delayed',
        'failed',
        'completed',
      );
      const [paused, deadLettered] = await Promise.all([
        queue.isPaused(),
        getDeadLetterQueue(name).getJobCountByTypes('waiting', 'completed'),
      ]);

      return {
        name,
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        delayed: counts.delayed ?? 0,
        failed: counts.failed ?? 0,
        completed: counts.completed ?? 0,
        paused,
        deadLettered,
      };
    }),
  );
}

/** Closes every queue and connection, for graceful shutdown. */
export async function closeQueues(): Promise<void> {
  const all = [...queues.values()];
  queues.clear();
  await Promise.allSettled(all.map((queue) => queue.close()));
}
