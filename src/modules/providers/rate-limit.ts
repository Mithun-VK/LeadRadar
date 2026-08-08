/**
 * Distributed rate limiting and budget enforcement.
 *
 * Both are implemented as Redis Lua scripts, which matters more than it looks:
 *
 *   - Check-then-act in application code is a race. With N concurrent workers,
 *     every one of them can read "budget remaining" before any of them writes,
 *     and the budget is blown by a factor of N. A single atomic script is the
 *     only correct answer.
 *   - Enforcement happens BEFORE the provider call, not after. Accounting after
 *     the fact tells you how much you overspent; it does not prevent it.
 *
 * A Redis outage fails closed for budgets (no spend) and open for rate limits
 * (the provider's own 429 becomes the backstop) — the asymmetry is deliberate:
 * overspending is irreversible, while a provider 429 is merely a retry.
 */
import type { Redis } from 'ioredis';

import { budgetExceeded } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { cacheConnection } from '@/lib/redis';

/**
 * Token bucket. Refills continuously rather than in fixed windows, so a burst at
 * a window boundary cannot double the effective rate.
 *
 * KEYS[1] bucket, ARGV: capacity, refillPerSecond, nowMs, requested
 * Returns: {allowed, remainingTokens, retryAfterMs}
 */
const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refillPerSec = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local requested = tonumber(ARGV[4])

local state = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts = tonumber(state[2])

if tokens == nil then
  tokens = capacity
  ts = now
end

local elapsed = math.max(0, now - ts) / 1000
tokens = math.min(capacity, tokens + elapsed * refillPerSec)

local allowed = 0
local retryAfterMs = 0

if tokens >= requested then
  tokens = tokens - requested
  allowed = 1
else
  local deficit = requested - tokens
  retryAfterMs = math.ceil((deficit / refillPerSec) * 1000)
end

redis.call('HMSET', key, 'tokens', tokens, 'ts', now)
-- Expire well after a full refill so idle buckets do not accumulate.
redis.call('PEXPIRE', key, math.ceil((capacity / refillPerSec) * 1000) + 60000)

return {allowed, math.floor(tokens), retryAfterMs}
`;

/**
 * Budget reservation. Reserves optimistically against an estimate, so the cap
 * cannot be exceeded by concurrency; {@link settleBudget} then corrects to the
 * actual cost.
 *
 * KEYS[1] counter, ARGV: limitMicros, estimatedMicros, ttlSeconds
 * Returns: {allowed, spentMicros}
 */
const BUDGET_RESERVE_LUA = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local cost = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])

local spent = tonumber(redis.call('GET', key) or '0')

if spent + cost > limit then
  return {0, spent}
end

local updated = redis.call('INCRBY', key, cost)
if tonumber(redis.call('TTL', key)) < 0 then
  redis.call('EXPIRE', key, ttl)
end

return {1, updated}
`;

export interface RateLimitConfig {
  readonly key: string;
  readonly capacity: number;
  readonly refillPerSecond: number;
}

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterMs: number;
}

/**
 * Provider-specific defaults, chosen conservatively below documented ceilings so
 * LeadRadar is never the reason a provider throttles the account.
 */
export const PROVIDER_LIMITS: Record<string, Omit<RateLimitConfig, 'key'>> = {
  // Google does not publish a hard per-second QPS for Places (New); this is a
  // safe self-imposed ceiling that also paces spend.
  'google-places': { capacity: 20, refillPerSecond: 10 },
  // Firecrawl Standard documents 500 rpm for scrape/search; stay well under.
  firecrawl: { capacity: 30, refillPerSecond: 6 },
  // Groq free-tier RPM is low (30 for several models); the paid tier is higher.
  groq: { capacity: 10, refillPerSecond: 0.5 },
};

export async function acquire(
  config: RateLimitConfig,
  tokens = 1,
  redis: Redis = cacheConnection(),
): Promise<RateLimitResult> {
  try {
    const raw = (await redis.eval(
      TOKEN_BUCKET_LUA,
      1,
      `ratelimit:${config.key}`,
      String(config.capacity),
      String(config.refillPerSecond),
      String(Date.now()),
      String(tokens),
    )) as [number, number, number];

    return { allowed: raw[0] === 1, remaining: raw[1], retryAfterMs: raw[2] };
  } catch (error) {
    // Fail open: the provider's own 429 is the backstop, and blocking all work
    // because Redis blinked would be a worse outage than a retry.
    logger().warn({ err: error, key: config.key }, 'Rate limiter unavailable; allowing request');
    return { allowed: true, remaining: 0, retryAfterMs: 0 };
  }
}

/** Waits for a token, up to a bound. Returns false if the wait would exceed it. */
export async function acquireBlocking(
  config: RateLimitConfig,
  options: { tokens?: number; maxWaitMs?: number } = {},
): Promise<boolean> {
  const maxWaitMs = options.maxWaitMs ?? 30_000;
  const deadline = Date.now() + maxWaitMs;

  for (;;) {
    const result = await acquire(config, options.tokens ?? 1);
    if (result.allowed) return true;

    const wait = Math.min(result.retryAfterMs + 25, deadline - Date.now());
    if (wait <= 0) return false;
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

export type BudgetScope = 'job' | 'daily' | 'monthly';

export interface BudgetKeyParts {
  readonly organizationId: string;
  readonly scope: BudgetScope;
  /** Required for job scope. */
  readonly jobId?: string;
  readonly now?: Date;
}

/** Deterministic key, so the daily and monthly counters roll over on their own. */
export function budgetKey(parts: BudgetKeyParts): string {
  const now = parts.now ?? new Date();
  const org = parts.organizationId;

  switch (parts.scope) {
    case 'job':
      return `budget:job:${org}:${parts.jobId ?? 'unknown'}`;
    case 'daily':
      return `budget:daily:${org}:${now.toISOString().slice(0, 10)}`;
    case 'monthly':
      return `budget:monthly:${org}:${now.toISOString().slice(0, 7)}`;
  }
}

const TTL_SECONDS: Record<BudgetScope, number> = {
  job: 7 * 24 * 60 * 60,
  daily: 2 * 24 * 60 * 60,
  monthly: 35 * 24 * 60 * 60,
};

export interface BudgetCheck {
  readonly scope: BudgetScope;
  readonly limitMicros: number;
}

export interface BudgetReservation {
  readonly reservedMicros: number;
  readonly keys: readonly string[];
}

/**
 * Reserves budget across every scope, atomically per scope.
 *
 * On partial failure the already-reserved scopes are released, so a rejected
 * call never leaves phantom spend that would starve later work.
 *
 * @throws AppError BUDGET_EXCEEDED when any scope is exhausted.
 */
export async function reserveBudget(
  parts: Omit<BudgetKeyParts, 'scope'>,
  checks: readonly BudgetCheck[],
  estimatedMicros: number,
  redis: Redis = cacheConnection(),
): Promise<BudgetReservation> {
  const reserved: string[] = [];

  for (const check of checks) {
    const key = budgetKey({ ...parts, scope: check.scope });

    let allowed: boolean;
    let spent = 0;
    try {
      const raw = (await redis.eval(
        BUDGET_RESERVE_LUA,
        1,
        key,
        String(check.limitMicros),
        String(estimatedMicros),
        String(TTL_SECONDS[check.scope]),
      )) as [number, number];
      allowed = raw[0] === 1;
      spent = raw[1];
    } catch (error) {
      // Fail CLOSED. Overspending is irreversible; a paused job is not.
      await releaseBudget(reserved, estimatedMicros, redis);
      logger().error({ err: error }, 'Budget guard unavailable; refusing to spend');
      throw budgetExceeded(check.scope, { reason: 'budget-guard-unavailable' });
    }

    if (!allowed) {
      await releaseBudget(reserved, estimatedMicros, redis);
      throw budgetExceeded(check.scope, {
        limitMicros: check.limitMicros,
        spentMicros: spent,
        estimatedMicros,
      });
    }

    reserved.push(key);
  }

  return { reservedMicros: estimatedMicros, keys: reserved };
}

/** Returns unused reservation, e.g. after a call fails before billing. */
export async function releaseBudget(
  keys: readonly string[],
  micros: number,
  redis: Redis = cacheConnection(),
): Promise<void> {
  if (keys.length === 0 || micros <= 0) return;
  try {
    const pipeline = redis.pipeline();
    for (const key of keys) pipeline.incrby(key, -micros);
    await pipeline.exec();
  } catch (error) {
    // Non-fatal: the counter expires, and over-counting is the safe direction.
    logger().warn({ err: error }, 'Failed to release budget reservation');
  }
}

/**
 * Corrects a reservation to the observed cost.
 *
 * Estimates are approximate by nature — token counts are not known until the
 * response arrives — so reservations are deliberately pessimistic and settled
 * afterwards.
 */
export async function settleBudget(
  reservation: BudgetReservation,
  actualMicros: number,
  redis: Redis = cacheConnection(),
): Promise<void> {
  const delta = actualMicros - reservation.reservedMicros;
  if (delta === 0) return;

  try {
    const pipeline = redis.pipeline();
    for (const key of reservation.keys) pipeline.incrby(key, delta);
    await pipeline.exec();
  } catch (error) {
    logger().warn({ err: error }, 'Failed to settle budget reservation');
  }
}

/** Current spend for a scope, for the dashboard and pre-flight checks. */
export async function currentSpend(
  parts: BudgetKeyParts,
  redis: Redis = cacheConnection(),
): Promise<number> {
  try {
    const value = await redis.get(budgetKey(parts));
    return value ? Number(value) : 0;
  } catch {
    return 0;
  }
}
