/**
 * GET /api/email/gmail/connect — begins the OAuth flow.
 *
 * Redirects the operator to Google with a signed state parameter bound to their
 * organization. The state is what prevents an attacker from completing the flow
 * with their own authorization code against someone else's session, which would
 * silently attach an attacker-controlled mailbox to the victim's account — and
 * every campaign afterwards would send from it.
 *
 * This is a GET that causes a redirect rather than a state change, so it is safe
 * to reach by navigation; the actual grant happens at the callback.
 */
import { NextResponse } from 'next/server';

import { AppError, isAppError, toAppError } from '@/lib/errors';
import { requestId as newRequestId } from '@/lib/ids';
import { requestLogger } from '@/lib/logger';
import { requireSession } from '@/modules/auth/session';
import { createOAuthState } from '@/modules/email/gmail-account';
import { providers } from '@/modules/providers/registry';

export async function GET(request: Request): Promise<NextResponse> {
  const requestId = request.headers.get('x-request-id') ?? newRequestId();
  const log = requestLogger(requestId, { path: '/api/email/gmail/connect' });

  try {
    const session = await requireSession();

    // Connecting a mailbox is an organization-wide act — every campaign will
    // send from it — so it is restricted to those who administer the account.
    if (session.role !== 'OWNER' && session.role !== 'ADMIN') {
      throw new AppError({
        code: 'FORBIDDEN',
        message: 'Only an owner or admin may connect a sending mailbox',
        safeMessage: 'You need admin access to connect a Gmail account.',
      });
    }

    const registry = providers();
    if (!registry.email) {
      throw new AppError({
        code: 'CONFIG_INVALID',
        message: 'Email sending is not enabled on this server',
        safeMessage:
          'Outbound email is disabled. Set EMAIL_SENDING_ENABLED=true and configure the Google OAuth client.',
      });
    }

    const state = createOAuthState(session.organizationId, session.userId);
    const url = registry.email.authorizationUrl(state);

    log.info({ organizationId: session.organizationId }, 'Starting Gmail OAuth flow');

    return NextResponse.redirect(new URL(url, request.url), { status: 302 });
  } catch (error) {
    const appError = isAppError(error)
      ? error
      : toAppError(error, { code: 'INTERNAL', message: 'Gmail connect failed' });

    log.warn(appError.toLogObject(), 'Gmail connect rejected');

    return NextResponse.json(
      { ...appError.toPublicJSON(), requestId },
      {
        status:
          appError.code === 'UNAUTHENTICATED' ? 401 : appError.code === 'FORBIDDEN' ? 403 : 400,
      },
    );
  }
}
