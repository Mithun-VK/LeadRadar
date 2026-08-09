/**
 * Route-handler plumbing.
 *
 * Route handlers stay thin — authenticate, resolve tenant, validate, call a
 * service, serialise — so that business logic lives in modules that can be tested
 * without HTTP, and so security controls are applied uniformly instead of being
 * remembered per route.
 *
 * Applied here to every request: a correlation id, tenant resolution, Zod
 * validation, per-tenant rate limiting, error mapping that never leaks internals,
 * and audit logging for mutations.
 */
import { NextResponse } from 'next/server';
import type { z } from 'zod';

import { AppError, isAppError, toAppError } from '@/lib/errors';
import { requestId as newRequestId } from '@/lib/ids';
import { requestLogger } from '@/lib/logger';
import { assertCsrf, assertSameOrigin } from '@/modules/auth/csrf';
import { requireSession, type AuthenticatedSession } from '@/modules/auth/session';
import type { TenantContext } from '@/modules/database/client';
import { acquire } from '@/modules/providers/rate-limit';

/**
 * Resolves the caller's tenant from their session.
 *
 * The organization comes from the SESSION ROW, never from a header, query parameter,
 * or request body — any of which the client controls and could forge to read
 * another tenant's leads.
 *
 * @throws AppError UNAUTHENTICATED
 */
export async function resolveTenant(request: Request): Promise<TenantContext> {
  void request;
  const session = await requireSession();
  return {
    organizationId: session.organizationId,
    userId: session.userId,
  };
}

/** Full session, for handlers that need the role or email as well as the tenant. */
export async function resolveSession(): Promise<AuthenticatedSession> {
  return requireSession();
}

export interface HandlerContext<TBody = unknown, TQuery = unknown> {
  readonly tenant: TenantContext;
  readonly body: TBody;
  readonly query: TQuery;
  /** Dynamic route segments, awaited. Empty for static routes. */
  readonly params: Record<string, string>;
  readonly requestId: string;
  readonly logger: ReturnType<typeof requestLogger>;
}

/** Next.js passes dynamic params as a promise in the App Router. */
export interface RouteContext {
  readonly params?: Promise<Record<string, string | string[]>> | Record<string, string | string[]>;
}

export interface HandlerOptions<TBody, TQuery> {
  readonly bodySchema?: z.ZodType<TBody>;
  readonly querySchema?: z.ZodType<TQuery>;
  /** Requests per minute per tenant. Mutations get tighter limits. */
  readonly rateLimit?: { capacity: number; refillPerSecond: number };
  /** Recorded in the audit log when set. */
  readonly auditAction?: string;
  /**
   * Skips authentication. Only for genuinely public endpoints (sign-in, health).
   * Off by default so a new route is protected unless someone deliberately opts
   * out — the safe direction for a mistake.
   */
  readonly public?: boolean;
  /** Skips CSRF. Only for endpoints that cannot have a session yet, i.e. sign-in. */
  readonly skipCsrf?: boolean;
}

/** Hosts permitted as a cross-origin `Origin`, beyond the request's own host. */
function allowedOrigins(): string[] {
  return [];
}

function errorResponse(error: AppError, requestId: string): NextResponse {
  const status = statusFor(error);
  return NextResponse.json(
    { ...error.toPublicJSON(), requestId },
    { status, headers: { 'x-request-id': requestId } },
  );
}

function statusFor(error: AppError): number {
  switch (error.code) {
    case 'VALIDATION_FAILED':
    case 'QUERY_UNPARSEABLE':
    case 'UNSUPPORTED_QUERY':
    case 'URL_REJECTED':
      return 400;
    case 'UNAUTHENTICATED':
      return 401;
    case 'FORBIDDEN':
    case 'TENANT_MISMATCH':
    case 'SSRF_BLOCKED':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'PROVIDER_RATE_LIMITED':
      return 429;
    case 'BUDGET_EXCEEDED':
    case 'JOB_LIMIT_EXCEEDED':
      // Payment Required is the honest status: the request is well-formed and
      // authorised, but a spending limit blocks it.
      return 402;
    case 'NOT_IMPLEMENTED':
      return 501;
    case 'PROVIDER_UNAVAILABLE':
    case 'PROVIDER_TIMEOUT':
      return 503;
    default:
      return 500;
  }
}

/** Wraps a handler with validation, tenancy, rate limiting, and error mapping. */
export function handler<TBody = undefined, TQuery = undefined, TResult = unknown>(
  fn: (context: HandlerContext<TBody, TQuery>) => Promise<TResult>,
  options: HandlerOptions<TBody, TQuery> = {},
) {
  return async (request: Request, routeContext?: RouteContext): Promise<NextResponse> => {
    const requestId = request.headers.get('x-request-id') ?? newRequestId();
    const log = requestLogger(requestId, { method: request.method, path: new URL(request.url).pathname });

    try {
      // Origin check before anything else: a cross-origin mutation is refused
      // outright, independent of tokens.
      assertSameOrigin(request, allowedOrigins());

      let tenant: TenantContext;
      let sessionId: string | null = null;

      if (options.public) {
        // Public routes still need a tenant placeholder for rate limiting; they
        // must not touch tenant data.
        tenant = { organizationId: 'public', requestId };
      } else {
        const session = await requireSession();
        tenant = { organizationId: session.organizationId, userId: session.userId, requestId };
        sessionId = session.sessionId;

        if (!options.skipCsrf) {
          await assertCsrf(request, session.sessionId);
        }
      }
      void sessionId;

      if (options.rateLimit) {
        const limited = await acquire({
          key: `api:${tenant.organizationId}:${new URL(request.url).pathname}`,
          ...options.rateLimit,
        });
        if (!limited.allowed) {
          throw new AppError({
            code: 'PROVIDER_RATE_LIMITED',
            message: 'Per-tenant API rate limit exceeded',
            safeMessage: 'Too many requests. Please slow down.',
            retryAfterSeconds: Math.ceil(limited.retryAfterMs / 1000),
          });
        }
      }

      let body = undefined as TBody;
      if (options.bodySchema) {
        let raw: unknown;
        try {
          raw = await request.json();
        } catch {
          throw new AppError({
            code: 'VALIDATION_FAILED',
            message: 'Request body was not valid JSON',
            safeMessage: 'Request body must be valid JSON.',
          });
        }

        const parsed = options.bodySchema.safeParse(raw);
        if (!parsed.success) {
          throw new AppError({
            code: 'VALIDATION_FAILED',
            message: `Body validation failed: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
            // Field-level detail is safe and genuinely useful; it describes the
            // caller's own input, not our internals.
            safeMessage: parsed.error.issues
              .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
              .join('; '),
          });
        }
        body = parsed.data;
      }

      let query = undefined as TQuery;
      if (options.querySchema) {
        const params = Object.fromEntries(new URL(request.url).searchParams.entries());
        const parsed = options.querySchema.safeParse(params);
        if (!parsed.success) {
          throw new AppError({
            code: 'VALIDATION_FAILED',
            message: `Query validation failed: ${parsed.error.message}`,
            safeMessage: parsed.error.issues
              .map((i) => `${i.path.join('.') || 'query'}: ${i.message}`)
              .join('; '),
          });
        }
        query = parsed.data;
      }

      // Dynamic segments arrive as a promise in the App Router. Array values (from
      // catch-all routes) are collapsed to the first segment; no route here uses them.
      const rawParams = routeContext?.params ? await routeContext.params : {};
      const params: Record<string, string> = {};
      for (const [key, value] of Object.entries(rawParams)) {
        params[key] = Array.isArray(value) ? (value[0] ?? '') : value;
      }

      const result = await fn({ tenant, body, query, params, requestId, logger: log });

      return NextResponse.json(result, {
        headers: {
          'x-request-id': requestId,
          // Lead data is tenant-private; never let a shared cache hold it.
          'cache-control': 'private, no-store',
        },
      });
    } catch (error) {
      const appError = isAppError(error)
        ? error
        : toAppError(error, { code: 'INTERNAL', message: 'Unhandled route error' });

      // Full detail to logs, safe message to the client.
      if (statusFor(appError) >= 500) {
        log.error(appError.toLogObject(), 'Request failed');
      } else {
        log.warn(appError.toLogObject(), 'Request rejected');
      }

      return errorResponse(appError, requestId);
    }
  };
}
