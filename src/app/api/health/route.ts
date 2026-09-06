/**
 * GET /api/health
 *
 * Reports dependency health for a load balancer or uptime monitor.
 *
 * The one route that stays unauthenticated by necessity — a load balancer cannot
 * sign in. It therefore exposes no version, hostname, or configuration: an
 * unauthenticated endpoint must not become a reconnaissance surface.
 */
import { NextResponse } from 'next/server';

import { env } from '@/lib/env';
import { databaseHealthy } from '@/modules/database/client';
import { redisHealthy } from '@/lib/redis';
import { diskHealth } from '@/modules/ops/disk';

export async function GET(): Promise<NextResponse> {
  const [database, redis, disk] = await Promise.all([
    databaseHealthy(),
    redisHealthy(),
    diskHealth(),
  ]);

  /**
   * Disk is checked here, and not only in the authenticated ops screen, because
   * this endpoint is the one an external monitor can actually reach — and this
   * is the exact endpoint that lied.
   *
   * At 0.62 GB free, PostgreSQL blocked writes while reads kept working. The
   * check below it is `SELECT 1`, a read, so this route answered 200 for the
   * entire incident while every login hung for over five minutes. A monitor
   * watching it would have reported the system healthy throughout.
   *
   * Only `critical` degrades the status. A warning is a thing to act on today,
   * not a reason to pull an instance out of the load balancer.
   */
  const healthy = database && redis && disk.state !== 'critical';

  return NextResponse.json(
    {
      status: healthy ? 'ok' : 'degraded',
      // The disk STATE only, never the free-byte figure: this endpoint is
      // unauthenticated, and a capacity number is reconnaissance where a
      // three-word state is not.
      checks: { database, redis, disk: disk.state },
      // Useful to an operator and harmless to disclose: it tells them whether the
      // deployment is serving real or mock data.
      mockMode: env().isMockMode,
    },
    { status: healthy ? 200 : 503, headers: { 'cache-control': 'no-store' } },
  );
}
