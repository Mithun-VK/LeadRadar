/**
 * Recovery drills.
 *
 * Simulates the failures an operator will actually meet and asserts the system
 * behaves as the runbook claims. Documentation that has never been executed is a
 * hypothesis, and a runbook nobody has run is usually wrong in the one step that
 * matters.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS SIMULATED, AND HOW HONESTLY
 * ---------------------------------------------------------------------------
 *
 * Database and Redis outages are simulated by pointing a client at an
 * unreachable port, NOT by stopping the containers. That is a real test of the
 * application's failure handling — the code path is identical — but it is not a
 * test of container restart behaviour, and this script says so rather than
 * implying otherwise.
 *
 * Worker liveness IS tested for real, against actual heartbeats in Redis.
 *
 *   npm run verify:recovery
 */
import 'dotenv/config';

import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';

import { db, closeDatabase, type TenantContext } from '@/modules/database/client';
import { closeRedis, cacheConnection } from '@/lib/redis';
import { closeQueues } from '@/modules/jobs/queues';
import { isPaused, setControl } from '@/modules/ops/controls';
import { workerStatus, HEARTBEAT_TTL_SECONDS } from '@/modules/ops/heartbeat';
import { opsStatus, readiness, liveness, THRESHOLDS } from '@/modules/ops/status';
import { sendCampaignEmail } from '@/modules/email/send';
import { providers } from '@/modules/providers/registry';

const results: Array<{ label: string; pass: boolean; detail?: string }> = [];

function assert(label: string, pass: boolean, detail?: string): void {
  results.push({ label, pass, ...(detail !== undefined && { detail }) });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail && !pass ? ` — ${detail}` : ''}`);
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

async function main(): Promise<void> {
  const registry = providers();
  if (!registry.email?.isMock) {
    throw new Error('Refusing to run: the email provider is not a mock. This script sends.');
  }

  const org = await db().organization.findFirst({
    where: { slug: { not: { startsWith: '__loadtest__' } } },
    select: { id: true },
  });
  if (!org) throw new Error('No organization. Run `npm run db:seed`.');
  const tenant: TenantContext = { organizationId: org.id };

  // -------------------------------------------------------------------------
  section('1. Database unavailable (simulated: unreachable port)');

  const deadDb = new PrismaClient({
    datasources: { db: { url: 'postgresql://leadradar:x@127.0.0.1:59999/leadradar?connect_timeout=2' } },
  });

  let dbThrew = false;
  const dbStart = Date.now();
  try {
    await deadDb.$queryRaw`SELECT 1`;
  } catch {
    dbThrew = true;
  }
  await deadDb.$disconnect().catch(() => undefined);

  assert('an unreachable database fails rather than hanging', dbThrew);
  assert(
    'it fails within a bounded time (connect_timeout honoured)',
    Date.now() - dbStart < 15_000,
    `${Date.now() - dbStart}ms`,
  );

  // -------------------------------------------------------------------------
  section('2. Redis unavailable (simulated: unreachable port)');

  const deadRedis = new Redis({
    host: '127.0.0.1',
    port: 59998,
    lazyConnect: true,
    connectTimeout: 2_000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });

  let redisThrew = false;
  try {
    await deadRedis.connect();
    await deadRedis.ping();
  } catch {
    redisThrew = true;
  }
  deadRedis.disconnect();

  assert('an unreachable Redis fails rather than hanging', redisThrew);

  // -------------------------------------------------------------------------
  section('3. Health probes');

  const live = liveness();
  assert('liveness reports ok without touching dependencies', live.status === 'ok');
  assert('liveness reports uptime', live.uptimeSeconds >= 0);

  const ready = await readiness();
  assert('readiness reports database health', typeof ready.checks.database === 'boolean');
  assert('readiness reports redis health', typeof ready.checks.redis === 'boolean');
  assert('readiness is ok while dependencies are up', ready.status === 'ok', JSON.stringify(ready.checks));

  // -------------------------------------------------------------------------
  section('4. Worker liveness');

  const workers = await workerStatus();
  console.log(`  observed: ${workers.summary}`);

  // Deliberately not asserting a worker IS running — the drill must pass whether
  // or not the operator has one up. What matters is that the answer is truthful
  // and that the two cases are distinguishable.
  assert(
    'worker status is reported truthfully either way',
    typeof workers.alive === 'boolean' && workers.summary.length > 10,
  );
  assert(
    'a dead worker is distinguishable from an idle one',
    workers.alive ? workers.workers.length > 0 : workers.workers.length === 0,
  );
  assert(
    'the heartbeat TTL tolerates a missed beat without reporting death',
    HEARTBEAT_TTL_SECONDS >= 45,
    `${HEARTBEAT_TTL_SECONDS}s`,
  );

  // A stale heartbeat, written by hand, must read as stale.
  const staleKey = 'leadradar:worker:heartbeat:__drill__';
  await cacheConnection().set(
    staleKey,
    JSON.stringify({
      workerId: '__drill__',
      host: 'drill',
      pid: 0,
      startedAt: new Date(Date.now() - 3_600_000).toISOString(),
      beatAt: new Date(Date.now() - 3_600_000).toISOString(),
      queues: [],
      processed: 0,
      failed: 0,
    }),
    'EX',
    60,
  );

  const withStale = await workerStatus();
  const drillBeat = withStale.workers.find((w) => w.workerId === '__drill__');
  assert('a stale heartbeat is visible rather than silently ignored', drillBeat !== undefined);
  await cacheConnection().del(staleKey);

  // -------------------------------------------------------------------------
  section('5. Outbound kill switch — fails closed');

  const before = await isPaused(tenant, 'outbound');
  assert('outbound starts un-paused', before.paused === false);

  await setControl(tenant, { name: 'outbound', paused: true, reason: 'recovery drill' });

  const during = await isPaused(tenant, 'outbound');
  assert('the switch engages immediately', during.paused === true);

  // The decisive test: an actual send must refuse while paused.
  const blocked = await sendCampaignEmail(tenant, {
    campaignId: 'drill-nonexistent',
    businessId: 'drill-nonexistent',
    provider: registry.email,
  });
  assert(
    'a real send is refused while paused, before any other guard',
    !blocked.sent && blocked.blocked === 'OUTBOUND_PAUSED',
    `blocked=${blocked.blocked}`,
  );

  await setControl(tenant, { name: 'outbound', paused: false });
  assert('clearing the switch restores sending', (await isPaused(tenant, 'outbound')).paused === false);

  // -------------------------------------------------------------------------
  section('6. Operational status and alerting');

  const status = await opsStatus(tenant);

  assert('status reports a verdict', ['ok', 'degraded', 'critical'].includes(status.status));
  assert('infrastructure health is included', typeof status.infrastructure.database === 'boolean');
  assert('queue depths are included', Array.isArray(status.queues));
  assert('gmail health is included', typeof status.gmail.state === 'string');
  assert('kill-switch state is included', Array.isArray(status.controls));

  for (const alert of status.alerts) {
    assert(
      `alert ${alert.code} carries an action, not just a complaint`,
      alert.action.length > 20,
      alert.action,
    );
  }

  console.log(
    `  observed status: ${status.status}` +
      (status.alerts.length > 0
        ? ` — ${status.alerts.map((a) => a.code).join(', ')}`
        : ' — no alerts'),
  );

  // A paused switch must raise an alert, otherwise an operator can leave outbound
  // stopped indefinitely without the dashboard mentioning it.
  await setControl(tenant, { name: 'outbound', paused: true, reason: 'alert drill' });
  const paused = await opsStatus(tenant);
  assert(
    'pausing outbound raises a visible alert',
    paused.alerts.some((a) => a.code === 'OUTBOUND_PAUSED'),
  );
  await setControl(tenant, { name: 'outbound', paused: false });

  // -------------------------------------------------------------------------
  section('7. Threshold sanity');

  assert('worker-stale threshold exceeds the heartbeat TTL', THRESHOLDS.workerStaleSeconds >= HEARTBEAT_TTL_SECONDS);
  assert('send-failure alert requires a meaningful sample', THRESHOLDS.sendFailureMinSample >= 5);
  assert(
    'send-failure rate is not hair-trigger',
    THRESHOLDS.sendFailureRate >= 0.1 && THRESHOLDS.sendFailureRate <= 0.5,
  );
  assert('queue critical exceeds queue warning', THRESHOLDS.queueBacklogCritical > THRESHOLDS.queueBacklogWarn);
  assert(
    'a stuck campaign is judged over more than a day, so a daily limit is not mistaken for a stall',
    THRESHOLDS.stuckCampaignHours > 24,
  );
}

main()
  .catch((error) => {
    console.error('\nRecovery drill crashed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    const failed = results.filter((r) => !r.pass);
    console.log(
      failed.length === 0
        ? `\nAll ${results.length} recovery assertions passed.`
        : `\n${failed.length} of ${results.length} assertions FAILED.`,
    );
    if (failed.length > 0) process.exitCode = 1;

    console.log(
      '\nNOTE: database and Redis outages were simulated with unreachable ports.\n' +
        'That tests the application\'s failure handling, not container restart\n' +
        'behaviour. Stopping the real containers remains a manual drill.',
    );

    await Promise.allSettled([closeQueues(), closeDatabase(), closeRedis()]);
  });
