import { beforeEach, describe, expect, it } from 'vitest';

import {
  createOAuthState,
  resetStateSecretCache,
  verifyOAuthState,
} from '@/modules/email/gmail-account';

const ORG = 'org_alpha';
const OTHER_ORG = 'org_beta';
const USER = 'user_1';

describe('OAuth state', () => {
  beforeEach(() => {
    resetStateSecretCache();
  });

  it('round-trips for the issuing organization', () => {
    const state = createOAuthState(ORG, USER);
    const verified = verifyOAuthState(state, ORG);

    expect(verified.organizationId).toBe(ORG);
    expect(verified.userId).toBe(USER);
  });

  it('rejects a state issued for a different organization', () => {
    /**
     * The attack this prevents: an attacker starts the OAuth flow themselves,
     * then induces a victim to load the callback with the attacker's code and
     * state. Without this check the attacker's mailbox gets attached to the
     * victim's organization, and every campaign afterwards sends from it.
     */
    const state = createOAuthState(OTHER_ORG, USER);
    expect(() => verifyOAuthState(state, ORG)).toThrow(/organization mismatch/i);
  });

  it('rejects a tampered payload', () => {
    const state = createOAuthState(ORG, USER);
    const [payload, signature] = state.split('.') as [string, string];

    const forged = Buffer.from(
      `${OTHER_ORG}.${USER}.${Date.now().toString(36)}.nonce`,
      'utf8',
    ).toString('base64url');

    expect(() => verifyOAuthState(`${forged}.${signature}`, OTHER_ORG)).toThrow();
    // The original still verifies, so the rejection was about the tampering.
    expect(() => verifyOAuthState(`${payload}.${signature}`, ORG)).not.toThrow();
  });

  it('rejects a tampered signature', () => {
    const state = createOAuthState(ORG, USER);
    const [payload] = state.split('.') as [string, string];

    expect(() => verifyOAuthState(`${payload}.notasignature`, ORG)).toThrow();
  });

  it('rejects a malformed state', () => {
    for (const value of ['', 'x', 'a.b.c', 'not-base64url.$$$']) {
      expect(() => verifyOAuthState(value, ORG)).toThrow();
    }
  });

  it('produces a different state each time, so one cannot be replayed as another', () => {
    const first = createOAuthState(ORG, USER);
    const second = createOAuthState(ORG, USER);

    expect(first).not.toBe(second);
  });

  it('does not expose the organization id in plain text', () => {
    // Base64url-encoded rather than encrypted, so this is a modest property —
    // but the value should not be trivially readable in a browser URL bar.
    const state = createOAuthState(ORG, USER);
    expect(state).not.toContain(ORG);
  });

  it('carries the user who initiated the flow, for the audit trail', () => {
    expect(verifyOAuthState(createOAuthState(ORG, USER), ORG).userId).toBe(USER);
  });
});
