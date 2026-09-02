import { describe, expect, it } from 'vitest';

import {
  assertSafeAddress,
  buildMimeMessage,
  encodeHeaderWord,
  formatAddress,
  generateMessageId,
  sanitizeHeaderValue,
  toGmailRaw,
} from '@/modules/email/mime';

function message(overrides: Partial<Parameters<typeof buildMimeMessage>[0]> = {}): string {
  return buildMimeMessage({
    to: 'owner@clinic.in',
    from: 'me@agency.in',
    fromName: 'Priya',
    subject: 'Quick note',
    body: 'Hello there.',
    unsubscribeUrl: 'https://app.example/unsubscribe/abc123',
    messageId: 'token@app.example',
    ...overrides,
  });
}

function decodeBody(mime: string): string {
  const [, encoded] = mime.split('\r\n\r\n');
  return Buffer.from((encoded ?? '').replace(/\r\n/g, ''), 'base64').toString('utf8');
}

describe('sanitizeHeaderValue', () => {
  it('removes CR and LF, which are the header-injection vector', () => {
    expect(sanitizeHeaderValue('Acme\r\nBcc: victim@example.com')).toBe(
      'Acme Bcc: victim@example.com',
    );
  });

  it('removes NUL bytes', () => {
    expect(sanitizeHeaderValue('Acme\0Dental')).toBe('Acme Dental');
  });

  it('collapses runs of whitespace', () => {
    expect(sanitizeHeaderValue('  Acme    Dental  ')).toBe('Acme Dental');
  });
});

describe('assertSafeAddress', () => {
  it('accepts an ordinary address', () => {
    expect(assertSafeAddress('owner@clinic.in', 'to')).toBe('owner@clinic.in');
  });

  it('rejects an address carrying a newline', () => {
    expect(() => assertSafeAddress('a@b.com\r\nBcc: c@d.com', 'to')).toThrow();
  });

  it('rejects an address containing angle brackets or a comma', () => {
    expect(() => assertSafeAddress('a@b.com, c@d.com', 'to')).toThrow();
    expect(() => assertSafeAddress('<a@b.com>', 'to')).toThrow();
  });

  it('rejects a value that is not an address at all', () => {
    expect(() => assertSafeAddress('not-an-address', 'to')).toThrow();
  });
});

describe('encodeHeaderWord', () => {
  it('leaves plain ASCII readable on the wire', () => {
    expect(encodeHeaderWord('Quick note')).toBe('Quick note');
  });

  it('encodes non-ASCII per RFC 2047 rather than emitting raw UTF-8', () => {
    const encoded = encodeHeaderWord('Café Madras');
    expect(encoded).toMatch(/^=\?UTF-8\?B\?/);
    expect(Buffer.from(encoded.slice(10, -2), 'base64').toString('utf8')).toBe('Café Madras');
  });
});

describe('formatAddress', () => {
  it('returns a bare address when there is no display name', () => {
    expect(formatAddress('me@agency.in')).toBe('me@agency.in');
  });

  it('quotes the display name so a comma cannot split the field', () => {
    expect(formatAddress('me@agency.in', 'Raman, Priya')).toBe('"Raman, Priya" <me@agency.in>');
  });

  it('strips an injected newline from the display name', () => {
    const formatted = formatAddress('me@agency.in', 'Priya\r\nBcc: victim@example.com');
    expect(formatted).not.toMatch(/[\r\n]/);
  });
});

describe('buildMimeMessage', () => {
  it('produces the expected headers', () => {
    const mime = message();

    expect(mime).toContain('To: owner@clinic.in');
    expect(mime).toContain('"Priya" <me@agency.in>');
    expect(mime).toContain('Subject: Quick note');
    expect(mime).toContain('MIME-Version: 1.0');
    expect(mime).toContain('Content-Type: text/plain; charset="UTF-8"');
  });

  it('includes both unsubscribe headers, which decide how bulk mail is filed', () => {
    const mime = message();

    expect(mime).toContain('List-Unsubscribe: <https://app.example/unsubscribe/abc123>');
    expect(mime).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
  });

  it('also puts the unsubscribe link in the body, for the human rather than the client', () => {
    expect(decodeBody(message())).toContain('https://app.example/unsubscribe/abc123');
  });

  it('sends plain text only, never HTML', () => {
    const mime = message();
    expect(mime).not.toContain('text/html');
    expect(mime).not.toContain('multipart/');
  });

  it('refuses a relative unsubscribe URL a recipient could not open', () => {
    expect(() => message({ unsubscribeUrl: '/unsubscribe/abc' })).toThrow(/absolute/i);
  });

  it('neutralises a header injection attempt smuggled through the subject', () => {
    const mime = message({
      subject: 'Hello\r\nBcc: victim@example.com\r\nSubject: Hijacked',
    });

    const headerSection = mime.split('\r\n\r\n')[0] ?? '';
    expect(headerSection).not.toMatch(/^Bcc:/m);
    expect(headerSection.split('\r\n').filter((line) => line.startsWith('Subject:'))).toHaveLength(
      1,
    );
  });

  it('neutralises an injection attempt smuggled through a scraped business name', () => {
    // The realistic vector: a page title becomes a display name.
    const mime = message({ fromName: 'Acme\r\nBcc: everyone@example.com' });
    const headerSection = mime.split('\r\n\r\n')[0] ?? '';

    expect(headerSection).not.toMatch(/^Bcc:/m);
  });

  it('rejects an injected recipient outright', () => {
    expect(() => message({ to: 'a@b.com\r\nBcc: c@d.com' })).toThrow();
  });

  it('base64-encodes the body so long lines cannot break the message', () => {
    const long = 'x'.repeat(3_000);
    const mime = message({ body: long });

    expect(mime).toContain('Content-Transfer-Encoding: base64');
    for (const line of (mime.split('\r\n\r\n')[1] ?? '').split('\r\n')) {
      expect(line.length).toBeLessThanOrEqual(76);
    }
    expect(decodeBody(mime)).toContain(long);
  });

  it('round-trips a non-ASCII body intact', () => {
    const body = 'வணக்கம் — hello in Tamil';
    expect(decodeBody(message({ body }))).toContain(body);
  });

  it('includes a Reply-To when one is given', () => {
    expect(message({ replyTo: 'reply@agency.in' })).toContain('Reply-To: reply@agency.in');
  });
});

describe('toGmailRaw', () => {
  it('encodes base64url, with no characters that need escaping in JSON', () => {
    const encoded = toGmailRaw(message());
    expect(encoded).not.toMatch(/[+/=]/);
    expect(Buffer.from(encoded, 'base64url').toString('utf8')).toContain('To: owner@clinic.in');
  });
});

describe('generateMessageId', () => {
  it('builds an id on the given host', () => {
    expect(generateMessageId('abc', 'app.example')).toBe('abc@app.example');
  });

  it('strips characters that are invalid in a hostname', () => {
    expect(generateMessageId('abc', 'evil host>\r\n')).toBe('abc@evilhost');
  });

  it('falls back to a placeholder rather than emitting an empty host', () => {
    expect(generateMessageId('abc', '!!!')).toBe('abc@leadradar.local');
  });
});
