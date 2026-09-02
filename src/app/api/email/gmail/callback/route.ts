/**
 * GET /api/email/gmail/callback — completes the OAuth flow.
 *
 * Google sends the operator here with an authorization code. Before the code is
 * redeemed, the state parameter is verified against the CURRENT session's
 * organization — that check is the whole reason the flow is safe, and it happens
 * before any token exchange.
 *
 * The response is a redirect back into the dashboard rather than JSON, because a
 * human's browser lands here, not a program.
 */
import { NextResponse } from 'next/server';

import { AppError, isAppError, toAppError } from '@/lib/errors';
import { requestId as newRequestId } from '@/lib/ids';
import { requestLogger } from '@/lib/logger';
import { requireSession } from '@/modules/auth/session';
import { recordAudit } from '@/modules/database/repositories';
import { storeTokens, verifyOAuthState } from '@/modules/email/gmail-account';
import { providers } from '@/modules/providers/registry';

function backToSettings(request: Request, params: Record<string, string>): NextResponse {
  const url = new URL('/dashboard/email', request.url);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return NextResponse.redirect(url, { status: 302 });
}

export async function GET(request: Request): Promise<NextResponse> {
  const requestId = request.headers.get('x-request-id') ?? newRequestId();
  const log = requestLogger(requestId, { path: '/api/email/gmail/callback' });

  try {
    const session = await requireSession();
    const url = new URL(request.url);

    // Google reports a declined consent screen this way. Not an error worth a
    // stack trace — the operator simply changed their mind.
    const oauthError = url.searchParams.get('error');
    if (oauthError) {
      log.info({ oauthError }, 'Operator declined the Gmail consent screen');
      return backToSettings(request, { gmail: 'declined' });
    }

    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');

    if (!code || !state) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        message: 'OAuth callback is missing the code or state parameter',
        safeMessage: 'That link is incomplete. Please start the connection again.',
      });
    }

    // The load-bearing check. Verified against the session's organization, so a
    // code obtained elsewhere cannot be redeemed into this account.
    verifyOAuthState(state, session.organizationId);

    const registry = providers();
    if (!registry.email) {
      throw new AppError({
        code: 'CONFIG_INVALID',
        message: 'Email sending is not enabled on this server',
        safeMessage: 'Outbound email is disabled on this server.',
      });
    }

    const tokens = await registry.email.exchangeCode(code);
    if (!tokens.ok) throw tokens.error;

    /**
     * A consent screen where the user unticked the send permission returns
     * successfully but with a scope we cannot use. Catching it here means the
     * operator is told immediately, rather than discovering it when a campaign
     * silently fails to send.
     */
    const hasSendScope = tokens.value.scopes.some((scope) => scope.endsWith('/gmail.send'));
    if (!hasSendScope) {
      log.warn({ scopes: tokens.value.scopes }, 'Gmail grant lacks the send scope');
      return backToSettings(request, { gmail: 'missing_scope' });
    }

    const profile = await registry.email.getProfile(tokens.value.accessToken);
    if (!profile.ok) throw profile.error;

    const tenant = { organizationId: session.organizationId, userId: session.userId };

    const account = await storeTokens(tenant, {
      emailAddress: profile.value.emailAddress,
      displayName: session.name,
      tokens: tokens.value,
    });

    await recordAudit(tenant, {
      action: 'gmail.connected',
      resourceType: 'GmailAccount',
      resourceId: account.id,
      // The address is recorded; no token ever is.
      metadata: { emailAddress: profile.value.emailAddress },
    });

    log.info(
      { organizationId: session.organizationId, accountId: account.id },
      'Gmail account connected',
    );

    return backToSettings(request, { gmail: 'connected' });
  } catch (error) {
    const appError = isAppError(error)
      ? error
      : toAppError(error, { code: 'INTERNAL', message: 'Gmail callback failed' });

    log.warn(appError.toLogObject(), 'Gmail callback failed');

    return backToSettings(request, { gmail: 'error', reason: appError.code });
  }
}
