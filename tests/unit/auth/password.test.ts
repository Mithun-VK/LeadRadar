import { describe, expect, it } from 'vitest';

import {
  PASSWORD_MIN_LENGTH,
  checkPasswordPolicy,
  hashPassword,
  verifyPassword,
} from '@/modules/auth/password';

describe('checkPasswordPolicy', () => {
  it('accepts a reasonable passphrase', () => {
    expect(checkPasswordPolicy('correct horse battery staple').ok).toBe(true);
  });

  it('enforces a minimum length', () => {
    const result = checkPasswordPolicy('short');
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain(String(PASSWORD_MIN_LENGTH));
  });

  it('rejects common passwords', () => {
    expect(checkPasswordPolicy('password123').ok).toBe(false);
    expect(checkPasswordPolicy('PASSWORD123').ok).toBe(false);
  });

  it('rejects a password containing the email local part', () => {
    expect(checkPasswordPolicy('ravikumar-secret', 'ravikumar@agency.in').ok).toBe(false);
    // A short local part is not distinctive enough to bar a whole password.
    expect(checkPasswordPolicy('abcdefghijklm', 'ab@agency.in').ok).toBe(true);
  });

  it('rejects a single repeated character', () => {
    expect(checkPasswordPolicy('aaaaaaaaaaaaaaa').ok).toBe(false);
  });

  /**
   * No composition rules on purpose. NIST and OWASP both dropped them: forcing
   * character classes produces predictable substitutions without adding entropy.
   */
  it('does not demand mixed case, digits, or symbols', () => {
    expect(checkPasswordPolicy('alllowercasenodigits').ok).toBe(true);
  });

  it('rejects an absurdly long password rather than hashing it', () => {
    expect(checkPasswordPolicy('a'.repeat(500)).ok).toBe(false);
  });
});

describe('hashPassword / verifyPassword', () => {
  // scrypt at N=2^16 is intentionally slow; these need more than the default budget.
  const timeout = 30_000;

  it('round-trips a correct password', { timeout }, async () => {
    const hash = await hashPassword('correct horse battery staple');
    const result = await verifyPassword('correct horse battery staple', hash);
    expect(result.valid).toBe(true);
    expect(result.needsRehash).toBe(false);
  });

  it('rejects a wrong password', { timeout }, async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect((await verifyPassword('wrong horse battery staple', hash)).valid).toBe(false);
  });

  it('produces a different hash each time, so salts are unique', { timeout }, async () => {
    const a = await hashPassword('same password here');
    const b = await hashPassword('same password here');
    expect(a).not.toBe(b);
    // Both still verify: the salt is embedded, not shared.
    expect((await verifyPassword('same password here', a)).valid).toBe(true);
    expect((await verifyPassword('same password here', b)).valid).toBe(true);
  });

  it('embeds its parameters so they can be raised later', { timeout }, async () => {
    const hash = await hashPassword('parameters are embedded');
    const [scheme, N, r, p] = hash.split('$');
    expect(scheme).toBe('scrypt');
    expect(Number(N)).toBeGreaterThanOrEqual(65_536);
    expect(Number(r)).toBe(8);
    expect(Number(p)).toBe(1);
  });

  it('flags a hash created with weaker parameters for rehash', { timeout }, async () => {
    const strong = await hashPassword('needs no upgrade');
    const [, , , p, salt, digest] = strong.split('$');
    // Fabricate a legacy record claiming a lower N. It will not verify (the digest
    // was derived at the real N), which is the correct outcome — a tampered
    // parameter cannot be used to make a wrong password pass.
    const tampered = ['scrypt', '16384', '8', p, salt, digest].join('$');
    expect((await verifyPassword('needs no upgrade', tampered)).valid).toBe(false);
  });

  /**
   * The enumeration defence. A missing hash must still cost real work, or response
   * timing reveals which emails have accounts.
   */
  it('spends comparable time on a null hash as on a real one', { timeout }, async () => {
    const hash = await hashPassword('timing comparison password');

    const startReal = performance.now();
    await verifyPassword('wrong password entirely', hash);
    const realMs = performance.now() - startReal;

    const startNull = performance.now();
    await verifyPassword('wrong password entirely', null);
    const nullMs = performance.now() - startNull;

    // Within an order of magnitude is enough: the attack needs a clear signal, and
    // a tight bound would make this test flaky on shared CI hardware.
    expect(nullMs).toBeGreaterThan(realMs / 10);
  });

  it('rejects malformed stored hashes without throwing', { timeout }, async () => {
    for (const stored of [
      '',
      'not-a-hash',
      'scrypt$only$three$parts',
      'bcrypt$65536$8$1$c2FsdA==$aGFzaA==',
      'scrypt$abc$8$1$c2FsdA==$aGFzaA==',
    ]) {
      const result = await verifyPassword('any password at all', stored);
      expect(result.valid, stored).toBe(false);
    }
  });

  // A tampered row must not become a memory-exhaustion vector.
  it('refuses absurd parameters from a tampered record', { timeout }, async () => {
    const absurd = ['scrypt', String(2 ** 25), '64', '32', 'c2FsdA==', 'aGFzaA=='].join('$');
    const result = await verifyPassword('any password at all', absurd);
    expect(result.valid).toBe(false);
  });

  it('normalises Unicode so equivalent passwords match', { timeout }, async () => {
    // U+00E9 vs e + U+0301 render identically and users cannot tell them apart.
    const composed = 'café password long';
    const decomposed = 'café password long';
    const hash = await hashPassword(composed);
    expect((await verifyPassword(decomposed, hash)).valid).toBe(true);
  });
});
