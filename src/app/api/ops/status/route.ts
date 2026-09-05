/**
 * GET /api/ops/status — the operator's single screen.
 *
 * Authenticated and tenant-scoped, unlike /api/health: it reports queue depths,
 * worker hostnames, campaign counts, and failure rates, which together describe
 * the shape of a deployment. That belongs behind a session.
 */
import { handler } from '@/modules/api/handler';
import { opsStatus } from '@/modules/ops/status';

export const GET = handler(async ({ tenant }) => opsStatus(tenant));
