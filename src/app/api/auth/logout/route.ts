/**
 * POST /api/auth/logout
 *
 * Revokes the session server-side as well as clearing the cookie. Clearing the
 * cookie alone would leave a valid token in any proxy log or browser history able
 * to authenticate again.
 */
import { NextResponse } from 'next/server';

import { clearCsrfCookie } from '@/modules/auth/csrf';
import { clearSessionCookie, currentSession, revokeSession } from '@/modules/auth/session';
import { recordAudit } from '@/modules/database/repositories';

export async function POST(): Promise<NextResponse> {
  const session = await currentSession();

  if (session) {
    await revokeSession(session.sessionId);
    await recordAudit(
      { organizationId: session.organizationId, userId: session.userId },
      { action: 'auth.signed_out', resourceType: 'Session', resourceId: session.sessionId },
    );
  }

  // Cookies are cleared whether or not a session was found, so a stale or already
  // revoked cookie does not linger.
  await clearSessionCookie();
  await clearCsrfCookie();

  return NextResponse.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
}
