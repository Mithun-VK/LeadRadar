import { describe, expect, it } from 'vitest';

import {
  SECRET_PURPOSE,
  constantTimeEqual,
  decryptSecret,
  encryptSecret,
  hashForLookup,
  randomToken,
} from '@/lib/crypto';

describe('encryptSecret / decryptSecret', () => {
  it('round-trips a secret', () => {
    const plaintext = '1//0abcdefgHIJKLMNOP-refresh-token';
    const encrypted = encryptSecret(plaintext, SECRET_PURPOSE.gmailRefreshToken);

    expect(decryptSecret(encrypted, SECRET_PURPOSE.gmailRefreshToken)).toBe(plaintext);
  });

  it('never stores the plaintext in the ciphertext', () => {
    const plaintext = 'super-secret-refresh-token';
    const encrypted = encryptSecret(plaintext, SECRET_PURPOSE.gmailRefreshToken);

    expect(encrypted).not.toContain(plaintext);
    expect(Buffer.from(encrypted, 'utf8').toString()).not.toContain(plaintext);
  });

  it('produces a different ciphertext each time, so the IV is not reused', () => {
    // IV reuse under AES-GCM is catastrophic rather than merely weakening, so
    // this is a correctness test, not a style one.
    const a = encryptSecret('same-value', SECRET_PURPOSE.gmailRefreshToken);
    const b = encryptSecret('same-value', SECRET_PURPOSE.gmailRefreshToken);

    expect(a).not.toBe(b);
    expect(decryptSecret(a, SECRET_PURPOSE.gmailRefreshToken)).toBe(
      decryptSecret(b, SECRET_PURPOSE.gmailRefreshToken),
    );
  });

  it('refuses to decrypt under a different purpose', () => {
    // The AAD binding: a value encrypted as a refresh token cannot be moved into
    // a field expecting something else and still decrypt.
    const encrypted = encryptSecret('token', SECRET_PURPOSE.gmailRefreshToken);

    expect(() => decryptSecret(encrypted, SECRET_PURPOSE.gmailAccessToken)).toThrow();
  });

  it('detects tampering with the ciphertext', () => {
    const encrypted = encryptSecret('token', SECRET_PURPOSE.gmailRefreshToken);
    const parts = encrypted.split('.');
    const flipped = Buffer.from(parts[2]!, 'base64url');
    flipped[0] = flipped[0]! ^ 0xff;
    parts[2] = flipped.toString('base64url');

    expect(() => decryptSecret(parts.join('.'), SECRET_PURPOSE.gmailRefreshToken)).toThrow();
  });

  it('detects tampering with the authentication tag', () => {
    const encrypted = encryptSecret('token', SECRET_PURPOSE.gmailRefreshToken);
    const parts = encrypted.split('.');
    const tag = Buffer.from(parts[3]!, 'base64url');
    tag[0] = tag[0]! ^ 0xff;
    parts[3] = tag.toString('base64url');

    expect(() => decryptSecret(parts.join('.'), SECRET_PURPOSE.gmailRefreshToken)).toThrow();
  });

  it('rejects a value that is not in the expected format', () => {
    expect(() => decryptSecret('not-encrypted', SECRET_PURPOSE.gmailRefreshToken)).toThrow(
      /expected encrypted format/i,
    );
  });

  it('rejects an unknown format version rather than guessing', () => {
    const encrypted = encryptSecret('token', SECRET_PURPOSE.gmailRefreshToken);
    const parts = encrypted.split('.');
    parts[0] = 'v99';

    expect(() => decryptSecret(parts.join('.'), SECRET_PURPOSE.gmailRefreshToken)).toThrow();
  });

  it('rejects malformed framing', () => {
    expect(() => decryptSecret('v1.short.x.y', SECRET_PURPOSE.gmailRefreshToken)).toThrow();
  });

  it('refuses to encrypt an empty secret, which is never meaningful', () => {
    expect(() => encryptSecret('', SECRET_PURPOSE.gmailRefreshToken)).toThrow();
  });

  it('gives the same error whether the key is wrong or the bytes were tampered with', () => {
    // An attacker probing the store should not learn which of the two happened.
    const encrypted = encryptSecret('token', SECRET_PURPOSE.gmailRefreshToken);
    const parts = encrypted.split('.');
    const flipped = Buffer.from(parts[2]!, 'base64url');
    flipped[0] = flipped[0]! ^ 0xff;
    parts[2] = flipped.toString('base64url');

    let tamperMessage = '';
    let purposeMessage = '';
    try {
      decryptSecret(parts.join('.'), SECRET_PURPOSE.gmailRefreshToken);
    } catch (error) {
      tamperMessage = (error as Error).message;
    }
    try {
      decryptSecret(encrypted, SECRET_PURPOSE.oauthState);
    } catch (error) {
      purposeMessage = (error as Error).message;
    }

    expect(tamperMessage).toBe(purposeMessage);
  });

  it('handles a long, non-ASCII secret', () => {
    const value = `${'வணக்கம்'.repeat(200)}-token`;
    const encrypted = encryptSecret(value, SECRET_PURPOSE.gmailAccessToken);

    expect(decryptSecret(encrypted, SECRET_PURPOSE.gmailAccessToken)).toBe(value);
  });
});

describe('hashForLookup', () => {
  it('is stable for the same input', () => {
    expect(hashForLookup('info@clinic.in')).toBe(hashForLookup('info@clinic.in'));
  });

  it('normalises case and surrounding whitespace', () => {
    // Load-bearing for suppression: someone who unsubscribed as Info@Clinic.IN
    // must still be matched when the address is later seen lowercased.
    expect(hashForLookup('  Info@Clinic.IN ')).toBe(hashForLookup('info@clinic.in'));
  });

  it('differs for different inputs', () => {
    expect(hashForLookup('a@x.in')).not.toBe(hashForLookup('b@x.in'));
  });

  it('does not reveal the input', () => {
    expect(hashForLookup('info@clinic.in')).not.toContain('clinic');
  });
});

describe('constantTimeEqual', () => {
  it('returns true for identical strings', () => {
    expect(constantTimeEqual('abc123', 'abc123')).toBe(true);
  });

  it('returns false for different strings', () => {
    expect(constantTimeEqual('abc123', 'abc124')).toBe(false);
  });

  it('returns false for different lengths without throwing', () => {
    expect(constantTimeEqual('abc', 'abcdef')).toBe(false);
  });
});

describe('randomToken', () => {
  it('produces URL-safe output', () => {
    for (let i = 0; i < 20; i += 1) {
      expect(randomToken()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('does not repeat', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => randomToken()));
    expect(tokens.size).toBe(200);
  });

  it('honours the requested byte length', () => {
    expect(Buffer.from(randomToken(16), 'base64url')).toHaveLength(16);
  });
});
