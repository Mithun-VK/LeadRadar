/**
 * POST /api/auth/login
 *
 * Public and CSRF-exempt — necessarily, since there is no session to bind a token
 * to yet. The protections that apply instead: a same-origin check, a strict
 * per-IP rate limit, account lockout, and responses that are identical for every
 * failure mode.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { AppError, isAppError, toAppError } from '@/lib/errors';
import { requestId as newRequestId } from '@/lib/ids';
import { requestLogger } from '@/lib/logger';
import { assertSameOrigin, setCsrfCookie } from '@/modules/auth/csrf';
import { setSessionCookie } from '@/modules/auth/session';
import { signIn } from '@/modules/auth/service';
import { acquire } from '@/modules/providers/rate-limit';

const bodySchema = z
  .object({
    email: z.string().trim().email().max(320),
    password: z.string().min(1).max(256),
  })
  .strict();

/** Client IP from the proxy chain, taking the first hop only. */
function clientIp(request: Request): string | null {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return request.headers.get('x-real-ip');
}

export async function POST(request: Request): Promise<NextResponse> {
  const requestId = newRequestId();
  const log = requestLogger(requestId, { route: '/api/auth/login' });

  try {
    assertSameOrigin(request, []);

    const ip = clientIp(request);

    /**
     * Per-IP throttle on top of per-account lockout. The two cover different
     * attacks: lockout stops guessing one password against many attempts, this
     * stops spraying one password across many accounts.
     */
    const limited = await acquire({
      key: `auth:login:${ip ?? 'unknown'}`,
      capacity: 10,
      refillPerSecond: 0.05,
    });
    if (!limited.allowed) {
      throw new AppError({
        code: 'PROVIDER_RATE_LIMITED',
        message: 'Login rate limit exceeded',
        safeMessage: 'Too many sign-in attempts. Please wait a minute and try again.',
        retryAfterSeconds: Math.ceil(limited.retryAfterMs / 1000),
      });
    }

    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        message: 'Body was not JSON',
        safeMessage: 'Invalid request.',
      });
    }

    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      // Deliberately generic: field-level detail here would confirm which half of
      // the credential pair was malformed.
      throw new AppError({
        code: 'VALIDATION_FAILED',
        message: 'Invalid login body',
        safeMessage: 'Enter a valid email address and password.',
      });
    }

    const result = await signIn({
      email: parsed.data.email,
      password: parsed.data.password,
      ip,
      userAgent: request.headers.get('user-agent'),
    });

    await setSessionCookie(result.token, result.expiresAt);
    // Issued now so the very first mutating request after sign-in has a token.
    const csrfToken = await setCsrfCookie(result.sessionId);

    log.info({ userId: result.userId }, 'Sign-in succeeded');

    return NextResponse.json(
      { ok: true, csrfToken },
      { headers: { 'x-request-id': requestId, 'cache-control': 'no-store' } },
    );
  } catch (error) {
    const appError = isAppError(error)
      ? error
      : toAppError(error, { code: 'INTERNAL', message: 'Login failed' });

    log.warn(appError.toLogObject(), 'Sign-in rejected');

    const status =
      appError.code === 'UNAUTHENTICATED'
        ? 401
        : appError.code === 'PROVIDER_RATE_LIMITED'
          ? 429
          : appError.code === 'FORBIDDEN'
            ? 403
            : appError.code === 'VALIDATION_FAILED'
              ? 400
              : 500;

    return NextResponse.json({ ...appError.toPublicJSON(), requestId }, {
      status,
      headers: { 'x-request-id': requestId, 'cache-control': 'no-store' },
    });
  }
}
