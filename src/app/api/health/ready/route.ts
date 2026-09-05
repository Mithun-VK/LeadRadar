/**
 * GET /api/health/ready — readiness.
 *
 * Deep: the dependencies a request actually needs. A load balancer should stop
 * routing here when these fail, without the process being killed. Returns 503 so
 * an orchestrator can act on the status code alone.
 */
import { NextResponse } from 'next/server';

import { readiness } from '@/modules/ops/status';

export async function GET(): Promise<NextResponse> {
  const result = await readiness();
  return NextResponse.json(result, {
    status: result.status === 'ok' ? 200 : 503,
    headers: { 'cache-control': 'no-store' },
  });
}
