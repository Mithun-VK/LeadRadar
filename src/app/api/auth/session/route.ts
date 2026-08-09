/**
 * GET /api/auth/session
 *
 * Who am I, and a fresh CSRF token. Returns 200 with `authenticated: false` rather
 * than 401 so the client can distinguish "not signed in" from a transport failure.
 */
import { NextResponse } from 'next/server';

import { setCsrfCookie } from '@/modules/auth/csrf';
import { currentSession } from '@/modules/auth/session';

export async function GET(): Promise<NextResponse> {
  const session = await currentSession();

  if (!session) {
    return NextResponse.json(
      { authenticated: false },
      { headers: { 'cache-control': 'no-store' } },
    );
  }

  // Re-issued on every check so a token cannot go stale mid-session.
  const csrfToken = await setCsrfCookie(session.sessionId);

  return NextResponse.json(
    {
      authenticated: true,
      user: { email: session.email, name: session.name, role: session.role },
      organizationId: session.organizationId,
      csrfToken,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
