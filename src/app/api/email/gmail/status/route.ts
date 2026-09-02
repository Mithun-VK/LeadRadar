/**
 * GET /api/email/gmail/status — is a mailbox connected, and is it usable?
 *
 * Returns the account summary shape, which contains no token fields at all.
 * That is enforced by the type rather than by remembering to omit them here.
 */
import { handler } from '@/modules/api/handler';
import { env } from '@/lib/env';
import { getConnectedAccount } from '@/modules/email/gmail-account';
import { providers } from '@/modules/providers/registry';

export const GET = handler(async ({ tenant }) => {
  const config = env();
  const account = await getConnectedAccount(tenant);
  const registry = providers();

  return {
    /** Whether this deployment can send at all, before any account is considered. */
    sendingEnabled: config.EMAIL_SENDING_ENABLED || registry.mode === 'mock',
    /** True when messages go to an in-process fake and reach nobody. */
    mocked: registry.email?.isMock ?? false,
    configured:
      Boolean(
        config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET && config.GOOGLE_REDIRECT_URI,
      ) || registry.mode === 'mock',
    dailyLimit: config.EMAIL_DAILY_LIMIT,
    minDelaySeconds: config.EMAIL_MIN_DELAY_SECONDS,
    account: account
      ? {
          id: account.id,
          emailAddress: account.emailAddress,
          displayName: account.displayName,
          connectedAt: account.connectedAt,
          lastUsedAt: account.lastUsedAt,
          healthy: account.healthy,
          invalidatedAt: account.invalidatedAt,
          invalidatedCode: account.invalidatedCode,
          grantedScopes: account.grantedScopes,
          sentCountToday: account.sentCountToday,
          remainingToday: Math.max(0, config.EMAIL_DAILY_LIMIT - account.sentCountToday),
        }
      : null,
  };
});
