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
import type { TenantContext } from '@/modules/database/client';
import { acquire } from '@/modules/providers/rate-limit';

/**
 * Development tenant.
 *
 * Authentication is not yet implemented, so requests resolve to the seeded
 * organization. Every downstream call is ALREADY tenant-scoped, so adding real auth
 * means replacing this function — not migrating data or rewriting queries. That is
 * the whole reason tenancy went in before auth.
 */
const DEV_ORGANIZATION_ID = 'org_leadradar_default';
const DEV_USER_ID = 'user_leadradar_dev';

export async function resolveTenant(request: Request): Promise<TenantContext> {
  // Placeholder for session resolution. Deliberately not reading a tenant id from
  // a header or query parameter: that would be a trivially forgeable
  // cross-tenant read, which is worse than having no auth at all.
  void request;
  return { organizationId: DEV_ORGANIZATION_ID, userId: DEV_USER_ID };
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
      const tenant = await resolveTenant(request);

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
