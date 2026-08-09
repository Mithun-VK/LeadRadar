/**
 * CSRF protection.
 *
 * `SameSite=Lax` on the session cookie already blocks the classic attack: browsers
 * do not attach the cookie to a cross-site POST. So why add this?
 *
 *   - Lax is a browser behaviour, not a server guarantee. Older browsers, unusual
 *     embedded webviews, and some corporate proxies do not enforce it.
 *   - A single future mistake — one route switching to `SameSite=None` for an
 *     embed or an OAuth flow — would silently remove the only defence.
 *   - Defence in depth on state-changing requests is cheap here.
 *
 * The scheme is double-submit with an HMAC binding. The cookie is readable by
 * JavaScript (it must be, for the client to echo it), so a bare random value could
 * be planted by a subdomain attacker. Binding the token to the session with an
 * HMAC means a planted token that does not match the session is rejected.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';

import { AppError } from '@/lib/errors';
import { env } from '@/lib/env';

import { safeCompare } from './session';

export const CSRF_COOKIE = 'leadradar_csrf';
export const CSRF_HEADER = 'x-csrf-token';

/**
 * Key for the binding HMAC.
 *
 * Uses ENCRYPTION_KEY where configured. In development that key is optional, so a
 * per-process fallback is generated — which means restarting the dev server
 * invalidates outstanding CSRF tokens. That is acceptable in development and
 * cannot happen in production, where ENCRYPTION_KEY is mandatory.
 */
let developmentKey: string | undefined;

function bindingKey(): string {
  const configured = env().ENCRYPTION_KEY;
  if (configured) return configured;

  developmentKey ??= randomBytes(32).toString('hex');
  return developmentKey;
}

/** token = <nonce>.<hmac(nonce, sessionId)>, so it is useless on another session. */
export function issueCsrfToken(sessionId: string): string {
  const nonce = randomBytes(24).toString('base64url');
  const signature = createHmac('sha256', bindingKey())
    .update(`${nonce}.${sessionId}`)
    .digest('base64url');
  return `${nonce}.${signature}`;
}

export function verifyCsrfToken(token: string | undefined, sessionId: string): boolean {
  if (!token) return false;

  const separator = token.lastIndexOf('.');
  if (separator <= 0) return false;

  const nonce = token.slice(0, separator);
  const signature = token.slice(separator + 1);

  const expected = createHmac('sha256', bindingKey())
    .update(`${nonce}.${sessionId}`)
    .digest('base64url');

  return safeCompare(signature, expected);
}

/** Readable by JavaScript by design: the client must echo it in a header. */
export async function setCsrfCookie(sessionId: string): Promise<string> {
  const token = issueCsrfToken(sessionId);
  const store = await cookies();

  store.set(CSRF_COOKIE, token, {
    httpOnly: false,
    secure: env().isProduction,
    sameSite: 'lax',
    path: '/',
  });

  return token;
}

export async function clearCsrfCookie(): Promise<void> {
  const store = await cookies();
  store.set(CSRF_COOKIE, '', {
    httpOnly: false,
    secure: env().isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}

/** Methods that change state and therefore require a valid token. */
const PROTECTED_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Enforces CSRF on a request.
 *
 * Both halves must be present and must agree, and the token must be bound to THIS
 * session. Checking the header against the cookie alone would accept any token an
 * attacker could plant in both.
 *
 * @throws AppError FORBIDDEN
 */
export async function assertCsrf(request: Request, sessionId: string): Promise<void> {
  if (!PROTECTED_METHODS.has(request.method.toUpperCase())) return;

  const header = request.headers.get(CSRF_HEADER) ?? undefined;
  const store = await cookies();
  const cookie = store.get(CSRF_COOKIE)?.value;

  if (!header || !cookie) {
    throw new AppError({
      code: 'FORBIDDEN',
      message: 'CSRF token missing',
      safeMessage: 'Your session could not be verified. Reload the page and try again.',
      context: { hasHeader: Boolean(header), hasCookie: Boolean(cookie) },
    });
  }

  if (!safeCompare(header, cookie)) {
    throw new AppError({
      code: 'FORBIDDEN',
      message: 'CSRF header does not match cookie',
      safeMessage: 'Your session could not be verified. Reload the page and try again.',
    });
  }

  // The binding check: a token planted by a subdomain attacker will not carry a
  // valid HMAC for this session.
  if (!verifyCsrfToken(header, sessionId)) {
    throw new AppError({
      code: 'FORBIDDEN',
      message: 'CSRF token is not bound to this session',
      safeMessage: 'Your session could not be verified. Reload the page and try again.',
    });
  }
}

/**
 * Rejects a cross-origin request outright.
 *
 * A belt-and-braces check alongside the token: if `Origin` is present and is not
 * one of ours, the request is refused regardless of tokens. Absent `Origin` is
 * allowed because same-origin GETs and some legitimate clients omit it — the token
 * check still applies to mutations.
 */
export function assertSameOrigin(request: Request, allowedHosts: readonly string[]): void {
  const origin = request.headers.get('origin');
  if (!origin) return;

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new AppError({
      code: 'FORBIDDEN',
      message: `Unparseable Origin header: ${origin.slice(0, 100)}`,
      safeMessage: 'Request rejected.',
    });
  }

  const requestHost = new URL(request.url).host;
  if (originHost !== requestHost && !allowedHosts.includes(originHost)) {
    throw new AppError({
      code: 'FORBIDDEN',
      message: `Cross-origin request from ${originHost}`,
      safeMessage: 'Request rejected.',
      context: { originHost },
    });
  }
}
