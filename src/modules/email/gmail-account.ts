/**
 * Connected-mailbox lifecycle: OAuth state, token storage, and refresh.
 *
 * Two rules govern everything here:
 *
 *   1. A token is never stored in plaintext and never leaves the server. There is
 *      no serializer in this module that can put one in an API response, because
 *      the only functions that read them return a decrypted value directly to the
 *      send path.
 *   2. A refresh that fails permanently INVALIDATES the account rather than
 *      retrying. A revoked grant will not become valid by being asked again, and a
 *      worker that retries it forever looks busy while a campaign silently stalls.
 */
import { createHmac } from 'node:crypto';

import { SECRET_PURPOSE, decryptSecret, encryptSecret, randomToken } from '@/lib/crypto';
import { env } from '@/lib/env';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { db, type TenantContext } from '@/modules/database/client';
import { recordFailure, recordSuccess } from './gmail-health';
import type { EmailSendProvider, OAuthTokens } from '@/modules/providers/contracts';

/** Refresh this far before actual expiry, so a send never races the clock. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;
/** OAuth state is short-lived; a stale callback is a replayed or abandoned one. */
const STATE_TTL_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// OAuth state
// ---------------------------------------------------------------------------

/**
 * State parameter, signed and bound to the initiating organization.
 *
 * This is the CSRF defence for the OAuth flow, and it is not optional: without
 * it an attacker can complete the dance with THEIR authorization code against
 * the victim's session, silently attaching an attacker-controlled mailbox to the
 * victim's organization. Every subsequent campaign would then send from the
 * attacker's mailbox — and the victim would have no reason to look.
 *
 * The state is self-contained (no server-side store) but signed with the
 * application secret, carries the organization it was issued for, and expires.
 */
function stateSecret(): string {
  // Reuses the encryption key material as an HMAC secret via a distinct purpose
  // string, so the signing key is never the same bytes used for encryption.
  return encryptSecret('oauth-state-signing', SECRET_PURPOSE.oauthState).slice(0, 64);
}

let cachedStateSecret: string | undefined;

function signingKey(): string {
  // Memoised: encryptSecret uses a random IV, so recomputing would produce a
  // different key and invalidate every in-flight state.
  cachedStateSecret ??= stateSecret();
  return cachedStateSecret;
}

export function createOAuthState(organizationId: string, userId: string): string {
  const nonce = randomToken(16);
  const issuedAt = Date.now().toString(36);
  const payload = `${organizationId}.${userId}.${issuedAt}.${nonce}`;
  const signature = createHmac('sha256', signingKey()).update(payload).digest('base64url');

  return `${Buffer.from(payload, 'utf8').toString('base64url')}.${signature}`;
}

export interface VerifiedState {
  readonly organizationId: string;
  readonly userId: string;
}

/**
 * Verifies a state parameter, or throws.
 *
 * Checks the signature before anything else, so a forged payload never reaches
 * the parsing logic.
 */
export function verifyOAuthState(state: string, expectedOrganizationId: string): VerifiedState {
  const reject = (reason: string): never => {
    throw new AppError({
      code: 'FORBIDDEN',
      message: `OAuth state rejected: ${reason}`,
      safeMessage: 'That sign-in link is invalid or has expired. Please start again.',
    });
  };

  const parts = state.split('.');
  if (parts.length !== 2) return reject('malformed');

  const [encodedPayload, signature] = parts as [string, string];

  let payload: string;
  try {
    payload = Buffer.from(encodedPayload, 'base64url').toString('utf8');
  } catch {
    return reject('undecodable');
  }

  const expected = createHmac('sha256', signingKey()).update(payload).digest('base64url');
  if (signature.length !== expected.length || signature !== expected)
    return reject('bad signature');

  const fields = payload.split('.');
  if (fields.length !== 4) return reject('malformed payload');

  const [organizationId, userId, issuedAt] = fields as [string, string, string, string];

  const issued = Number.parseInt(issuedAt, 36);
  if (!Number.isFinite(issued) || Date.now() - issued > STATE_TTL_MS) return reject('expired');

  // The decisive check: the callback must land in the same organization that
  // started the flow, so a code obtained elsewhere cannot be redeemed here.
  if (organizationId !== expectedOrganizationId) return reject('organization mismatch');

  return { organizationId, userId };
}

// ---------------------------------------------------------------------------
// Account storage
// ---------------------------------------------------------------------------

export interface ConnectedAccountSummary {
  readonly id: string;
  readonly emailAddress: string;
  readonly displayName: string | null;
  readonly connectedAt: Date;
  readonly lastUsedAt: Date | null;
  readonly invalidatedAt: Date | null;
  readonly invalidatedCode: string | null;
  readonly grantedScopes: readonly string[];
  readonly sentCountToday: number;
  /** True when the grant is usable for sending right now. */
  readonly healthy: boolean;
}

/**
 * The connected mailbox, as the API is allowed to describe it.
 *
 * Note what is absent: every token field. This is the ONLY shape that reaches a
 * route handler, so there is no path by which a token can be serialised into a
 * response even by mistake.
 */
export async function getConnectedAccount(
  tenant: TenantContext,
): Promise<ConnectedAccountSummary | null> {
  const row = await db().gmailAccount.findFirst({
    where: { organizationId: tenant.organizationId },
    orderBy: { connectedAt: 'desc' },
    select: {
      id: true,
      emailAddress: true,
      displayName: true,
      connectedAt: true,
      lastUsedAt: true,
      invalidatedAt: true,
      invalidatedCode: true,
      grantedScopes: true,
      sentCountToday: true,
      sentCountDate: true,
    },
  });

  if (!row) return null;

  return {
    id: row.id,
    emailAddress: row.emailAddress,
    displayName: row.displayName,
    connectedAt: row.connectedAt,
    lastUsedAt: row.lastUsedAt,
    invalidatedAt: row.invalidatedAt,
    invalidatedCode: row.invalidatedCode,
    grantedScopes: row.grantedScopes,
    sentCountToday: isToday(row.sentCountDate) ? row.sentCountToday : 0,
    healthy: row.invalidatedAt === null,
  };
}

function isToday(date: Date | null): boolean {
  if (!date) return false;
  const now = new Date();
  return (
    date.getUTCFullYear() === now.getUTCFullYear() &&
    date.getUTCMonth() === now.getUTCMonth() &&
    date.getUTCDate() === now.getUTCDate()
  );
}

export interface StoreTokensInput {
  readonly emailAddress: string;
  readonly displayName?: string | null;
  readonly tokens: OAuthTokens;
}

/**
 * Stores a new or re-authorised grant.
 *
 * The refresh token is preserved when the provider does not issue a new one.
 * Google omits it on re-consent, and blindly writing null would leave an account
 * that works for one hour and then cannot refresh — a bug that only appears well
 * after the operator has moved on and looks like a mysterious later failure.
 */
export async function storeTokens(
  tenant: TenantContext,
  input: StoreTokensInput,
): Promise<{ id: string }> {
  const existing = await db().gmailAccount.findUnique({
    where: {
      organizationId_emailAddress: {
        organizationId: tenant.organizationId,
        emailAddress: input.emailAddress,
      },
    },
    select: { id: true, refreshTokenCipher: true },
  });

  const refreshCipher = input.tokens.refreshToken
    ? encryptSecret(input.tokens.refreshToken, SECRET_PURPOSE.gmailRefreshToken)
    : existing?.refreshTokenCipher;

  if (!refreshCipher) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'Google did not return a refresh token and none is stored',
      safeMessage:
        'Google did not grant offline access. Disconnect the account in your Google ' +
        'security settings and connect again.',
    });
  }

  const data = {
    displayName: input.displayName ?? null,
    refreshTokenCipher: refreshCipher,
    accessTokenCipher: encryptSecret(input.tokens.accessToken, SECRET_PURPOSE.gmailAccessToken),
    accessTokenExpiry: input.tokens.expiresAt,
    grantedScopes: [...input.tokens.scopes],
    // A successful reconnect clears a prior invalidation, which is the whole
    // point of reconnecting.
    invalidatedAt: null,
    invalidatedCode: null,
  };

  const row = existing
    ? await db().gmailAccount.update({ where: { id: existing.id }, data, select: { id: true } })
    : await db().gmailAccount.create({
        data: {
          ...data,
          organizationId: tenant.organizationId,
          emailAddress: input.emailAddress,
        },
        select: { id: true },
      });

  logger().info(
    { organizationId: tenant.organizationId, accountId: row.id },
    'Gmail account connected',
  );

  return row;
}

/** Marks a grant unusable, so the send path stops rather than retrying. */
export async function invalidateAccount(accountId: string, code: string): Promise<void> {
  await db().gmailAccount.update({
    where: { id: accountId },
    data: { invalidatedAt: new Date(), invalidatedCode: code },
  });

  logger().warn({ accountId, code }, 'Gmail account invalidated; reconnection required');
}

export async function disconnectAccount(
  tenant: TenantContext,
  accountId: string,
): Promise<boolean> {
  const { count } = await db().gmailAccount.deleteMany({
    where: { id: accountId, organizationId: tenant.organizationId },
  });
  return count > 0;
}

// ---------------------------------------------------------------------------
// Access tokens
// ---------------------------------------------------------------------------

/**
 * A usable access token, refreshing when necessary.
 *
 * Refreshes ahead of expiry rather than on failure. Waiting for a 401 would mean
 * every campaign hits one avoidable failed send per hour, and each of those is a
 * retry, a log line, and a status the operator has to interpret.
 */
export async function accessTokenFor(
  accountId: string,
  provider: EmailSendProvider,
): Promise<string> {
  const row = await db().gmailAccount.findUnique({
    where: { id: accountId },
    select: {
      id: true,
      refreshTokenCipher: true,
      accessTokenCipher: true,
      accessTokenExpiry: true,
      invalidatedAt: true,
    },
  });

  if (!row) {
    throw new AppError({ code: 'NOT_FOUND', message: 'Gmail account not found' });
  }

  if (row.invalidatedAt) {
    throw new AppError({
      code: 'UNAUTHENTICATED',
      message: 'Gmail account is invalidated and must be reconnected',
      safeMessage: 'The connected Gmail account needs to be reconnected before sending.',
      retryability: 'never',
    });
  }

  const stillValid =
    row.accessTokenCipher !== null &&
    row.accessTokenExpiry !== null &&
    row.accessTokenExpiry.getTime() - REFRESH_SKEW_MS > Date.now();

  if (stillValid) {
    return decryptSecret(row.accessTokenCipher!, SECRET_PURPOSE.gmailAccessToken);
  }

  const refreshToken = decryptSecret(row.refreshTokenCipher, SECRET_PURPOSE.gmailRefreshToken);
  const refreshed = await provider.refreshAccessToken(refreshToken);

  if (!refreshed.ok) {
    // A permanently failed refresh means the user revoked access or changed
    // their password. Retrying cannot fix either.
    if (refreshed.error.isRetryable === false) {
      await invalidateAccount(row.id, refreshed.error.code);
    }
    // Recorded whether or not the grant was invalidated: a run of transient
    // refresh failures should surface as DEGRADED before it becomes an outage.
    await recordFailure(row.id, refreshed.error.code, refreshed.error.safeMessage ?? null);
    throw refreshed.error;
  }

  await db().gmailAccount.update({
    where: { id: row.id },
    data: {
      accessTokenCipher: encryptSecret(
        refreshed.value.accessToken,
        SECRET_PURPOSE.gmailAccessToken,
      ),
      accessTokenExpiry: refreshed.value.expiresAt,
      // Only overwrite the refresh token if a new one was actually issued.
      ...(refreshed.value.refreshToken && {
        refreshTokenCipher: encryptSecret(
          refreshed.value.refreshToken,
          SECRET_PURPOSE.gmailRefreshToken,
        ),
      }),
    },
  });

  // A successful refresh is the authentication heartbeat, and clears any streak.
  await recordSuccess(row.id, 'auth');

  return refreshed.value.accessToken;
}

/**
 * Records a send against the mailbox's daily counter.
 *
 * Counted per mailbox as well as per campaign, because Gmail's quota is per
 * account: three campaigns each within their own limit can still collectively
 * exceed what Google permits, and hitting Google's ceiling is worse than hitting
 * ours — it can suspend sending entirely.
 */
export async function recordSend(accountId: string): Promise<void> {
  const row = await db().gmailAccount.findUnique({
    where: { id: accountId },
    select: { sentCountDate: true },
  });

  const rollover = !isToday(row?.sentCountDate ?? null);

  await db().gmailAccount.update({
    where: { id: accountId },
    data: {
      lastUsedAt: new Date(),
      sentCountDate: new Date(),
      sentCountToday: rollover ? 1 : { increment: 1 },
    },
  });
}

/** Remaining sends against the organization-wide daily ceiling. */
export async function remainingDailyQuota(accountId: string): Promise<number> {
  const row = await db().gmailAccount.findUnique({
    where: { id: accountId },
    select: { sentCountToday: true, sentCountDate: true },
  });

  if (!row) return 0;
  const used = isToday(row.sentCountDate) ? row.sentCountToday : 0;
  return Math.max(0, env().EMAIL_DAILY_LIMIT - used);
}

/** Test-only: drop the memoised OAuth signing key. */
export function resetStateSecretCache(): void {
  cachedStateSecret = undefined;
}
