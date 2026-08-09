import { describe, expect, it } from 'vitest';

import { assertSameOrigin, issueCsrfToken, verifyCsrfToken } from '@/modules/auth/csrf';
import { safeCompare } from '@/modules/auth/session';
import { isAppError } from '@/lib/errors';

describe('CSRF token binding', () => {
  it('accepts a token issued for the same session', () => {
    const token = issueCsrfToken('session-abc');
    expect(verifyCsrfToken(token, 'session-abc')).toBe(true);
  });

  /**
   * The reason for the HMAC rather than a bare random value.
   *
   * The CSRF cookie must be readable by JavaScript so the client can echo it, which
   * means a subdomain attacker can plant one. Binding to the session id makes a
   * planted token useless: it will not verify against the victim's session.
   */
  it('rejects a token issued for a different session', () => {
    const token = issueCsrfToken('session-abc');
    expect(verifyCsrfToken(token, 'session-xyz')).toBe(false);
  });

  it('rejects a tampered signature', () => {
    const token = issueCsrfToken('session-abc');
    const [nonce] = token.split('.');
    expect(verifyCsrfToken(`${nonce}.forgedsignature`, 'session-abc')).toBe(false);
  });

  it('rejects a tampered nonce', () => {
    const token = issueCsrfToken('session-abc');
    const signature = token.slice(token.lastIndexOf('.') + 1);
    expect(verifyCsrfToken(`differentnonce.${signature}`, 'session-abc')).toBe(false);
  });

  it('rejects malformed and empty tokens', () => {
    for (const token of [undefined, '', 'nodot', '.', 'a.', '.b']) {
      expect(verifyCsrfToken(token as string | undefined, 'session-abc')).toBe(false);
    }
  });

  it('issues a distinct token each time', () => {
    const a = issueCsrfToken('session-abc');
    const b = issueCsrfToken('session-abc');
    expect(a).not.toBe(b);
    // Both remain valid: the nonce varies, the binding does not.
    expect(verifyCsrfToken(a, 'session-abc')).toBe(true);
    expect(verifyCsrfToken(b, 'session-abc')).toBe(true);
  });
});

describe('assertSameOrigin', () => {
  function requestWith(origin: string | null, url = 'https://leadradar.example/api/search') {
    return new Request(url, {
      method: 'POST',
      headers: origin ? { origin } : {},
    });
  }

  it('allows a same-origin request', () => {
    expect(() => assertSameOrigin(requestWith('https://leadradar.example'), [])).not.toThrow();
  });

  it('rejects a cross-origin request', () => {
    expect(() => assertSameOrigin(requestWith('https://evil.example'), [])).toThrow();
    try {
      assertSameOrigin(requestWith('https://evil.example'), []);
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('FORBIDDEN');
    }
  });

  it('allows an explicitly permitted host', () => {
    expect(() =>
      assertSameOrigin(requestWith('https://app.leadradar.example'), ['app.leadradar.example']),
    ).not.toThrow();
  });

  /**
   * Absent Origin is allowed: same-origin GETs and some legitimate non-browser
   * clients omit it. Mutations are still gated by the token check, so this is not a
   * hole — refusing would break real clients for no gain.
   */
  it('allows a request with no Origin header', () => {
    expect(() => assertSameOrigin(requestWith(null), [])).not.toThrow();
  });

  it('rejects an unparseable Origin', () => {
    expect(() => assertSameOrigin(requestWith('not-a-url'), [])).toThrow();
  });

  // A subdomain is a different origin; a compromised marketing site must not be
  // able to act on the app.
  it('rejects a sibling subdomain not explicitly allowed', () => {
    expect(() => assertSameOrigin(requestWith('https://blog.leadradar.example'), [])).toThrow();
  });
});

describe('safeCompare', () => {
  it('matches identical strings', () => {
    expect(safeCompare('abc123', 'abc123')).toBe(true);
  });

  it('rejects different strings and different lengths', () => {
    expect(safeCompare('abc123', 'abc124')).toBe(false);
    expect(safeCompare('abc', 'abc123')).toBe(false);
    expect(safeCompare('', 'a')).toBe(false);
  });

  it('handles empty strings without throwing', () => {
    expect(safeCompare('', '')).toBe(true);
  });
});
