/**
 * Container failure drills — the real thing.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS SEPARATELY FROM verify-recovery.ts
 * ---------------------------------------------------------------------------
 *
 * `verify-recovery.ts` simulates outages by pointing a client at an unreachable
 * port. That is an honest test of the application's failure handling and it says
 * so — but it is not a test of what an operator will actually meet, because a
 * closed port and a stopped container are not the same failure.
 *
 * A closed port refuses instantly. A stopped container leaves connection pools
 * holding sockets that were open a moment ago, in-flight queries with no reply
 * coming, and a Redis client whose reconnect strategy has never been exercised.
 * The interesting question — does it come BACK without a restart? — cannot be
 * asked at all of a simulation, because a simulated outage never ends.
 *
 * So this stops the actual containers.
 *
 * ---------------------------------------------------------------------------
 * SAFETY — READ BEFORE RUNNING
 * ---------------------------------------------------------------------------
 *
 * `docker stop` and `docker start` ONLY. Never `rm`, never `down`, never
 * `volume rm`, never `system prune`. Stopping a container leaves its volume
 * untouched; the data survives, which is the entire point of the drill.
 *
 * The script refuses to run unless the containers are the local development ones
 * by name, and it restarts anything it stopped in a `finally` block even if an
 * assertion throws.
 *
 *   npm run drill:containers
 *
 * A worker should be running so the worker-recovery assertions are meaningful.
 */
import 'dotenv/config';

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { db, closeDatabase, databaseHealthy } from '@/modules/database/client';
import { closeRedis, redisHealthy, cacheConnection } from '@/lib/redis';
import { closeQueues, getQueue, QUEUE_NAMES } from '@/modules/jobs/queues';
import { readiness, liveness } from '@/modules/ops/status';
import { workerStatus } from '@/modules/ops/heartbeat';
import { providers } from '@/modules/providers/registry';
import { SIGNALS_VERSION } from '@/modules/scoring/config';

const run = promisify(execFile);

/** Only these. Named explicitly so the script cannot be pointed at production. */
const POSTGRES = 'leadradar-postgres';
const REDIS = 'leadradar-redis';

const results: Array<{ label: string; pass: boolean; detail?: string }> = [];

function assert(label: string, pass: boolean, detail?: string): void {
  results.push({ label, pass, ...(detail !== undefined && { detail }) });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

async function docker(...args: string[]): Promise<string> {
  const { stdout } = await run('docker', args, { timeout: 120_000 });
  return stdout.trim();
}

async function containerRunning(name: string): Promise<boolean> {
  try {
    return (await docker('inspect', '-f', '{{.State.Running}}', name)) === 'true';
  } catch {
    return false;
  }
}

/** Waits for a predicate, returning how long it took, or null on timeout. */
async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 1_000,
): Promise<number | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate().catch(() => false)) return Date.now() - started;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

/** How long a call takes, and whether it threw. Never propagates. */
async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; threw: boolean; value?: T }> {
  const t0 = Date.now();
  try {
    const value = await fn();
    return { ms: Date.now() - t0, threw: false, value };
  } catch {
    return { ms: Date.now() - t0, threw: true };
  }
}

const stopped = new Set<string>();

async function stop(name: string): Promise<void> {
  console.log(`  stopping ${name}…`);
  await docker('stop', name);
  stopped.add(name);
}

async function start(name: string): Promise<void> {
  console.log(`  starting ${name}…`);
  await docker('start', name);
  stopped.delete(name);
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const registry = providers();
  if (!registry.email?.isMock) {
    throw new Error('Refusing to run: the email provider is not a mock.');
  }

  for (const name of [POSTGRES, REDIS]) {
    if (!(await containerRunning(name))) {
      throw new Error(`${name} is not running. Start the stack with \`docker compose up -d\`.`);
    }
  }

  // -------------------------------------------------------------------------
  section('0. Baseline — everything healthy');

  assert('PostgreSQL is reachable', await databaseHealthy());
  assert('Redis is reachable', await redisHealthy());

  const baseline = await readiness();
  assert('readiness reports ok', baseline.status === 'ok', JSON.stringify(baseline.checks));

  const workersBefore = await workerStatus();
  const workerPresent = workersBefore.alive;
  console.log(
    workerPresent
      ? `  ${workersBefore.workers.length} worker(s): ${workersBefore.workers.map((w) => w.workerId).join(', ')}`
      : '  NOTE  no worker is running; worker-recovery assertions will be skipped.',
  );

  // Queue some work up front, so there is something to lose.
  const org = await db().organization.findFirstOrThrow({ select: { id: true } });
  const leads = await db().business.findMany({
    where: { organizationId: org.id },
    select: { id: true },
    take: 10,
  });

  // =========================================================================
  section('1. PostgreSQL container STOPPED');

  await stop(POSTGRES);
  const pgDownAt = Date.now();

  const query = await timed(() => db().$queryRaw`SELECT 1`);
  assert(
    'a query against a stopped database fails rather than hanging',
    query.threw,
    `threw=${query.threw} after ${query.ms}ms`,
  );
  assert(
    'and it fails within a bounded time',
    query.ms < 30_000,
    `${query.ms}ms`,
  );

  const live = liveness();
  assert(
    'LIVENESS still reports ok — the process is fine, its dependency is not',
    live.status === 'ok',
    'restarting a healthy web process because Postgres blinked turns a blip into an outage',
  );

  const readyDown = await readiness();
  assert(
    'READINESS reports degraded',
    readyDown.status === 'degraded',
    JSON.stringify(readyDown.checks),
  );
  assert(
    'readiness names the database as the failing check',
    readyDown.checks.database === false,
    JSON.stringify(readyDown.checks),
  );

  // Redis is independent: the queue must still accept work while the database is
  // down, or an outage in one datastore silently discards jobs bound for the other.
  const enqueueDuringOutage = await timed(() =>
    getQueue(QUEUE_NAMES.scoring).add(
      'score',
      {
        organizationId: org.id,
        businessId: leads[0]?.id ?? 'none',
        signalsVersion: SIGNALS_VERSION,
        withNarrative: false,
      },
      { jobId: `drill~pgdown~${Date.now()}`, delay: 600_000 },
    ),
  );
  assert(
    'Redis still accepts work while PostgreSQL is down',
    !enqueueDuringOutage.threw,
    `${enqueueDuringOutage.ms}ms`,
  );

  console.log(`  outage held for ${Math.round((Date.now() - pgDownAt) / 1000)}s`);

  // -------------------------------------------------------------------------
  section('2. PostgreSQL container RESTARTED');

  await start(POSTGRES);

  // The question a simulated outage cannot ask: does the pool recover on its own?
  const pgBack = await waitFor(() => databaseHealthy(), 120_000);
  assert(
    'the connection pool recovers WITHOUT restarting the application',
    pgBack !== null,
    pgBack === null ? 'still failing after 120s' : `recovered in ${Math.round(pgBack / 1000)}s`,
  );

  const readyBack = await waitFor(async () => (await readiness()).status === 'ok', 60_000);
  assert('readiness returns to ok', readyBack !== null, `${readyBack ?? '>60000'}ms`);

  const rowsAfter = await db().business.count({ where: { organizationId: org.id } });
  assert(
    'data survived the stop — the volume was never touched',
    rowsAfter >= leads.length,
    `${rowsAfter} businesses`,
  );

  if (workerPresent) {
    const recovered = await waitFor(async () => (await workerStatus()).alive, 90_000);
    assert(
      'workers are alive again after the database returns',
      recovered !== null,
      recovered === null ? 'no heartbeat after 90s' : `${Math.round(recovered / 1000)}s`,
    );
  }

  // =========================================================================
  section('3. Redis container STOPPED');

  const queuedBefore = await getQueue(QUEUE_NAMES.scoring).getWaitingCount();
  const delayedBefore = await getQueue(QUEUE_NAMES.scoring).getDelayedCount();
  console.log(`  queue before the outage: ${queuedBefore} waiting, ${delayedBefore} delayed`);

  await stop(REDIS);

  const redisCheck = await timed(() => redisHealthy());
  assert(
    'a Redis health check fails rather than hanging',
    redisCheck.value === false || redisCheck.threw,
    `threw=${redisCheck.threw} value=${String(redisCheck.value)} after ${redisCheck.ms}ms`,
  );
  /**
   * Tight, because this is the assertion that found the bug.
   *
   * Measured at **67 seconds** before `redisHealthy()` was given its own
   * timeout: the client's retry policy is deliberately patient for ordinary
   * commands and that patience is wrong for a probe. 5s allows the 3s health
   * timeout plus scheduling slack.
   */
  assert('and it fails within a bounded time', redisCheck.ms < 5_000, `${redisCheck.ms}ms`);

  assert(
    'LIVENESS still reports ok while Redis is down',
    liveness().status === 'ok',
  );

  const readyNoRedis = await readiness();
  assert(
    'READINESS reports degraded and names Redis',
    readyNoRedis.status === 'degraded' && readyNoRedis.checks.redis === false,
    JSON.stringify(readyNoRedis.checks),
  );

  // PostgreSQL is independent and must keep serving reads.
  const readDuringRedisOutage = await timed(() =>
    db().business.count({ where: { organizationId: org.id } }),
  );
  assert(
    'PostgreSQL keeps serving while Redis is down',
    !readDuringRedisOutage.threw,
    `${readDuringRedisOutage.ms}ms`,
  );

  // -------------------------------------------------------------------------
  section('4. Redis container RESTARTED');

  await start(REDIS);

  const redisBack = await waitFor(() => redisHealthy(), 120_000);
  assert(
    'the Redis client reconnects WITHOUT restarting the application',
    redisBack !== null,
    redisBack === null ? 'still failing after 120s' : `reconnected in ${Math.round(redisBack / 1000)}s`,
  );

  const readyFinal = await waitFor(async () => (await readiness()).status === 'ok', 60_000);
  assert('readiness returns to ok', readyFinal !== null, `${readyFinal ?? '>60000'}ms`);

  /**
   * The assertion that matters most about Redis.
   *
   * Redis runs with `--appendonly yes`, so queued jobs are on disk. If they were
   * not, a Redis restart would silently drop every scheduled follow-up — and
   * "silently" is the word that matters: nothing in the application would report
   * a campaign whose next step simply never arrives.
   */
  /**
   * The QUEUE connection recovers separately from the cache one.
   *
   * It runs with `enableOfflineQueue: false` — deliberately, so BullMQ fails
   * fast rather than silently buffering jobs against a dead connection — and it
   * therefore rejects with "Stream isn't writeable" for a moment after the cache
   * connection has already reported healthy. Reading it immediately aborted an
   * earlier run of this drill.
   *
   * That gap is worth asserting rather than sleeping through: an operator
   * watching `/api/health` sees green while the queue is still refusing work.
   */
  const queueBack = await waitFor(
    () => getQueue(QUEUE_NAMES.scoring).getWaitingCount().then(() => true),
    60_000,
  );
  assert(
    'the queue connection also recovers, after the cache connection does',
    queueBack !== null,
    queueBack === null ? 'still refusing commands after 60s' : `${queueBack}ms behind the cache`,
  );

  const queuedAfter = await getQueue(QUEUE_NAMES.scoring).getWaitingCount();
  const delayedAfter = await getQueue(QUEUE_NAMES.scoring).getDelayedCount();
  assert(
    'queued work survived the Redis restart (AOF persistence)',
    queuedAfter + delayedAfter >= queuedBefore + delayedBefore,
    `${queuedBefore}+${delayedBefore} before → ${queuedAfter}+${delayedAfter} after`,
  );

  if (workerPresent) {
    const workersBack = await waitFor(async () => (await workerStatus()).alive, 120_000);
    assert(
      'workers re-register their heartbeat after Redis returns',
      workersBack !== null,
      workersBack === null ? 'no heartbeat after 120s' : `${Math.round(workersBack / 1000)}s`,
    );

    // Heartbeats live in Redis with a TTL, so they are genuinely gone after the
    // restart. A worker that does not rewrite one is invisible to the operator
    // even though it is running — the worst of both states.
    const keys = await cacheConnection().keys('leadradar:worker:heartbeat:*');
    assert(
      'heartbeat keys were rewritten, not left absent',
      keys.length > 0,
      `${keys.length} keys`,
    );
  }

  // -------------------------------------------------------------------------
  section('5. Idempotency after recovery');

  /**
   * The failure this guards against: a job enqueued before an outage, retried
   * after it, and processed twice — one prospect, two identical emails.
   *
   * Re-adding an id that already exists must still be refused after both
   * datastores have restarted.
   */
  const idemQueue = getQueue(QUEUE_NAMES.scoring);
  const idemId = `drill~idem~${Date.now()}`;
  const payload = {
    organizationId: org.id,
    businessId: leads[0]?.id ?? 'none',
    signalsVersion: SIGNALS_VERSION,
    withNarrative: false,
  };

  const first = await idemQueue.add('score', payload, { jobId: idemId, delay: 600_000 });
  const second = await idemQueue.add('score', payload, { jobId: idemId, delay: 600_000 });

  assert(
    'a duplicate job id is still collapsed after both datastores restarted',
    first.id === second.id,
    `${first.id} vs ${second.id}`,
  );
  if (first.id) await idemQueue.remove(first.id);

  // Clean up the delayed jobs this drill created.
  const delayed = await idemQueue.getDelayed();
  for (const job of delayed) {
    if (job.id?.startsWith('drill~')) await job.remove().catch(() => undefined);
  }
}

main()
  .catch((error: unknown) => {
    console.error(`\nDrill aborted: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Always. A drill that leaves the developer's database stopped because an
    // assertion threw is worse than no drill.
    for (const name of [...stopped]) {
      console.log(`\nRestoring ${name} after an interrupted drill…`);
      await docker('start', name).catch((error: unknown) => {
        console.error(`  COULD NOT RESTART ${name}: ${String(error)}`);
        console.error(`  Run: docker start ${name}`);
      });
    }

    const failed = results.filter((r) => !r.pass);
    console.log(`\n${'='.repeat(70)}`);
    console.log(`${results.length - failed.length}/${results.length} drill assertions passed`);
    if (failed.length > 0) {
      console.log('\nFailures:');
      for (const f of failed) console.log(`  - ${f.label}${f.detail ? ` — ${f.detail}` : ''}`);
      process.exitCode = 1;
    }
    console.log(
      '\nContainers were STOPPED and STARTED. No volume was removed and no data\n' +
        'was deleted at any point in this drill.',
    );

    await Promise.allSettled([closeQueues(), closeRedis(), closeDatabase()]);
  });
