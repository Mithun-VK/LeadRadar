/**
 * Authentication service.
 *
 * Two behaviours here are deliberate and worth stating, because both look like
 * bugs to someone expecting a friendlier login:
 *
 *   1. **Sign-in failures are indistinguishable.** Wrong password, unknown email,
 *      no password set, and locked account all return the same message and take
 *      comparable time. Anything else turns the endpoint into an account
 *      enumeration oracle — and for a B2B tool, knowing which agencies use
 *      LeadRadar is itself worth something to a competitor.
 *   2. **Lockout is on the account, not the IP.** IP lockout is trivially bypassed
 *      with a proxy pool and punishes users behind shared NAT. Account lockout
 *      with exponential backoff bounds online guessing directly.
 */
import { createHash } from 'node:crypto';

import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { db } from '@/modules/database/client';
import { recordAudit } from '@/modules/database/repositories';

import { checkPasswordPolicy, hashPassword, verifyPassword } from './password';
import { createSession, revokeAllSessions } from './session';

/** Consecutive failures before the account locks. */
const LOCKOUT_THRESHOLD = 8;
/** Lockout grows with repeated failure, capped so an account is never bricked. */
const LOCKOUT_BASE_MS = 60_000;
const LOCKOUT_MAX_MS = 30 * 60 * 1000;

/** Identical for every failure mode, by design. */
const GENERIC_FAILURE = 'Email or password is incorrect.';

export interface SignInInput {
  readonly email: string;
  readonly password: string;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

export interface SignInResult {
  readonly sessionId: string;
  readonly token: string;
  readonly expiresAt: Date;
  readonly userId: string;
  readonly organizationId: string;
}

function lockoutDuration(failedCount: number): number {
  const overage = Math.max(0, failedCount - LOCKOUT_THRESHOLD + 1);
  return Math.min(LOCKOUT_MAX_MS, LOCKOUT_BASE_MS * 2 ** (overage - 1));
}

function unauthenticated(): AppError {
  return new AppError({
    code: 'UNAUTHENTICATED',
    message: 'Sign-in failed',
    safeMessage: GENERIC_FAILURE,
  });
}

export async function signIn(input: SignInInput): Promise<SignInResult> {
  const email = input.email.trim().toLowerCase();
  const log = logger().child({ component: 'auth' });

  const user = await db().user.findUnique({
    where: { email },
    include: {
      memberships: {
        orderBy: { createdAt: 'asc' },
        take: 1,
        select: { organizationId: true },
      },
    },
  });

  // Still verify against null so an unknown email costs the same work as a known
  // one — the timing side channel is the whole reason this branch exists.
  if (!user) {
    await verifyPassword(input.password, null);
    log.warn({ emailHash: createHash('sha256').update(email).digest('hex').slice(0, 16) }, 'Sign-in attempt for unknown email');
    throw unauthenticated();
  }

  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    await verifyPassword(input.password, null);
    log.warn({ userId: user.id, lockedUntil: user.lockedUntil }, 'Sign-in attempt on locked account');
    throw unauthenticated();
  }

  const { valid, needsRehash } = await verifyPassword(input.password, user.passwordHash);

  if (!valid) {
    const failedCount = user.failedLoginCount + 1;
    const shouldLock = failedCount >= LOCKOUT_THRESHOLD;

    await db().user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: failedCount,
        lockedUntil: shouldLock ? new Date(Date.now() + lockoutDuration(failedCount)) : null,
      },
    });

    if (shouldLock) {
      log.warn({ userId: user.id, failedCount }, 'Account locked after repeated failures');
    }
    throw unauthenticated();
  }

  // A user with no membership has nothing to act on; treated as a failed sign-in
  // rather than a confusing empty dashboard.
  const organizationId = user.memberships[0]?.organizationId;
  if (!organizationId) {
    log.error({ userId: user.id }, 'Authenticated user has no organization membership');
    throw unauthenticated();
  }

  await db().user.update({
    where: { id: user.id },
    data: {
      failedLoginCount: 0,
      lockedUntil: null,
      lastLoginAt: new Date(),
      // Transparently upgrade a hash created under weaker parameters.
      ...(needsRehash && { passwordHash: await hashPassword(input.password) }),
    },
  });

  const session = await createSession({
    userId: user.id,
    organizationId,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
  });

  await recordAudit(
    { organizationId, userId: user.id },
    { action: 'auth.signed_in', resourceType: 'Session', metadata: { rehashed: needsRehash } },
  );

  return {
    sessionId: session.sessionId,
    token: session.token,
    expiresAt: session.expiresAt,
    userId: user.id,
    organizationId,
  };
}

export interface ChangePasswordInput {
  readonly userId: string;
  readonly organizationId: string;
  readonly currentPassword: string;
  readonly newPassword: string;
}

/**
 * Changes a password and revokes every other session.
 *
 * Revocation is the point: a password change is usually a response to suspected
 * compromise, and leaving other sessions alive would defeat it.
 */
export async function changePassword(input: ChangePasswordInput): Promise<{ revoked: number }> {
  const user = await db().user.findUnique({
    where: { id: input.userId },
    select: { id: true, email: true, passwordHash: true },
  });
  if (!user) throw unauthenticated();

  const { valid } = await verifyPassword(input.currentPassword, user.passwordHash);
  if (!valid) {
    throw new AppError({
      code: 'UNAUTHENTICATED',
      message: 'Current password incorrect',
      safeMessage: 'Your current password is incorrect.',
    });
  }

  const policy = checkPasswordPolicy(input.newPassword, user.email);
  if (!policy.ok) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: `Password policy: ${policy.problems.join(' ')}`,
      safeMessage: policy.problems.join(' '),
    });
  }

  await db().user.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(input.newPassword) },
  });

  const revoked = await revokeAllSessions(user.id);

  await recordAudit(
    { organizationId: input.organizationId, userId: user.id },
    { action: 'auth.password_changed', resourceType: 'User', resourceId: user.id, metadata: { revokedSessions: revoked } },
  );

  return { revoked };
}

export interface ProvisionUserInput {
  readonly email: string;
  readonly password: string;
  readonly name?: string;
  readonly organizationId: string;
  readonly role?: 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';
}

/**
 * Creates a user and their membership.
 *
 * Not exposed as a public sign-up route: LeadRadar is a B2B tool where accounts
 * belong to an organization, and open registration would let anyone create a
 * tenant and start spending against shared provider quotas. Invitation and
 * self-service sign-up are V2 concerns with their own abuse controls.
 */
export async function provisionUser(input: ProvisionUserInput): Promise<{ userId: string }> {
  const email = input.email.trim().toLowerCase();

  const policy = checkPasswordPolicy(input.password, email);
  if (!policy.ok) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: `Password policy: ${policy.problems.join(' ')}`,
      safeMessage: policy.problems.join(' '),
    });
  }

  const organization = await db().organization.findUnique({
    where: { id: input.organizationId },
    select: { id: true },
  });
  if (!organization) {
    throw new AppError({
      code: 'NOT_FOUND',
      message: `Organization ${input.organizationId} not found`,
      safeMessage: 'That organization does not exist.',
    });
  }

  const passwordHash = await hashPassword(input.password);

  const user = await db().user.upsert({
    where: { email },
    update: { passwordHash, ...(input.name !== undefined && { name: input.name }) },
    create: { email, passwordHash, name: input.name ?? null },
    select: { id: true },
  });

  await db().membership.upsert({
    where: { organizationId_userId: { organizationId: organization.id, userId: user.id } },
    update: { role: input.role ?? 'MEMBER' },
    create: { organizationId: organization.id, userId: user.id, role: input.role ?? 'MEMBER' },
  });

  return { userId: user.id };
}
