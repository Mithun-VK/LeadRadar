/**
 * Worker container verification.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 *
 * The worker image had never been built, let alone run, when the final
 * certification was written — so "deployment is proven" was not a claim anyone
 * could make. Building the image proves it compiles. This proves it *works*.
 *
 * The distinction that motivates the whole script: a job enqueued here can be
 * picked up by ANY worker attached to the same Redis, including a developer's
 * `npm run worker` on the host. A test that merely asserts "the job completed"
 * therefore proves nothing about the container — the host worker may have done
 * all of it.
 *
 * So every assertion here is made against the container's OWN heartbeat record,
 * identified by its hostname. `processed` on that record is the only evidence
 * that the containerised worker did the work, and it is exactly the evidence
 * the earlier BullMQ colon-id bug would have needed to be caught: that bug
 * survived four phases because every test called the send path directly and
 * never once went through the queue.
 *
 * ---------------------------------------------------------------------------
 * USAGE
 * ---------------------------------------------------------------------------
 *
 *   docker build --target worker -t leadradar-worker:verify .
 *   docker run -d --name leadradar-worker-verify --init \
 *     --network leadradar_default --env-file .env \
 *     -e NODE_ENV=development \
 *     -e DATABASE_URL='postgresql://leadradar:leadradar@postgres:5432/leadradar?schema=public' \
 *     -e REDIS_URL='redis://redis:6379' \
 *     leadradar-worker:verify
 *
 *   WORKER_CONTAINER_HOST=$(docker inspect -f '{{.Config.Hostname}}' leadradar-worker-verify) \
 *     npm run verify:worker-image
 *
 * `WORKER_CONTAINER_HOST` is the container's hostname — Docker sets it to the
 * short container id unless overridden.
 */
import 'dotenv/config';

import { db, closeDatabase } from '@/modules/database/client';
import { closeRedis } from '@/lib/redis';
import { closeQueues, getQueue, QUEUE_NAMES } from '@/modules/jobs/queues';
import { workerStatus, type WorkerBeat } from '@/modules/ops/heartbeat';
import { SIGNALS_VERSION } from '@/modules/scoring/config';
import { providers } from '@/modules/providers/registry';

const CONTAINER_HOST = process.env.WORKER_CONTAINER_HOST;
const JOB_COUNT = Number(process.env.WORKER_IMAGE_JOBS ?? 20);
const WAIT_MS = 60_000;

const results: Array<{ label: string; pass: boolean; detail?: string }> = [];

function assert(label: string, pass: boolean, detail?: string): void {
  results.push({ label, pass, ...(detail !== undefined && { detail }) });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

/** The container's heartbeat record, or null if it is not beating. */
async function containerBeat(): Promise<WorkerBeat | null> {
  const status = await workerStatus();
  return status.workers.find((w) => w.host === CONTAINER_HOST) ?? null;
}

async function main(): Promise<void> {
  if (!CONTAINER_HOST) {
    throw new Error(
      'Set WORKER_CONTAINER_HOST to the container hostname:\n' +
        "  WORKER_CONTAINER_HOST=$(docker inspect -f '{{.Config.Hostname}}' leadradar-worker-verify)",
    );
  }

  const registry = providers();
  if (!registry.email?.isMock) {
    throw new Error('Refusing to run: the email provider is not a mock.');
  }

  // -------------------------------------------------------------------------
  section('1. The container is beating');

  const before = await containerBeat();
  assert(
    `container ${CONTAINER_HOST} has a live heartbeat`,
    before !== null,
    before ? `startedAt ${before.startedAt}` : 'no heartbeat found — is the container running?',
  );
  if (!before) throw new Error('Cannot verify a worker that is not beating.');

  assert(
    'the container registered every queue',
    before.queues.length === Object.keys(QUEUE_NAMES).length,
    `${before.queues.length} queues`,
  );

  const all = await workerStatus();
  const others = all.workers.filter((w) => w.host !== CONTAINER_HOST);
  if (others.length > 0) {
    console.log(
      `  NOTE  ${others.length} other worker(s) share this Redis (${others
        .map((w) => w.workerId)
        .join(', ')}). Jobs are attributed by heartbeat counter, not by completion.`,
    );
  }

  // -------------------------------------------------------------------------
  section('2. Enqueue → the container processes real jobs');

  // Scoring is the safe representative job: pure computation over stored
  // signals, no provider call, no email, and idempotent by construction.
  // No `startsWith: '__'` here: Prisma compiles it to `LIKE '__%'`, where `_`
  // is a single-character wildcard, so that filter excludes every organization
  // rather than the throwaway ones. Excluded by exact name instead.
  const businesses = await db().business.findMany({
    where: { organization: { NOT: { slug: { in: ['__loadtest__', '__pentest__a', '__pentest__b'] } } } },
    select: { id: true, organizationId: true },
    take: JOB_COUNT,
  });

  if (businesses.length === 0) {
    throw new Error('No businesses to score. Run `npm run db:seed` first.');
  }

  const queue = getQueue(QUEUE_NAMES.scoring);
  const runId = Date.now().toString(36);

  for (const [index, business] of businesses.entries()) {
    await queue.add(
      'score',
      {
        organizationId: business.organizationId,
        businessId: business.id,
        signalsVersion: SIGNALS_VERSION,
        withNarrative: false,
      },
      // `~` not `:` — BullMQ rejects a custom id containing a colon, and that
      // rejection is what silently broke campaign sending for 89 scheduler cycles.
      { jobId: `imgverify~${runId}~${index}` },
    );
  }

  console.log(`  enqueued ${businesses.length} scoring jobs`);

  const deadline = Date.now() + WAIT_MS;
  let after: WorkerBeat | null = null;
  let completed = 0;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    completed = await queue.getCompletedCount();
    after = await containerBeat();
    const gained = (after?.processed ?? 0) - before.processed;
    if (gained > 0 && completed >= businesses.length) break;
  }

  const gained = (after?.processed ?? 0) - before.processed;

  assert(
    'the container processed at least one job from the queue',
    gained > 0,
    `processed counter ${before.processed} → ${after?.processed ?? 'n/a'}`,
  );
  assert(
    'no job failed on the container',
    (after?.failed ?? 0) === before.failed,
    `failed counter ${before.failed} → ${after?.failed ?? 'n/a'}`,
  );

  const failedCount = await queue.getFailedCount();
  assert('the scoring queue has no failed jobs', failedCount === 0, `${failedCount} failed`);

  // -------------------------------------------------------------------------
  section('3. Idempotency across the queue boundary');

  // Re-adding the same custom job ids must not create new jobs. This is the
  // property the colon-id bug destroyed: an id BullMQ refuses is an id that
  // cannot deduplicate.
  const beforeWaiting = await queue.getWaitingCount();
  for (const [index] of businesses.entries()) {
    await queue.add(
      'score',
      {
        organizationId: businesses[index]!.organizationId,
        businessId: businesses[index]!.id,
        signalsVersion: SIGNALS_VERSION,
        withNarrative: false,
      },
      { jobId: `imgverify~${runId}~${index}` },
    );
  }
  const afterWaiting = await queue.getWaitingCount();

  assert(
    're-enqueueing identical job ids adds no duplicate work',
    afterWaiting <= beforeWaiting,
    `waiting ${beforeWaiting} → ${afterWaiting}`,
  );

  // -------------------------------------------------------------------------
  section('4. Cleanup');

  const removed = await queue.clean(0, 1_000, 'completed');
  console.log(`  removed ${removed.length} completed jobs from the scoring queue`);
}

// A promise chain rather than top-level await: tsx transpiles these scripts to
// CJS, where top-level await is a syntax error.
main()
  .catch((error: unknown) => {
    console.error(`\nAborted: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    const failed = results.filter((r) => !r.pass);
    console.log(`\n${'='.repeat(60)}`);
    console.log(`${results.length - failed.length}/${results.length} passed`);
    if (failed.length > 0) {
      console.log('\nFailures:');
      for (const f of failed) console.log(`  - ${f.label}${f.detail ? ` — ${f.detail}` : ''}`);
      process.exitCode = 1;
    }

    await Promise.allSettled([closeQueues(), closeRedis(), closeDatabase()]);
  });
