/**
 * MIME composition.
 *
 * Hand-built rather than pulled from a library, because the message this product
 * sends is deliberately simple — one plain-text body, a few headers — and the
 * parts that actually matter are the ones a general-purpose library would not
 * enforce: header injection defence, and the unsubscribe headers that decide
 * whether Gmail and Outlook treat the mail as legitimate.
 *
 * ---------------------------------------------------------------------------
 * HEADER INJECTION
 * ---------------------------------------------------------------------------
 *
 * Every header value here derives from data we scraped from a third-party
 * website: a business name from a page title, an address from a contact page.
 * A CR or LF smuggled into any of them would let an attacker terminate a header
 * and inject their own — a `Bcc:` to a thousand recipients, or a replacement
 * body. This is the email equivalent of the CSV-injection defence already in the
 * exporter, and it is enforced at the only place headers are constructed.
 */
import { AppError } from '@/lib/errors';

/**
 * Strips CR, LF, and NUL from a header value.
 *
 * Folds rather than rejects for ordinary whitespace, because a business name
 * legitimately containing a newline (from sloppy markup) should still produce a
 * deliverable email — but the newline must never reach the wire.
 */
export function sanitizeHeaderValue(value: string): string {
  return value
    .replace(/[\r\n\0]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Validates an address destined for a header.
 *
 * Stricter than the extractor's syntax check because this is the last gate
 * before a value is written into the message envelope.
 */
export function assertSafeAddress(address: string, field: string): string {
  const cleaned = sanitizeHeaderValue(address);

  if (cleaned !== address.trim()) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: `${field} contained characters that are not permitted in an email header`,
      safeMessage: 'That email address is not valid.',
    });
  }
  if (!/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]{2,}$/.test(cleaned)) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: `${field} is not a valid email address`,
      safeMessage: 'That email address is not valid.',
    });
  }

  return cleaned;
}

/**
 * Encodes a header value that may contain non-ASCII.
 *
 * RFC 2047 encoded-word, because a display name like "Café Madras" sent as raw
 * UTF-8 in a header is not standards-conformant and renders as mojibake in some
 * clients. Plain ASCII is left alone so the common case stays readable on the
 * wire.
 */
export function encodeHeaderWord(value: string): string {
  const clean = sanitizeHeaderValue(value);
  if (/^[\x20-\x7E]*$/.test(clean)) return clean;
  return `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
}

/** A display name plus address, e.g. `Priya <priya@agency.in>`. */
export function formatAddress(address: string, displayName?: string | null): string {
  const safeAddress = assertSafeAddress(address, 'address');
  if (!displayName) return safeAddress;

  const name = encodeHeaderWord(displayName);
  if (name === '') return safeAddress;
  // Quote the display name so a comma or colon inside it cannot be read as
  // an address separator.
  return `"${name.replace(/"/g, '')}" <${safeAddress}>`;
}

export interface MimeMessageInput {
  readonly to: string;
  readonly from: string;
  readonly fromName?: string | null;
  readonly subject: string;
  readonly body: string;
  readonly replyTo?: string | null;
  /** Absolute URL a recipient can open to unsubscribe. */
  readonly unsubscribeUrl: string;
  /** Our generated Message-ID, so a reply can later be correlated. */
  readonly messageId: string;
}

/**
 * Builds an RFC 5322 message.
 *
 * Plain text only, deliberately. An HTML outreach email with tracking pixels and
 * styled buttons reads as marketing and is filed as marketing; a plain-text note
 * reads as a person writing to a person, which is both more honest about what it
 * is and materially more likely to be delivered and answered.
 */
export function buildMimeMessage(input: MimeMessageInput): string {
  const to = assertSafeAddress(input.to, 'to');
  const from = assertSafeAddress(input.from, 'from');
  const subject = encodeHeaderWord(input.subject);

  if (!/^https:\/\/|^http:\/\//.test(input.unsubscribeUrl)) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'Unsubscribe URL must be absolute so a recipient can actually open it',
    });
  }
  const unsubscribeUrl = sanitizeHeaderValue(input.unsubscribeUrl);

  const headers: string[] = [
    `From: ${formatAddress(from, input.fromName ?? null)}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Message-ID: <${sanitizeHeaderValue(input.messageId)}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    /**
     * List-Unsubscribe is not decoration. Gmail and Outlook surface a native
     * one-click unsubscribe control when it is present, and its ABSENCE on bulk
     * mail is itself a spam signal. Offering the easy exit measurably improves
     * deliverability for everyone who does not take it.
     */
    `List-Unsubscribe: <${unsubscribeUrl}>`,
    'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
    /**
     * Marks the message as unsolicited bulk in the sense RFC 3834 intends, so
     * automated systems do not generate vacation replies back at us.
     */
    'Auto-Submitted: auto-generated',
  ];

  if (input.replyTo) {
    headers.push(`Reply-To: ${assertSafeAddress(input.replyTo, 'replyTo')}`);
  }

  /**
   * The unsubscribe line is appended to the body as well as the header.
   *
   * The header serves mail clients; this serves the human. A recipient who wants
   * out must be able to find the way out by reading the message, without knowing
   * that mail headers exist.
   */
  const body = `${input.body.trimEnd()}\n\n---\nTo stop receiving these emails, open: ${unsubscribeUrl}\n`;

  // Base64 with CRLF line breaks at 76 characters, per RFC 2045. Unencoded UTF-8
  // bodies break on any line over 998 octets, which a long paragraph reaches.
  const encodedBody = Buffer.from(body, 'utf8')
    .toString('base64')
    .replace(/(.{76})/g, '$1\r\n');

  return `${headers.join('\r\n')}\r\n\r\n${encodedBody}`;
}

/** Gmail's API takes the raw message base64url-encoded. */
export function toGmailRaw(mime: string): string {
  return Buffer.from(mime, 'utf8').toString('base64url');
}

/** Generates a Message-ID bound to our own domain portion. */
export function generateMessageId(token: string, domain: string): string {
  const host = sanitizeHeaderValue(domain).replace(/[^a-z0-9.-]/gi, '') || 'leadradar.local';
  return `${token}@${host}`;
}
