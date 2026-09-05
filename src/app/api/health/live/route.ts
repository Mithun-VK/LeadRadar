/**
 * GET /api/health/live — liveness.
 *
 * Shallow by design: no database, no Redis. Liveness answers "should this
 * container be restarted?", and restarting a healthy web process because
 * Postgres is briefly unavailable turns a database blip into an outage.
 */
import { NextResponse } from 'next/server';

import { liveness } from '@/modules/ops/status';

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(liveness(), { headers: { 'cache-control': 'no-store' } });
}
