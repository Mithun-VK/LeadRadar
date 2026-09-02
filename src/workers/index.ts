/**
 * Worker entrypoint.
 *
 * A long-lived process, separate from the Next.js server, because BullMQ workers
 * hold blocking Redis reads and must survive across requests.
 *
 * Graceful shutdown is not decoration. SIGTERM arrives on every deploy; killing
 * the process instead of draining leaves jobs locked until their lock expires,
 * which for a 2-minute Firecrawl job means two minutes of a lead sitting in limbo
 * and then a duplicate fetch that costs another credit.
 */
import 'dotenv/config';

import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { closeRedis } from '@/lib/redis';
import { closeDatabase, databaseHealthy } from '@/modules/database/client';
import { redisHealthy } from '@/lib/redis';
import {
  QUEUE_NAMES,
  closeQueues,
  createWorker,
  getQueue,
  type WorkerHandle,
} from '@/modules/jobs/queues';
import {
  processDiscover,
  processEnrich,
  processMaintenance,
  processScore,
  processSearch,
} from '@/modules/jobs/processors';
import { processExport } from '@/modules/export/worker';
import { processCampaignTick, processSendEmail } from '@/modules/email/worker';

const log = logger().child({ component: 'worker-main' });

const handles: WorkerHandle[] = [];

/** Repeatable maintenance. Cheap, and both tasks are compliance-relevant. */
async function scheduleMaintenance(): Promise<void> {
  const queue = getQueue(QUEUE_NAMES.maintenance);

  // Retention purge: hourly, so an expired snapshot never lingers long.
  await queue.add(
    'purge-google-snapshots',
    { task: 'purge-google-snapshots', limit: 5_000 },
    { repeat: { pattern: '17 * * * *' }, jobId: 'repeat~purge-google-snapshots' },
  );

  // Place ID refresh: daily, off-peak. Free on the IDs-only SKU.
  await queue.add(
    'refresh-place-ids',
    { task: 'refresh-place-ids', limit: 500 },
    { repeat: { pattern: '0 3 * * *' }, jobId: 'repeat~refresh-place-ids' },
  );

  /**
   * Campaign scheduler: every 15 minutes.
   *
   * A campaign advances through delayed jobs, so a worker restart between two
   * messages would leave it RUNNING but never advancing. This re-wakes any such
   * campaign. It is idempotent — the deterministic send job id means a duplicated
   * tick cannot produce a duplicate email.
   */
  await queue.add(
    'campaign-scheduler',
    { task: 'campaign-scheduler', limit: 100 },
    { repeat: { pattern: '*/15 * * * *' }, jobId: 'repeat~campaign-scheduler' },
  );

  /**
   * Inbox sync: every 10 minutes.
   *
   * Frequent enough that a reply stops the next follow-up in practice — sequences
   * are spaced in days, so a ten-minute detection window closes the gap that
   * matters. Not more frequent, because each run costs Gmail API quota and a
   * reply an hour later is not meaningfully worse for the recipient.
   */
  await queue.add(
    'inbox-sync',
    { task: 'inbox-sync', limit: 100 },
    { repeat: { pattern: '*/10 * * * *' }, jobId: 'repeat~inbox-sync' },
  );

  /** Reply-body retention, daily. See docs/DATA_RETENTION.md. */
  await queue.add(
    'purge-email-bodies',
    { task: 'purge-email-bodies', limit: 5_000 },
    { repeat: { pattern: '23 4 * * *' }, jobId: 'repeat~purge-email-bodies' },
  );
}

function startWorkers(): void {
  handles.push(
    createWorker(QUEUE_NAMES.search, (job) => processSearch(job.data, job.id)),
    createWorker(QUEUE_NAMES.googlePlaces, (job) => processDiscover(job.data, job.id)),
    createWorker(QUEUE_NAMES.websiteDiscovery, (job) => processEnrich(job.data, job.id)),
    createWorker(QUEUE_NAMES.scoring, (job) => processScore(job.data, job.id)),
    createWorker(QUEUE_NAMES.export, (job) => processExport(job.data, job.id)),
    // One worker handles both email job kinds, dispatching on the job name, so
    // the queue's concurrency of 1 covers sending AND scheduling. Two workers on
    // the same queue would each get their own slot and defeat that.
    createWorker(QUEUE_NAMES.email, (job) =>
      job.name === 'send'
        ? processSendEmail(job.data, job.id)
        : processCampaignTick(job.data, job.id),
    ),
    createWorker(QUEUE_NAMES.maintenance, (job) => processMaintenance(job.data, job.id)),
  );
}

let shuttingDown = false;

/**
 * Drains and exits.
 *
 * `worker.close()` without force lets in-flight jobs finish. The timeout is a
 * backstop: if a job wedges, the process still exits rather than blocking a deploy
 * indefinitely.
 */
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  log.info({ signal }, 'Shutting down; draining in-flight jobs');

  const drain = Promise.allSettled([
    ...handles.map((handle) => handle.worker.close()),
    ...handles.map((handle) => handle.events.close()),
  ]);

  const timeout = new Promise<'timeout'>((resolve) => {
    setTimeout(() => resolve('timeout'), 30_000).unref();
  });

  const outcome = await Promise.race([drain.then(() => 'drained' as const), timeout]);
  if (outcome === 'timeout') {
    log.warn('Drain timed out after 30s; forcing shutdown');
  }

  await Promise.allSettled([closeQueues(), closeDatabase(), closeRedis()]);
  log.info('Shutdown complete');
  process.exit(outcome === 'timeout' ? 1 : 0);
}

async function main(): Promise<void> {
  const config = env();

  // Fail before accepting work rather than failing every job individually.
  const [dbOk, redisOk] = await Promise.all([databaseHealthy(), redisHealthy()]);
  if (!dbOk || !redisOk) {
    log.error({ database: dbOk, redis: redisOk }, 'Dependency check failed; refusing to start');
    process.exit(1);
  }

  startWorkers();
  await scheduleMaintenance();

  log.info(
    {
      queues: Object.values(QUEUE_NAMES),
      mockMode: config.isMockMode,
      maxConcurrentJobs: config.MAX_CONCURRENT_JOBS,
      model: config.GROQ_MODEL,
    },
    'LeadRadar workers started',
  );

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // An unhandled rejection means state is unknown. Drain and let the supervisor
  // restart cleanly rather than continuing in an undefined condition.
  process.on('unhandledRejection', (reason) => {
    log.error({ err: reason }, 'Unhandled rejection in worker process');
    void shutdown('unhandledRejection');
  });
  process.on('uncaughtException', (error) => {
    log.error({ err: error }, 'Uncaught exception in worker process');
    void shutdown('uncaughtException');
  });
}

void main().catch((error: unknown) => {
  log.error({ err: error }, 'Worker process failed to start');
  process.exit(1);
});
