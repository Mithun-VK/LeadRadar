/**
 * Edge middleware — the coarse gate in front of the dashboard.
 *
 * Deliberately shallow: it checks only that a session COOKIE is present, and does
 * not validate it. Middleware runs before the Node runtime and cannot reach
 * PostgreSQL, so a real check is impossible here.
 *
 * That is fine, because this is not the security boundary. Every route handler and
 * every server component calls `requireSession()`, which validates against the
 * database. Middleware exists purely to redirect a signed-out visitor to the login
 * page instead of rendering a dashboard shell that would then fail — a UX
 * improvement, not a control.
 *
 * Anyone tempted to treat this as the authorisation layer should read that
 * paragraph again: a forged cookie passes this check and fails the real one.
 */
import { NextResponse, type NextRequest } from 'next/server';

const SESSION_COOKIE = 'leadradar_session';
const LOGIN_PATH = '/login';

export function middleware(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  const hasSessionCookie = Boolean(request.cookies.get(SESSION_COOKIE)?.value);

  // Signed-in users should not sit on the login page.
  if (pathname === LOGIN_PATH && hasSessionCookie) {
    return NextResponse.redirect(new URL('/dashboard', request.url));
  }

  if (pathname.startsWith('/dashboard') && !hasSessionCookie) {
    const login = new URL(LOGIN_PATH, request.url);
    // Preserve the destination so sign-in returns the user where they were going.
    // Only the path and query are carried, never a full URL, so this cannot be
    // turned into an open redirect.
    login.searchParams.set('next', `${pathname}${search}`);
    return NextResponse.redirect(login);
  }

  return NextResponse.next();
}

export const config = {
  /**
   * API routes are intentionally excluded: they must return 401 JSON rather than a
   * redirect to HTML, which would break every client.
   */
  matcher: ['/dashboard/:path*', '/login'],
};
