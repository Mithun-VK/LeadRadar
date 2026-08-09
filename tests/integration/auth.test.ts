/**
 * Authentication integration tests.
 *
 * These need a real database because the properties under test are all about
 * persisted state: revocation, expiry, membership re-checks, and lockout counters.
 * An in-memory fake would pass while the real thing silently failed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isAppError } from '@/lib/errors';
import { closeDatabase, db } from '@/modules/database/client';
import { hashPassword } from '@/modules/auth/password';
import { changePassword, provisionUser, signIn } from '@/modules/auth/service';
import {
  createSession,
  purgeExpiredSessions,
  revokeAllSessions,
  revokeSession,
  validateSessionToken,
} from '@/modules/auth/session';

const ORG = 'test_org_auth';
const OTHER_ORG = 'test_org_auth_other';
const EMAIL = 'auth-test@leadradar.local';
const PASSWORD = 'integration test passphrase';

let userId: string;

beforeAll(async () => {
  for (const id of [ORG, OTHER_ORG]) {
    await db().organization.upsert({
      where: { id },
      update: {},
      create: { id, name: id, slug: id.replace(/_/g, '-') },
    });
  }

  const provisioned = await provisionUser({
    email: EMAIL,
    password: PASSWORD,
    name: 'Auth Test',
    organizationId: ORG,
    role: 'OWNER',
  });
  userId = provisioned.userId;
}, 60_000);

afterAll(async () => {
  await db().user.deleteMany({ where: { email: EMAIL } });
  await db().organization.deleteMany({ where: { id: { in: [ORG, OTHER_ORG] } } });
  await closeDatabase();
});

describe('signIn', () => {
  it('issues a session for correct credentials', { timeout: 30_000 }, async () => {
    const result = await signIn({ email: EMAIL, password: PASSWORD });
    expect(result.userId).toBe(userId);
    expect(result.organizationId).toBe(ORG);
    expect(result.token.length).toBeGreaterThan(32);

    const session = await validateSessionToken(result.token);
    expect(session?.userId).toBe(userId);
    expect(session?.role).toBe('OWNER');
  });

  it('is case-insensitive on email', { timeout: 30_000 }, async () => {
    const result = await signIn({ email: EMAIL.toUpperCase(), password: PASSWORD });
    expect(result.userId).toBe(userId);
  });

  /**
   * The enumeration defence, at the service level: an unknown email and a wrong
   * password must be indistinguishable to the caller.
   */
  it('returns the same error for unknown email and wrong password', { timeout: 30_000 }, async () => {
    let unknownMessage = '';
    let wrongMessage = '';

    try {
      await signIn({ email: 'nobody@leadradar.local', password: PASSWORD });
    } catch (error) {
      if (isAppError(error)) unknownMessage = error.safeMessage;
    }
    try {
      await signIn({ email: EMAIL, password: 'definitely the wrong password' });
    } catch (error) {
      if (isAppError(error)) wrongMessage = error.safeMessage;
    }

    expect(unknownMessage).not.toBe('');
    expect(unknownMessage).toBe(wrongMessage);
  });

  it('records the failure count and clears it on success', { timeout: 60_000 }, async () => {
    await db().user.update({ where: { id: userId }, data: { failedLoginCount: 0, lockedUntil: null } });

    await signIn({ email: EMAIL, password: 'wrong one' }).catch(() => undefined);
    let user = await db().user.findUnique({ where: { id: userId }, select: { failedLoginCount: true } });
    expect(user?.failedLoginCount).toBe(1);

    await signIn({ email: EMAIL, password: PASSWORD });
    user = await db().user.findUnique({ where: { id: userId }, select: { failedLoginCount: true } });
    expect(user?.failedLoginCount).toBe(0);
  });

  it('locks the account after repeated failures', { timeout: 120_000 }, async () => {
    await db().user.update({
      where: { id: userId },
      data: { failedLoginCount: 7, lockedUntil: null },
    });

    // The eighth consecutive failure trips the lock.
    await signIn({ email: EMAIL, password: 'wrong again' }).catch(() => undefined);

    const user = await db().user.findUnique({
      where: { id: userId },
      select: { lockedUntil: true },
    });
    expect(user?.lockedUntil).not.toBeNull();
    expect(user!.lockedUntil!.getTime()).toBeGreaterThan(Date.now());

    // A locked account rejects even the CORRECT password — otherwise the lock
    // would only inconvenience the attacker, not stop them.
    await expect(signIn({ email: EMAIL, password: PASSWORD })).rejects.toThrow();

    await db().user.update({
      where: { id: userId },
      data: { failedLoginCount: 0, lockedUntil: null },
    });
  });

  it('refuses a user with no membership', { timeout: 30_000 }, async () => {
    const orphan = await db().user.create({
      data: { email: 'orphan@leadradar.local', passwordHash: await hashPassword(PASSWORD) },
      select: { id: true },
    });

    await expect(signIn({ email: 'orphan@leadradar.local', password: PASSWORD })).rejects.toThrow();
    await db().user.delete({ where: { id: orphan.id } });
  });

  it('refuses a user with no password set', { timeout: 30_000 }, async () => {
    const invited = await db().user.create({
      data: { email: 'invited@leadradar.local', passwordHash: null },
      select: { id: true },
    });
    await db().membership.create({ data: { organizationId: ORG, userId: invited.id, role: 'MEMBER' } });

    await expect(signIn({ email: 'invited@leadradar.local', password: PASSWORD })).rejects.toThrow();
    await db().user.delete({ where: { id: invited.id } });
  });
});

describe('session lifecycle', () => {
  it('stores the token hashed, never in plaintext', async () => {
    const { token } = await createSession({ userId, organizationId: ORG });

    const rows = await db().session.findMany({
      where: { userId },
      select: { tokenHash: true },
    });

    // The decisive assertion: a database dump must not contain a usable token.
    expect(rows.some((row) => row.tokenHash === token)).toBe(false);
    expect(rows.every((row) => /^[0-9a-f]{64}$/.test(row.tokenHash))).toBe(true);
  });

  it('rejects a revoked session immediately', async () => {
    const { sessionId, token } = await createSession({ userId, organizationId: ORG });
    expect(await validateSessionToken(token)).not.toBeNull();

    await revokeSession(sessionId);
    expect(await validateSessionToken(token)).toBeNull();
  });

  it('rejects an expired session', async () => {
    const { sessionId, token } = await createSession({ userId, organizationId: ORG });
    await db().session.update({
      where: { id: sessionId },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    expect(await validateSessionToken(token)).toBeNull();
  });

  it('rejects and revokes an idle session', async () => {
    const { sessionId, token } = await createSession({ userId, organizationId: ORG });
    await db().session.update({
      where: { id: sessionId },
      data: { lastSeenAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
    });

    expect(await validateSessionToken(token)).toBeNull();

    // Revoked rather than merely rejected, so it stops occupying the table.
    const row = await db().session.findUnique({ where: { id: sessionId }, select: { revokedAt: true } });
    expect(row?.revokedAt).not.toBeNull();
  });

  it('rejects a garbage or absent token', async () => {
    expect(await validateSessionToken(undefined)).toBeNull();
    expect(await validateSessionToken('')).toBeNull();
    expect(await validateSessionToken('a'.repeat(43))).toBeNull();
    expect(await validateSessionToken('x'.repeat(500))).toBeNull();
  });

  /**
   * Removing someone from an organization must end their access on the next
   * request, not whenever their session happens to expire.
   */
  it('rejects a session whose membership was revoked', async () => {
    const temp = await provisionUser({
      email: 'revokable@leadradar.local',
      password: PASSWORD,
      organizationId: OTHER_ORG,
      role: 'MEMBER',
    });
    const { token } = await createSession({ userId: temp.userId, organizationId: OTHER_ORG });
    expect(await validateSessionToken(token)).not.toBeNull();

    await db().membership.deleteMany({
      where: { organizationId: OTHER_ORG, userId: temp.userId },
    });

    expect(await validateSessionToken(token)).toBeNull();
    await db().user.delete({ where: { id: temp.userId } });
  }, 60_000);

  it('revokes every session for a user at once', async () => {
    await revokeAllSessions(userId);
    const a = await createSession({ userId, organizationId: ORG });
    const b = await createSession({ userId, organizationId: ORG });

    const revoked = await revokeAllSessions(userId);
    expect(revoked).toBeGreaterThanOrEqual(2);
    expect(await validateSessionToken(a.token)).toBeNull();
    expect(await validateSessionToken(b.token)).toBeNull();
  });

  it('purges rows that can never authenticate again', async () => {
    const { sessionId } = await createSession({ userId, organizationId: ORG });
    await db().session.update({
      where: { id: sessionId },
      data: { expiresAt: new Date(Date.now() - 86_400_000) },
    });

    const purged = await purgeExpiredSessions();
    expect(purged).toBeGreaterThan(0);
    expect(await db().session.findUnique({ where: { id: sessionId } })).toBeNull();
  });

  it('does not leak the organization from another tenant\'s session', async () => {
    const { token } = await createSession({ userId, organizationId: ORG });
    const session = await validateSessionToken(token);
    // The organization comes from the session row, so it cannot be influenced by
    // anything the client sends.
    expect(session?.organizationId).toBe(ORG);
    expect(session?.organizationId).not.toBe(OTHER_ORG);
  });
});

describe('changePassword', () => {
  it('revokes all other sessions', { timeout: 60_000 }, async () => {
    const first = await createSession({ userId, organizationId: ORG });
    const second = await createSession({ userId, organizationId: ORG });

    const newPassword = 'a different long passphrase';
    const result = await changePassword({
      userId,
      organizationId: ORG,
      currentPassword: PASSWORD,
      newPassword,
    });

    expect(result.revoked).toBeGreaterThanOrEqual(2);
    // A password change is usually a response to compromise; leaving old sessions
    // alive would defeat it.
    expect(await validateSessionToken(first.token)).toBeNull();
    expect(await validateSessionToken(second.token)).toBeNull();

    // Restore for any later test ordering.
    await changePassword({
      userId,
      organizationId: ORG,
      currentPassword: newPassword,
      newPassword: PASSWORD,
    });
  });

  it('rejects a wrong current password', { timeout: 30_000 }, async () => {
    await expect(
      changePassword({
        userId,
        organizationId: ORG,
        currentPassword: 'not the current password',
        newPassword: 'some other long passphrase',
      }),
    ).rejects.toThrow();
  });

  it('enforces the password policy on the new password', { timeout: 30_000 }, async () => {
    await expect(
      changePassword({
        userId,
        organizationId: ORG,
        currentPassword: PASSWORD,
        newPassword: 'short',
      }),
    ).rejects.toThrow();
  });
});
