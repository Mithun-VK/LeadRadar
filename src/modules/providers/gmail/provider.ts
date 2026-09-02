/**
 * Gmail adapter — OAuth 2.0 and message sending.
 *
 * Username/password SMTP is deliberately not supported. Google has disabled it
 * for most accounts, it requires the operator to hand a mailbox password to this
 * application, and it cannot be revoked without changing that password. OAuth
 * gives a scoped, individually revocable grant, and the scope requested here
 * (`gmail.send`) cannot read the user's mail at all.
 *
 * Every method returns a Result rather than throwing, matching the other
 * providers: a rejected send is an operating condition to record against the
 * message, not an exception that should fail a worker.
 */
import { AppError } from '@/lib/errors';
import { env } from '@/lib/env';
import { providerLogger } from '@/lib/logger';
import { err, ok, type Result } from '@/lib/result';
import { parseJson, parseRetryAfter, requestWithRetry } from '@/modules/providers/http';
import { toGmailRaw } from '@/modules/email/mime';

import {
  REQUESTED_SCOPES,
  gmailMessageListSchema,
  gmailMessageSchema,
  gmailProfileSchema,
  gmailSendResponseSchema,
  tokenResponseSchema,
  type GmailMessage,
} from './schemas';
import type {
  EmailSendProvider,
  FetchInboxRequest,
  InboundMessage,
  OAuthTokens,
  SendMessageRequest,
  SendMessageResult,
} from '../contracts';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

const MAX_RESPONSE_BYTES = 512 * 1024;

export interface GmailCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
}

/**
 * Errors that mean the grant is dead rather than temporarily unavailable.
 *
 * The distinction matters operationally: a dead grant must stop sending and ask
 * the operator to reconnect, while a transient failure should retry. Retrying a
 * revoked token forever would silently stall a campaign while looking busy.
 */
const PERMANENT_OAUTH_ERRORS = new Set(['invalid_grant', 'unauthorized_client', 'invalid_client']);

export function isPermanentAuthFailure(code: string): boolean {
  return PERMANENT_OAUTH_ERRORS.has(code);
}

export class GmailProvider implements EmailSendProvider {
  readonly name = 'gmail';
  readonly isMock = false;

  constructor(private readonly credentials: GmailCredentials) {}

  /**
   * The URL the operator is sent to in order to grant access.
   *
   * `access_type=offline` with `prompt=consent` is what causes Google to return a
   * refresh token. Without both, a reconnect yields only a short-lived access
   * token and background sending stops working an hour later — a failure that
   * looks like a bug in the worker rather than a missing OAuth parameter.
   */
  authorizationUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.credentials.clientId,
      redirect_uri: this.credentials.redirectUri,
      response_type: 'code',
      scope: REQUESTED_SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
    });

    return `${AUTH_ENDPOINT}?${params.toString()}`;
  }

  async exchangeCode(code: string): Promise<Result<OAuthTokens>> {
    return this.tokenRequest({
      code,
      client_id: this.credentials.clientId,
      client_secret: this.credentials.clientSecret,
      redirect_uri: this.credentials.redirectUri,
      grant_type: 'authorization_code',
    });
  }

  async refreshAccessToken(refreshToken: string): Promise<Result<OAuthTokens>> {
    return this.tokenRequest({
      refresh_token: refreshToken,
      client_id: this.credentials.clientId,
      client_secret: this.credentials.clientSecret,
      grant_type: 'refresh_token',
    });
  }

  private async tokenRequest(form: Record<string, string>): Promise<Result<OAuthTokens>> {
    const response = await requestWithRetry({
      url: TOKEN_ENDPOINT,
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      rawBody: new URLSearchParams(form).toString(),
      provider: this.name,
      operation: 'token',
      timeoutMs: 20_000,
      maxBytes: MAX_RESPONSE_BYTES,
    });

    if (!response.ok) return err(response.error);

    const json = parseJson(response.value.text, { provider: this.name, operation: 'token' });
    if (!json.ok) return err(json.error);

    if (response.value.status !== 200) {
      const body = json.value as { error?: string; error_description?: string };
      const code = typeof body.error === 'string' ? body.error : 'oauth_error';

      return err(
        new AppError({
          code: isPermanentAuthFailure(code) ? 'CONFIG_INVALID' : 'PROVIDER_UNAVAILABLE',
          message: `Google token endpoint rejected the request: ${code}`,
          safeMessage: isPermanentAuthFailure(code)
            ? 'The Gmail connection is no longer valid. Please reconnect the account.'
            : 'Could not reach Google. Please try again.',
          // A revoked grant will never succeed on retry, however many times we ask.
          retryability: isPermanentAuthFailure(code) ? 'never' : 'transient',
          context: { provider: this.name, oauthError: code },
        }),
      );
    }

    const parsed = tokenResponseSchema.safeParse(json.value);
    if (!parsed.success) {
      return err(
        new AppError({
          code: 'PROVIDER_BAD_RESPONSE',
          message: `Google token response had an unexpected shape: ${parsed.error.message}`,
        }),
      );
    }

    const data = parsed.data;
    return ok({
      accessToken: data.access_token,
      // Absent on re-consent; the caller keeps the token it already has.
      refreshToken: data.refresh_token ?? null,
      expiresAt: new Date(Date.now() + (data.expires_in ?? 3_600) * 1_000),
      scopes: data.scope ? data.scope.split(' ') : [...REQUESTED_SCOPES],
    });
  }

  /** Confirms which mailbox the grant actually belongs to. */
  async getProfile(accessToken: string): Promise<Result<{ emailAddress: string }>> {
    const response = await requestWithRetry({
      url: `${GMAIL_API}/profile`,
      method: 'GET',
      headers: { authorization: `Bearer ${accessToken}` },
      provider: this.name,
      operation: 'profile',
      timeoutMs: 15_000,
      maxBytes: MAX_RESPONSE_BYTES,
    });

    if (!response.ok) return err(response.error);
    if (response.value.status !== 200) {
      return err(
        this.mapApiError(
          response.value.status,
          response.value.text,
          response.value.headers,
          'profile',
        ),
      );
    }

    const json = parseJson(response.value.text, { provider: this.name, operation: 'profile' });
    if (!json.ok) return err(json.error);

    const parsed = gmailProfileSchema.safeParse(json.value);
    if (!parsed.success) {
      return err(
        new AppError({
          code: 'PROVIDER_BAD_RESPONSE',
          message: 'Gmail profile response had an unexpected shape',
        }),
      );
    }

    return ok({ emailAddress: parsed.data.emailAddress });
  }

  async send(request: SendMessageRequest): Promise<Result<SendMessageResult>> {
    const log = providerLogger(this.name, 'send');

    const response = await requestWithRetry({
      url: `${GMAIL_API}/messages/send`,
      method: 'POST',
      headers: { authorization: `Bearer ${request.accessToken}` },
      body: { raw: toGmailRaw(request.mime) },
      provider: this.name,
      operation: 'send',
      timeoutMs: 30_000,
      maxBytes: MAX_RESPONSE_BYTES,
    });

    if (!response.ok) return err(response.error);

    if (response.value.status !== 200) {
      const error = this.mapApiError(
        response.value.status,
        response.value.text,
        response.value.headers,
        'send',
      );
      log.warn({ status: response.value.status, code: error.code }, 'Gmail rejected a message');
      return err(error);
    }

    const json = parseJson(response.value.text, { provider: this.name, operation: 'send' });
    if (!json.ok) return err(json.error);

    const parsed = gmailSendResponseSchema.safeParse(json.value);
    if (!parsed.success) {
      // The message may well have been sent despite an unreadable response, so
      // this is reported as a bad response rather than a failure — the caller
      // must not retry blindly and risk a duplicate.
      return err(
        new AppError({
          code: 'PROVIDER_BAD_RESPONSE',
          message:
            'Gmail send returned an unexpected shape; the message may or may not have been sent',
          retryability: 'never',
        }),
      );
    }

    return ok({
      providerMessageId: parsed.data.id,
      providerThreadId: parsed.data.threadId ?? null,
    });
  }

  /**
   * Reads recent messages.
   *
   * Two properties worth stating:
   *
   *   - The Gmail query is narrowed server-side (`-in:chats`, `newer_than`) so
   *     the volume fetched is bounded regardless of mailbox size. A sync that
   *     paged an entire mailbox would be slow, expensive in quota, and would read
   *     far more than it needs.
   *   - Bodies are truncated hard. Reply classification needs the first few
   *     hundred words; a 4 MB forwarded thread adds nothing but memory pressure
   *     and retention liability.
   */
  async fetchInbox(request: FetchInboxRequest): Promise<Result<readonly InboundMessage[]>> {
    const log = providerLogger(this.name, 'inbox');
    const max = Math.min(request.maxMessages ?? 100, 200);

    // Gmail's `newer_than` takes whole days; a floor of 1 keeps a frequent sync
    // legal while the `since` filter below does the precise cut.
    const days = Math.max(
      1,
      Math.ceil((Date.now() - request.since.getTime()) / (24 * 60 * 60 * 1000)),
    );

    const query = `newer_than:${days}d -in:chats`;

    const listed = await requestWithRetry({
      url: `${GMAIL_API}/messages?q=${encodeURIComponent(query)}&maxResults=${max}`,
      method: 'GET',
      headers: { authorization: `Bearer ${request.accessToken}` },
      provider: this.name,
      operation: 'messages.list',
      timeoutMs: 20_000,
      maxBytes: MAX_RESPONSE_BYTES,
    });

    if (!listed.ok) return err(listed.error);
    if (listed.value.status !== 200) {
      return err(
        this.mapApiError(listed.value.status, listed.value.text, listed.value.headers, 'messages.list'),
      );
    }

    const listJson = parseJson(listed.value.text, { provider: this.name, operation: 'messages.list' });
    if (!listJson.ok) return err(listJson.error);

    const list = gmailMessageListSchema.safeParse(listJson.value);
    if (!list.success) {
      return err(
        new AppError({
          code: 'PROVIDER_BAD_RESPONSE',
          message: 'Gmail message list had an unexpected shape',
        }),
      );
    }

    const ids = (list.data.messages ?? []).slice(0, max);
    const messages: InboundMessage[] = [];

    for (const { id } of ids) {
      const fetched = await requestWithRetry({
        url: `${GMAIL_API}/messages/${encodeURIComponent(id)}?format=full`,
        method: 'GET',
        headers: { authorization: `Bearer ${request.accessToken}` },
        provider: this.name,
        operation: 'messages.get',
        timeoutMs: 20_000,
        maxBytes: MAX_RESPONSE_BYTES,
      });

      // One unreadable message must not fail the whole sync — a deleted or
      // permission-restricted message is an ordinary condition.
      if (!fetched.ok || fetched.value.status !== 200) continue;

      const json = parseJson(fetched.value.text, { provider: this.name, operation: 'messages.get' });
      if (!json.ok) continue;

      const parsed = gmailMessageSchema.safeParse(json.value);
      if (!parsed.success) continue;

      const normalised = normaliseGmailMessage(parsed.data);
      if (normalised && normalised.receivedAt >= request.since) messages.push(normalised);
    }

    log.info({ listed: ids.length, kept: messages.length }, 'Inbox page fetched');
    return ok(messages);
  }

  private mapApiError(status: number, text: string, headers: Headers, operation: string): AppError {
    // 401 means the access token expired or the grant was revoked; the caller
    // refreshes once and, if that also fails, marks the account invalidated.
    if (status === 401) {
      return new AppError({
        code: 'UNAUTHENTICATED',
        message: `Gmail ${operation} was rejected as unauthenticated`,
        safeMessage: 'The Gmail connection needs to be re-authorised.',
        retryability: 'never',
        context: { provider: this.name, operation, httpStatus: status },
      });
    }

    // 403 with a rate-limit reason and 429 are both quota conditions. Gmail's
    // per-user send quota is the one this product realistically hits.
    if (status === 429 || (status === 403 && /rateLimitExceeded|quotaExceeded/i.test(text))) {
      return new AppError({
        code: 'PROVIDER_RATE_LIMITED',
        message: `Gmail ${operation} hit a rate or quota limit`,
        safeMessage: 'Gmail is rate limiting sends. Remaining messages will be retried later.',
        retryAfterSeconds: parseRetryAfter(headers) ?? 3_600,
        context: { provider: this.name, operation, httpStatus: status },
      });
    }

    if (status === 403) {
      return new AppError({
        code: 'FORBIDDEN',
        message: `Gmail ${operation} was refused; the granted scopes may be insufficient`,
        safeMessage:
          'Gmail refused the request. Reconnect the account and grant sending permission.',
        retryability: 'never',
        context: { provider: this.name, operation, httpStatus: status },
      });
    }

    return new AppError({
      code: status >= 500 ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_BAD_RESPONSE',
      message: `Gmail ${operation} failed with HTTP ${status}`,
      retryAfterSeconds: parseRetryAfter(headers),
      context: {
        provider: this.name,
        operation,
        httpStatus: status,
        bodySnippet: text.slice(0, 200),
      },
    });
  }
}

/** Reads OAuth credentials, failing with an actionable message when absent. */
export function gmailCredentials(): GmailCredentials {
  const config = env();

  if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET || !config.GOOGLE_REDIRECT_URI) {
    throw new AppError({
      code: 'CONFIG_INVALID',
      message:
        'Gmail is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and ' +
        'GOOGLE_REDIRECT_URI to connect a mailbox.',
      safeMessage: 'Gmail is not configured on this server.',
    });
  }

  return {
    clientId: config.GOOGLE_CLIENT_ID,
    clientSecret: config.GOOGLE_CLIENT_SECRET,
    redirectUri: config.GOOGLE_REDIRECT_URI,
  };
}

export function createProvider(): EmailSendProvider {
  return new GmailProvider(gmailCredentials());
}

/** Hard cap on a stored body. Classification needs the opening, not the archive. */
const MAX_BODY_CHARS = 8_000;

function headerValue(message: GmailMessage, name: string): string | null {
  const headers = message.payload?.headers ?? [];
  return headers.find((header) => header.name.toLowerCase() === name.toLowerCase())?.value ?? null;
}

/**
 * Extracts a plain-text body from Gmail's nested MIME tree.
 *
 * Prefers `text/plain`. Falls back to stripping tags from `text/html`, because a
 * marketing-styled reply is still a reply and refusing to classify it would make
 * the feature unreliable exactly where it matters. Walks recursively: real
 * replies arrive as multipart/alternative inside multipart/mixed.
 */
function extractBody(part: {
  mimeType?: string;
  body?: { data?: string };
  parts?: unknown[];
}): string {
  const decode = (data: string): string => {
    try {
      return Buffer.from(data, 'base64url').toString('utf8');
    } catch {
      return '';
    }
  };

  if (part.mimeType === 'text/plain' && part.body?.data) return decode(part.body.data);

  const children = (part.parts ?? []) as Array<Parameters<typeof extractBody>[0]>;

  for (const child of children) {
    const found = extractBody(child);
    if (found.trim() !== '') return found;
  }

  if (part.mimeType === 'text/html' && part.body?.data) {
    return decode(part.body.data)
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ');
  }

  if (part.body?.data) return decode(part.body.data);
  return '';
}

/** Extracts a bare address from a `Name <addr@host>` header. */
export function parseAddressHeader(value: string | null): string {
  if (!value) return '';
  const angled = /<([^>]+)>/.exec(value);
  return (angled?.[1] ?? value).trim().toLowerCase();
}

/** Normalises one Gmail message into the provider-neutral shape. */
export function normaliseGmailMessage(message: GmailMessage): InboundMessage | null {
  const from = parseAddressHeader(headerValue(message, 'From'));
  if (from === '') return null;

  const receivedAt = message.internalDate
    ? new Date(Number(message.internalDate))
    : new Date();

  if (Number.isNaN(receivedAt.getTime())) return null;

  const body = message.payload ? extractBody(message.payload) : (message.snippet ?? '');

  return {
    providerMessageId: message.id,
    threadId: message.threadId,
    fromEmail: from,
    toEmail: parseAddressHeader(headerValue(message, 'To')),
    subject: headerValue(message, 'Subject'),
    body: body.slice(0, MAX_BODY_CHARS),
    receivedAt,
    inReplyTo: headerValue(message, 'In-Reply-To'),
    // SENT is Gmail's own label for messages the account holder sent. Used to
    // avoid treating our own outbound mail as an inbound reply.
    isFromSelf: (message.labelIds ?? []).includes('SENT'),
  };
}
