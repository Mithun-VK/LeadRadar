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

export async function GET(): Promise<NextResponse> {
  const [database, redis] = await Promise.all([databaseHealthy(), redisHealthy()]);
  const healthy = database && redis;

  return NextResponse.json(
    {
      status: healthy ? 'ok' : 'degraded',
      checks: { database, redis },
      // Useful to an operator and harmless to disclose: it tells them whether the
      // deployment is serving real or mock data.
      mockMode: env().isMockMode,
    },
    { status: healthy ? 200 : 503, headers: { 'cache-control': 'no-store' } },
  );
}
