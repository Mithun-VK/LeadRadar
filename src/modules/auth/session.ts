/**
 * Session management.
 *
 * Server-side sessions in PostgreSQL rather than stateless JWTs, for one decisive
 * reason: **revocation**. A lead database is exactly the kind of data where "sign
 * out all devices" and "revoke a compromised session immediately" must actually
 * work. A JWT cannot be revoked before it expires without a server-side denylist —
 * at which point it is a session table with extra steps.
 *
 * The token is stored hashed. A database leak yields no usable sessions, the same
 * property passwords get.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';

import { AppError } from '@/lib/errors';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { db } from '@/modules/database/client';

export const SESSION_COOKIE = 'leadradar_session';

/** Absolute lifetime. A session cannot outlive this however active it is. */
export const SESSION_ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Idle lifetime. An unused session dies well before the absolute limit. */
export const SESSION_IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Only rewrite lastSeenAt past this age, so reads don't cause a write per request. */
const LAST_SEEN_WRITE_INTERVAL_MS = 5 * 60 * 1000;

export interface AuthenticatedSession {
  readonly sessionId: string;
  readonly userId: string;
  readonly organizationId: string;
  readonly email: string;
  readonly name: string | null;
  readonly role: string;
}

/** 32 bytes of CSPRNG entropy, URL-safe. */
function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * SHA-256, not scrypt.
 *
 * Correct here and wrong for passwords: a session token already has 256 bits of
 * random entropy, so it is not brute-forceable and needs no key stretching — while
 * stretching would add ~100ms to every authenticated request.
 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** IPs are personal data; a hash is enough to notice the address changed. */
function hashIp(ip: string | null): string | null {
  if (!ip) return null;
  return createHash('sha256').update(ip).digest('hex').slice(0, 32);
}

export interface CreateSessionInput {
  readonly userId: string;
  readonly organizationId: string;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

/**
 * Creates a session and returns the plaintext token — the only time it exists.
 *
 * The session id comes back too, because the CSRF token is bound to it and the
 * caller would otherwise have to re-query by token hash immediately.
 */
export async function createSession(input: CreateSessionInput): Promise<{
  sessionId: string;
  token: string;
  expiresAt: Date;
}> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_ABSOLUTE_TTL_MS);

  const row = await db().session.create({
    select: { id: true },
    data: {
      userId: input.userId,
      organizationId: input.organizationId,
      tokenHash: hashToken(token),
      expiresAt,
      ipHash: hashIp(input.ip ?? null),
      userAgent: input.userAgent?.slice(0, 300) ?? null,
    },
  });

  return { sessionId: row.id, token, expiresAt };
}

/**
 * Resolves a token to a session, or null.
 *
 * Enforces absolute expiry, idle expiry, and revocation, and confirms the
 * membership still exists — so removing someone from an organization takes effect
 * on their next request rather than whenever their session happens to expire.
 */
export async function validateSessionToken(
  token: string | undefined,
): Promise<AuthenticatedSession | null> {
  if (!token || token.length < 32 || token.length > 128) return null;

  const row = await db().session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: { select: { id: true, email: true, name: true } } },
  });

  if (!row || row.revokedAt !== null) return null;

  const now = Date.now();
  if (row.expiresAt.getTime() <= now) return null;
  if (now - row.lastSeenAt.getTime() > SESSION_IDLE_TTL_MS) {
    // Idle sessions are revoked rather than merely rejected, so they stop
    // occupying the table and cannot be resurrected.
    await db()
      .session.update({ where: { id: row.id }, data: { revokedAt: new Date() } })
      .catch(() => undefined);
    return null;
  }

  // Membership is re-checked every request: a revoked membership must end access
  // immediately, not at session expiry.
  const membership = await db().membership.findUnique({
    where: {
      organizationId_userId: { organizationId: row.organizationId, userId: row.userId },
    },
    select: { role: true },
  });

  if (!membership) {
    await db()
      .session.update({ where: { id: row.id }, data: { revokedAt: new Date() } })
      .catch(() => undefined);
    return null;
  }

  // Throttled so a read-heavy dashboard does not write on every request.
  if (now - row.lastSeenAt.getTime() > LAST_SEEN_WRITE_INTERVAL_MS) {
    await db()
      .session.update({ where: { id: row.id }, data: { lastSeenAt: new Date() } })
      .catch(() => undefined);
  }

  return {
    sessionId: row.id,
    userId: row.userId,
    organizationId: row.organizationId,
    email: row.user.email,
    name: row.user.name,
    role: membership.role,
  };
}

export async function revokeSession(sessionId: string): Promise<void> {
  await db().session.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** Sign out everywhere. Used after a password change or a suspected compromise. */
export async function revokeAllSessions(userId: string): Promise<number> {
  const { count } = await db().session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return count;
}

/** Housekeeping: drop rows that can never authenticate again. */
export async function purgeExpiredSessions(): Promise<number> {
  const { count } = await db().session.deleteMany({
    where: {
      OR: [
        { expiresAt: { lt: new Date() } },
        { revokedAt: { lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
      ],
    },
  });
  return count;
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

/**
 * Cookie attributes.
 *
 * `httpOnly` keeps the token out of reach of any XSS that slips through.
 * `sameSite: 'lax'` is the primary CSRF defence: browsers do not attach the cookie
 * to cross-site POSTs, which is every mutating request here. `secure` is on
 * whenever we are not on plain-HTTP localhost.
 */
export function sessionCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    secure: env().isProduction,
    sameSite: 'lax' as const,
    path: '/',
    expires: expiresAt,
  };
}

export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, sessionCookieOptions(expiresAt));
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, '', { ...sessionCookieOptions(new Date(0)), maxAge: 0 });
}

export async function readSessionCookie(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(SESSION_COOKIE)?.value;
}

/** Current session from cookies, or null. */
export async function currentSession(): Promise<AuthenticatedSession | null> {
  try {
    return await validateSessionToken(await readSessionCookie());
  } catch (error) {
    logger().error({ err: error }, 'Session validation failed');
    // Fail closed: an error resolving a session means no session.
    return null;
  }
}

/** Current session, or a 401-mapped error. */
export async function requireSession(): Promise<AuthenticatedSession> {
  const session = await currentSession();
  if (!session) {
    throw new AppError({
      code: 'UNAUTHENTICATED',
      message: 'No valid session',
      safeMessage: 'Please sign in to continue.',
    });
  }
  return session;
}

/** Constant-time string comparison for tokens supplied by a client. */
export function safeCompare(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}
