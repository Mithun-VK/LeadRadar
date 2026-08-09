/**
 * Password hashing.
 *
 * Uses Node's built-in scrypt rather than adding argon2 or bcrypt. scrypt is
 * memory-hard, is in the standard library (no native build step, no supply-chain
 * surface for the most security-critical dependency in the app), and is explicitly
 * recommended by OWASP for password storage. The parameters below exceed OWASP's
 * minimum.
 *
 * Format: `scrypt$N$r$p$<salt-b64>$<hash-b64>`. Parameters are stored WITH the
 * hash so they can be raised later without invalidating existing passwords — an
 * old hash still verifies under its own parameters and is silently upgraded on the
 * next successful sign-in.
 */
import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';

/**
 * Hand-rolled rather than `promisify(scrypt)`: promisify erases the four-argument
 * overload that accepts options, and the options are where N, r, and maxmem live —
 * i.e. the entire security parameterisation.
 */
function scrypt(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

/**
 * N=2^16 with r=8 uses roughly 64 MB per hash. Deliberately expensive: it bounds
 * offline cracking if the database leaks, and a login is rare enough that ~100ms
 * is invisible to a user.
 */
const PARAMS = { N: 65_536, r: 8, p: 1, keyLength: 64, saltLength: 16 } as const;

/** scrypt needs maxmem raised above the default to allow N=2^16. */
const MAX_MEM = 128 * PARAMS.N * PARAMS.r * 2;

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

export interface PasswordPolicyResult {
  readonly ok: boolean;
  readonly problems: readonly string[];
}

/**
 * Password policy.
 *
 * Length over composition rules: NIST and OWASP both moved away from mandatory
 * character classes, which push users toward predictable substitutions ("P@ssw0rd!")
 * without adding real entropy. A 12-character minimum plus a common-password
 * rejection is stronger and less annoying.
 */
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', '123456789012', 'qwertyuiop12',
  'administrator', 'letmein12345', 'welcome12345', 'iloveyou1234', 'changeme123',
  'leadradar123', 'passw0rd1234', 'trustno112345', 'monkey123456', 'dragon123456',
]);

export function checkPasswordPolicy(password: string, email?: string): PasswordPolicyResult {
  const problems: string[] = [];

  if (password.length < PASSWORD_MIN_LENGTH) {
    problems.push(`Must be at least ${PASSWORD_MIN_LENGTH} characters.`);
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    problems.push(`Must be at most ${PASSWORD_MAX_LENGTH} characters.`);
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    problems.push('That password is too common.');
  }
  // A password containing the local part of the email is trivially guessable.
  const localPart = email?.split('@')[0]?.toLowerCase();
  if (localPart && localPart.length >= 4 && password.toLowerCase().includes(localPart)) {
    problems.push('Must not contain your email address.');
  }
  if (/^(.)\1+$/.test(password)) {
    problems.push('Must not be a single repeated character.');
  }

  return { ok: problems.length === 0, problems };
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(PARAMS.saltLength);
  const derived = await scrypt(password.normalize('NFKC'), salt, PARAMS.keyLength, {
    N: PARAMS.N,
    r: PARAMS.r,
    p: PARAMS.p,
    maxmem: MAX_MEM,
  });

  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

interface ParsedHash {
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly salt: Buffer;
  readonly hash: Buffer;
}

function parseHash(stored: string): ParsedHash | null {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
  // Refuse absurd parameters from a tampered row: they would be a memory DoS.
  if (N > 2 ** 20 || r > 32 || p > 16) return null;

  try {
    return {
      N,
      r,
      p,
      salt: Buffer.from(parts[4]!, 'base64'),
      hash: Buffer.from(parts[5]!, 'base64'),
    };
  } catch {
    return null;
  }
}

export interface VerifyResult {
  readonly valid: boolean;
  /** True when the stored hash used weaker parameters and should be re-hashed. */
  readonly needsRehash: boolean;
}

/**
 * Verifies a password in constant time with respect to the hash contents.
 *
 * A null or malformed stored hash still performs a dummy derivation before
 * returning false, so "no such user" and "wrong password" take comparable time and
 * the endpoint cannot be used to enumerate accounts.
 */
export async function verifyPassword(
  password: string,
  stored: string | null,
): Promise<VerifyResult> {
  const parsed = stored ? parseHash(stored) : null;

  if (!parsed) {
    // Burn equivalent work so timing does not disclose account existence.
    await scrypt(password.normalize('NFKC'), randomBytes(PARAMS.saltLength), PARAMS.keyLength, {
      N: PARAMS.N,
      r: PARAMS.r,
      p: PARAMS.p,
      maxmem: MAX_MEM,
    });
    return { valid: false, needsRehash: false };
  }

  const derived = await scrypt(password.normalize('NFKC'), parsed.salt, parsed.hash.length, {
    N: parsed.N,
    r: parsed.r,
    p: parsed.p,
    maxmem: 128 * parsed.N * parsed.r * 2,
  });

  // Length check first: timingSafeEqual throws on a length mismatch.
  const valid =
    derived.length === parsed.hash.length && timingSafeEqual(derived, parsed.hash);

  return {
    valid,
    needsRehash: valid && (parsed.N < PARAMS.N || parsed.r < PARAMS.r),
  };
}
