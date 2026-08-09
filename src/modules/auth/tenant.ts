/**
 * Tenant resolution for server components.
 *
 * Route handlers get their tenant through the `handler()` wrapper. Server
 * components have no such wrapper, and previously each one fabricated a `Request`
 * just to satisfy `resolveTenant` — which worked, but obscured the fact that the
 * tenant comes from the session cookie rather than from the request.
 *
 * This makes that explicit and gives both paths one implementation.
 */
import type { TenantContext } from '@/modules/database/client';

import { requireSession } from './session';

/** @throws AppError UNAUTHENTICATED when there is no valid session. */
export async function requireTenant(): Promise<TenantContext> {
  const session = await requireSession();
  return { organizationId: session.organizationId, userId: session.userId };
}
