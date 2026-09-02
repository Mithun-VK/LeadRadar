/**
 * Mock email sender.
 *
 * The most important mock in this codebase. Every other mock stands in for a
 * provider that would merely cost money; this one stands in for a provider that
 * would contact real strangers under the operator's own name and sending
 * reputation. A bug in the campaign engine discovered in production is not a bad
 * row in a table — it is mail that cannot be recalled.
 *
 * So the entire outreach pipeline — enrolment, suppression, personalization,
 * queueing, rate limiting, retries, status transitions, analytics — runs against
 * this adapter with no credentials and delivers nowhere. `MOCK_EXTERNAL_APIS` is
 * rejected in production, so this can never be what a paying operator is using.
 *
 * It also deliberately fails sometimes. A sender that always succeeds would leave
 * the retry path, the DLQ, and the FAILED status untested until the first real
 * campaign.
 */
import { createHash } from 'node:crypto';

import { AppError } from '@/lib/errors';
import { ok, err, type Result } from '@/lib/result';
import type {
  EmailSendProvider,
  FetchInboxRequest,
  InboundMessage,
  OAuthTokens,
  SendMessageRequest,
  SendMessageResult,
} from '../contracts';
import { REQUESTED_SCOPES } from '../gmail/schemas';

/** A message the mock "sent", retained in memory for assertions and the UI. */
export interface MockSentMessage {
  readonly to: string;
  readonly mime: string;
  readonly sentAt: Date;
  readonly providerMessageId: string;
}

/**
 * Deterministic pseudo-randomness from the recipient address.
 *
 * A real random failure would make tests flaky; keying on the address means the
 * same recipient always behaves the same way, so a failure is reproducible while
 * a realistic mix of outcomes still appears across a campaign.
 */
function addressHash(address: string): number {
  const digest = createHash('sha256').update(address.toLowerCase()).digest();
  return digest.readUInt32BE(0) / 0xffffffff;
}

/** Addresses that always fail, so the failure path is exercisable on demand. */
const ALWAYS_FAIL = /^(bounce|fail|invalid)@/i;
const ALWAYS_RATE_LIMIT = /^ratelimit@/i;

/**
 * A domain reserved for deterministic verification, which never draws the
 * probabilistic failure below.
 *
 * The address-keyed failure above is reproducible only for a FIXED address. The
 * verification scripts mint a fresh address per run (`good-<uuid>@…`) so that
 * repeated runs do not collide in the database — which means each run draws a
 * fresh sample, and roughly one run in seventeen landed above the failure
 * threshold and failed for no product reason at all. A verification suite that
 * fails 6% of the time trains its reader to ignore it, which costs more than the
 * realism gained.
 *
 * Explicit failure prefixes still win over this, so `bounce@verify-example.in`
 * remains a bounce: determinism here means "the outcome is stated by the
 * address", not "everything succeeds".
 */
const RELIABLE_DOMAIN = /@verify-example\.in$/i;

export class MockEmailSendProvider implements EmailSendProvider {
  readonly name = 'mock-gmail';
  readonly isMock = true;

  /** In-memory outbox. Bounded so a long-running worker cannot grow without limit. */
  private readonly outbox: MockSentMessage[] = [];
  private static readonly MAX_OUTBOX = 500;

  authorizationUrl(state: string): string {
    // Points at our own callback so the connect flow completes locally without
    // ever contacting Google.
    return `/api/email/gmail/callback?code=mock-authorization-code&state=${encodeURIComponent(state)}`;
  }

  async exchangeCode(code: string): Promise<Result<OAuthTokens>> {
    if (code === '') {
      return err(
        new AppError({ code: 'VALIDATION_FAILED', message: 'Mock OAuth received an empty code' }),
      );
    }

    return ok({
      accessToken: 'mock-access-token',
      refreshToken: 'mock-refresh-token',
      expiresAt: new Date(Date.now() + 3_600_000),
      scopes: [...REQUESTED_SCOPES],
    });
  }

  async refreshAccessToken(refreshToken: string): Promise<Result<OAuthTokens>> {
    if (refreshToken !== 'mock-refresh-token') {
      // Exercises the invalidation path: a refresh token the provider rejects
      // must stop sending rather than retry forever.
      return err(
        new AppError({
          code: 'CONFIG_INVALID',
          message: 'Mock OAuth rejected an unknown refresh token',
          retryability: 'never',
        }),
      );
    }

    return ok({
      accessToken: 'mock-access-token',
      // Google omits the refresh token on refresh; the mock matches that so the
      // "do not overwrite with null" logic is genuinely tested.
      refreshToken: null,
      expiresAt: new Date(Date.now() + 3_600_000),
      scopes: [...REQUESTED_SCOPES],
    });
  }

  async getProfile(): Promise<Result<{ emailAddress: string }>> {
    return ok({ emailAddress: 'demo@leadradar.test' });
  }

  async send(request: SendMessageRequest): Promise<Result<SendMessageResult>> {
    if (ALWAYS_RATE_LIMIT.test(request.to)) {
      return err(
        new AppError({
          code: 'PROVIDER_RATE_LIMITED',
          message: 'Mock sender is simulating a Gmail quota limit',
          retryAfterSeconds: 60,
        }),
      );
    }

    if (ALWAYS_FAIL.test(request.to)) {
      return err(
        new AppError({
          code: 'PROVIDER_BAD_REQUEST',
          message: 'Mock sender is simulating a permanent delivery failure',
          retryability: 'never',
        }),
      );
    }

    // Reserved verification domain: skip the probabilistic failure entirely.
    // Checked AFTER the explicit failure prefixes above, so a deliberate
    // `bounce@verify-example.in` still bounces.
    if (RELIABLE_DOMAIN.test(request.to)) {
      return this.accept(request);
    }

    // A small deterministic failure rate, so retry and DLQ handling are exercised
    // by an ordinary mock-mode run rather than only by a contrived test.
    if (addressHash(request.to) > 0.94) {
      return err(
        new AppError({
          code: 'PROVIDER_UNAVAILABLE',
          message: 'Mock sender is simulating a transient provider failure',
        }),
      );
    }

    return this.accept(request);
  }

  /** Records a delivery in the outbox and returns provider identifiers. */
  private accept(request: SendMessageRequest): Result<SendMessageResult> {
    const providerMessageId = `mock-${createHash('sha256')
      .update(`${request.to}:${request.mime.length}:${Date.now()}`)
      .digest('hex')
      .slice(0, 16)}`;

    this.outbox.push({
      to: request.to,
      mime: request.mime,
      sentAt: new Date(),
      providerMessageId,
    });
    if (this.outbox.length > MockEmailSendProvider.MAX_OUTBOX) this.outbox.shift();

    return ok({
      providerMessageId,
      providerThreadId: `mock-thread-${providerMessageId.slice(-8)}`,
    });
  }

  /** Everything this adapter "sent", for tests and the mock-mode UI. */
  sentMessages(): readonly MockSentMessage[] {
    return [...this.outbox];
  }

  clear(): void {
    this.outbox.length = 0;
    this.inbox.length = 0;
  }

  // -------------------------------------------------------------------------
  // Inbox
  // -------------------------------------------------------------------------

  /**
   * Replies queued to be returned by the next `fetchInbox`.
   *
   * A test or a demo pushes one of these to simulate a prospect answering. That
   * is the whole reply-detection pipeline — matching, classification, campaign
   * stopping, status change — exercised with no mailbox and no credentials.
   */
  private readonly inbox: InboundMessage[] = [];

  /** Queues an inbound reply. */
  queueReply(input: {
    fromEmail: string;
    toEmail?: string;
    subject?: string;
    body: string;
    threadId?: string;
    inReplyTo?: string | null;
    receivedAt?: Date;
  }): InboundMessage {
    const message: InboundMessage = {
      providerMessageId: `mock-in-${createHash('sha256')
        .update(`${input.fromEmail}:${input.body}:${this.inbox.length}`)
        .digest('hex')
        .slice(0, 16)}`,
      threadId: input.threadId ?? `mock-thread-${this.inbox.length}`,
      fromEmail: input.fromEmail.toLowerCase(),
      toEmail: (input.toEmail ?? 'demo@leadradar.test').toLowerCase(),
      subject: input.subject ?? 'Re: Quick note',
      body: input.body,
      receivedAt: input.receivedAt ?? new Date(),
      inReplyTo: input.inReplyTo ?? null,
      isFromSelf: false,
    };

    this.inbox.push(message);
    return message;
  }

  async fetchInbox(request: FetchInboxRequest): Promise<Result<readonly InboundMessage[]>> {
    // Applies the same `since` cut the real adapter does, so a caller relying on
    // it is genuinely tested rather than accidentally passing.
    return ok(this.inbox.filter((message) => message.receivedAt >= request.since));
  }
}
