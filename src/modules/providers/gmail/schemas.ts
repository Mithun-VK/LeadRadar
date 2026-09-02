/**
 * Google OAuth and Gmail API response schemas.
 *
 * Parsed rather than trusted, for the same reason every other provider response
 * is: an unexpected shape must surface as a typed error at the boundary, not as
 * `undefined` propagating into a database write three layers down.
 */
import { z } from 'zod';

/**
 * Token endpoint response.
 *
 * `refresh_token` is optional and its absence is normal, not an error: Google
 * returns one only on the first consent, or when `prompt=consent` forces a fresh
 * grant. Re-authorising an already-connected account therefore yields an access
 * token alone, and the previously stored refresh token remains the valid one.
 * Treating its absence as a failure would break reconnection.
 */
export const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive().optional(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
  id_token: z.string().optional(),
});

export type TokenResponse = z.infer<typeof tokenResponseSchema>;

/** Error body returned by both the token endpoint and the Gmail API. */
export const oauthErrorSchema = z.object({
  error: z.union([
    z.string(),
    z.object({
      code: z.number().int().optional(),
      message: z.string().optional(),
      status: z.string().optional(),
    }),
  ]),
  error_description: z.string().optional(),
});

/** `users.getProfile`, used to learn which mailbox was actually connected. */
export const gmailProfileSchema = z.object({
  emailAddress: z.string().min(3),
  messagesTotal: z.number().int().optional(),
  threadsTotal: z.number().int().optional(),
  historyId: z.string().optional(),
});

/** `users.messages.send`. */
export const gmailSendResponseSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1).optional(),
  labelIds: z.array(z.string()).optional(),
});

export type GmailSendResponse = z.infer<typeof gmailSendResponseSchema>;

/**
 * Scopes this product requests.
 *
 * ---------------------------------------------------------------------------
 * A DELIBERATE, DOCUMENTED WIDENING
 * ---------------------------------------------------------------------------
 *
 * This product originally requested `gmail.send` ALONE, and said so prominently:
 * it could send as the user and could not read their mailbox. That was the right
 * design for a send-only tool, and the consequence was accepted — reply detection
 * was impossible, and the REPLIED status was never set automatically.
 *
 * Reply detection was subsequently required, and reply detection cannot be done
 * without reading. `gmail.readonly` is the narrowest scope that permits reading a
 * reply body; `gmail.metadata` returns headers only, which is enough to notice
 * that a reply happened but not to classify what it asks for. Google offers no
 * "read only the threads you sent" scope.
 *
 * The obligations this creates are enforced elsewhere and listed here so they are
 * not lost:
 *
 *   1. Only messages on a thread WE started are ever stored. An unrelated email
 *      is read during sync, matched against nothing, and discarded — see
 *      `email/inbox-sync.ts`.
 *   2. Stored bodies expire (`EmailConversation.bodyExpiresAt`). The
 *      classification outcome is durable; the third-party personal data is not.
 *   3. Accounts connected under the old scope keep working for SENDING and are
 *      flagged as needing re-consent for sync, rather than silently failing.
 *
 * See docs/REVENUE_ENGINE_AUDIT.md §6 and docs/DATA_RETENTION.md.
 */
export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

/** Reads messages, so a reply can be detected and classified. */
export const GMAIL_READ_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

/** Requested alongside send, so the connected address can be confirmed. */
export const GMAIL_PROFILE_SCOPE = 'https://www.googleapis.com/auth/userinfo.email';

export const REQUESTED_SCOPES = [
  GMAIL_SEND_SCOPE,
  GMAIL_READ_SCOPE,
  GMAIL_PROFILE_SCOPE,
] as const;

/** Whether a granted scope set permits sending. */
export function grantsSend(scopes: readonly string[]): boolean {
  return scopes.some((scope) => scope === GMAIL_SEND_SCOPE || scope === 'https://mail.google.com/');
}

/**
 * Whether a granted scope set permits reading.
 *
 * False for every account connected before the widening above, which is exactly
 * what lets the UI prompt for re-consent instead of the sync worker failing
 * repeatedly against a grant that will never work.
 */
export function grantsRead(scopes: readonly string[]): boolean {
  return scopes.some(
    (scope) =>
      scope === GMAIL_READ_SCOPE ||
      scope === 'https://www.googleapis.com/auth/gmail.modify' ||
      scope === 'https://mail.google.com/',
  );
}

/** A page of message ids from `users.messages.list`. */
export const gmailMessageListSchema = z.object({
  messages: z
    .array(z.object({ id: z.string(), threadId: z.string().optional() }))
    .optional(),
  nextPageToken: z.string().optional(),
  resultSizeEstimate: z.number().int().optional(),
});

const headerSchema = z.object({ name: z.string(), value: z.string() });

const partSchema: z.ZodType<{
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: unknown[];
}> = z.lazy(() =>
  z.object({
    mimeType: z.string().optional(),
    body: z.object({ data: z.string().optional(), size: z.number().int().optional() }).optional(),
    parts: z.array(partSchema).optional(),
  }),
);

/** One message from `users.messages.get`. */
export const gmailMessageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  labelIds: z.array(z.string()).optional(),
  snippet: z.string().optional(),
  internalDate: z.string().optional(),
  payload: z
    .object({
      mimeType: z.string().optional(),
      headers: z.array(headerSchema).optional(),
      body: z.object({ data: z.string().optional() }).optional(),
      parts: z.array(partSchema).optional(),
    })
    .optional(),
});

export type GmailMessage = z.infer<typeof gmailMessageSchema>;
