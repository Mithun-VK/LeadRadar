/**
 * Prisma client and tenant scoping.
 *
 * The important thing here is not the client singleton — it is that there is no
 * un-scoped way to read tenant data. Repository functions take a
 * {@link TenantContext} explicitly, so "forgot the organizationId filter" is a
 * type error rather than a cross-tenant data leak discovered in production.
 */
import { PrismaClient } from '@prisma/client';

import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { tenantMismatch } from '@/lib/errors';

/**
 * Identifies the tenant on whose behalf a query runs. Passed down from the
 * request or job, never inferred from ambient state — ambient tenancy is how
 * isolation bugs happen.
 */
export interface TenantContext {
  readonly organizationId: string;
  readonly userId?: string;
  /** Correlation id, threaded through for query logging. */
  readonly requestId?: string;
}

declare global {
  // Reused across hot reloads in development; without this, Next.js's module
  // reloading opens a new connection pool on every edit until Postgres refuses.
  var __leadradarPrisma: PrismaClient | undefined;
}

function createClient(): PrismaClient {
  const config = env();

  const client = new PrismaClient({
    log: config.isProduction
      ? [{ emit: 'event', level: 'warn' }, { emit: 'event', level: 'error' }]
      : [{ emit: 'event', level: 'warn' }, { emit: 'event', level: 'error' }],
  });

  const log = logger().child({ component: 'prisma' });

  // Prisma error messages can embed query parameters, which may include a
  // business phone number or address. Logged at warn with the message only —
  // never the params.
  client.$on('warn' as never, (event: { message: string }) => {
    log.warn({ prismaMessage: event.message }, 'Prisma warning');
  });
  client.$on('error' as never, (event: { message: string }) => {
    log.error({ prismaMessage: event.message }, 'Prisma error');
  });

  return client;
}

export function db(): PrismaClient {
  if (!globalThis.__leadradarPrisma) {
    globalThis.__leadradarPrisma = createClient();
  }
  return globalThis.__leadradarPrisma;
}

/**
 * Asserts a fetched row belongs to the caller's tenant.
 *
 * Belt and braces: queries are already scoped by organizationId, but a lookup
 * by primary key is easy to write without a tenant filter, and this makes that
 * mistake fail loudly instead of returning someone else's lead.
 */
export function assertTenant<T extends { organizationId: string }>(
  row: T | null,
  tenant: TenantContext,
  resourceType: string,
): T | null {
  if (row === null) return null;
  if (row.organizationId !== tenant.organizationId) {
    throw tenantMismatch({
      resourceType,
      // The requested tenant is safe to log; the owning tenant is not, since it
      // would confirm the resource exists elsewhere.
      requestedOrganizationId: tenant.organizationId,
    });
  }
  return row;
}

/** Liveness probe for the health endpoint. */
export async function databaseHealthy(): Promise<boolean> {
  try {
    await db().$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

/** Graceful shutdown, so the worker releases its pool before exiting. */
export async function closeDatabase(): Promise<void> {
  if (globalThis.__leadradarPrisma) {
    await globalThis.__leadradarPrisma.$disconnect();
    globalThis.__leadradarPrisma = undefined;
  }
}
