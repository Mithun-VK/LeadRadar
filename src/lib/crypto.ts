/**
 * Symmetric encryption for secrets held at rest.
 *
 * Exists for one thing above all: a Gmail refresh token is a long-lived
 * credential to a person's mailbox. Stored in plaintext, a database leak does not
 * merely expose data — it hands an attacker the ability to *send mail as the
 * user*, from their real address, to anyone. That is a materially worse outcome
 * than the leak itself, and it is why these tokens are encrypted with a key that
 * lives outside the database.
 *
 * ---------------------------------------------------------------------------
 * DESIGN
 * ---------------------------------------------------------------------------
 *
 * AES-256-GCM, which is authenticated: tampering with the ciphertext fails
 * decryption loudly rather than yielding altered plaintext. A random 96-bit IV
 * per encryption, because reusing an IV under the same key catastrophically
 * breaks GCM — it is not a gradual weakening but a total loss of confidentiality
 * and authenticity for the affected messages.
 *
 * Additional authenticated data (AAD) binds each ciphertext to its purpose, so a
 * value encrypted as a refresh token cannot be moved into a field expecting
 * something else and still decrypt. That turns a whole class of database-level
 * substitution attacks into a decryption failure.
 *
 * The stored format is self-describing and versioned, so the algorithm can be
 * migrated later without guessing what an existing row contains.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
  createHash,
} from 'node:crypto';

import { env } from './env';
import { AppError } from './errors';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
/** Stored prefix, so a future algorithm change is unambiguous rather than inferred. */
const FORMAT_VERSION = 'v1';

/**
 * A well-known, deliberately non-secret development key.
 *
 * Development and test must boot with no configuration — that is what makes mock
 * mode a first-class runtime mode rather than a test shim. Production is a
 * different matter: `env()` already refuses to boot without a real
 * `ENCRYPTION_KEY`, and `resolveKey` refuses again here, so this constant can
 * never protect real data.
 */
const DEVELOPMENT_KEY_HEX = '00'.repeat(KEY_BYTES);

function resolveKey(): Buffer {
  const config = env();
  const configured = config.ENCRYPTION_KEY;

  if (!configured) {
    if (config.isProduction) {
      // Belt and braces: env() enforces this too. Two independent refusals,
      // because silently encrypting production tokens under a public constant
      // would be indistinguishable from not encrypting them at all.
      throw new AppError({
        code: 'CONFIG_INVALID',
        message: 'ENCRYPTION_KEY is required in production to encrypt stored credentials',
      });
    }
    return Buffer.from(DEVELOPMENT_KEY_HEX, 'hex');
  }

  const key = Buffer.from(configured, 'hex');
  if (key.length !== KEY_BYTES) {
    throw new AppError({
      code: 'CONFIG_INVALID',
      message: `ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}`,
    });
  }
  return key;
}

/** True when only the public development key is available. */
export function usingDevelopmentKey(): boolean {
  return !env().ENCRYPTION_KEY;
}

/**
 * Encrypts a secret.
 *
 * `purpose` is bound into the ciphertext as AAD. Pass a stable, specific string
 * such as `'gmail.refresh_token'`; decryption with a different purpose fails.
 */
export function encryptSecret(plaintext: string, purpose: string): string {
  if (plaintext === '') {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'Refusing to encrypt an empty secret',
    });
  }

  const key = resolveKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(purpose, 'utf8'));

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    FORMAT_VERSION,
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    tag.toString('base64url'),
  ].join('.');
}

/**
 * Decrypts a secret.
 *
 * Throws on any tampering, on a key mismatch, or on a purpose mismatch. Callers
 * should treat a failure as "this credential is unusable" — typically by marking
 * the account invalidated rather than retrying, since neither the key nor the
 * stored bytes will change on a second attempt.
 */
export function decryptSecret(encoded: string, purpose: string): string {
  const parts = encoded.split('.');
  if (parts.length !== 4 || parts[0] !== FORMAT_VERSION) {
    throw new AppError({
      code: 'CONFIG_INVALID',
      message: 'Stored secret is not in the expected encrypted format',
    });
  }

  const [, ivPart, ciphertextPart, tagPart] = parts as [string, string, string, string];

  let iv: Buffer;
  let ciphertext: Buffer;
  let tag: Buffer;
  try {
    iv = Buffer.from(ivPart, 'base64url');
    ciphertext = Buffer.from(ciphertextPart, 'base64url');
    tag = Buffer.from(tagPart, 'base64url');
  } catch {
    throw new AppError({ code: 'CONFIG_INVALID', message: 'Stored secret could not be decoded' });
  }

  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new AppError({ code: 'CONFIG_INVALID', message: 'Stored secret has malformed framing' });
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, resolveKey(), iv);
    decipher.setAAD(Buffer.from(purpose, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // The underlying error distinguishes tampering from a wrong key, which is
    // information an attacker probing the store should not receive.
    throw new AppError({
      code: 'CONFIG_INVALID',
      message:
        'Stored secret failed authentication; it was tampered with or encrypted under a different key',
    });
  }
}

/** Purposes used across the app, named once so a typo cannot silently diverge. */
export const SECRET_PURPOSE = {
  gmailRefreshToken: 'gmail.refresh_token',
  gmailAccessToken: 'gmail.access_token',
  oauthState: 'oauth.state',
} as const;

/**
 * Stable hash for lookup and uniqueness.
 *
 * Used for suppression-list keys, where the question is only ever "is this exact
 * normalised address present?". SHA-256 without stretching is correct here: the
 * input space is not secret and the goal is a deterministic index key, not
 * resistance to offline cracking.
 */
export function hashForLookup(value: string): string {
  return createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}

/** Constant-time comparison, for tokens supplied by a client. */
export function constantTimeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

/** URL-safe random token, for unsubscribe links and OAuth state. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
