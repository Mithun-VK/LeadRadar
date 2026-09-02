import { describe, expect, it } from 'vitest';

import {
  SKIP_REASON_LABELS,
  assertTransition,
  canTransition,
  type CampaignStatus,
} from '@/modules/email/campaigns';
import { MockEmailSendProvider } from '@/modules/providers/mock/email';
import { buildMimeMessage } from '@/modules/email/mime';

const ALL_STATUSES: CampaignStatus[] = [
  'DRAFT',
  'READY',
  'RUNNING',
  'PAUSED',
  'COMPLETED',
  'CANCELLED',
];

describe('campaign status transitions', () => {
  it('allows the normal path from draft to running to completed', () => {
    expect(canTransition('DRAFT', 'READY')).toBe(true);
    expect(canTransition('READY', 'RUNNING')).toBe(true);
    expect(canTransition('RUNNING', 'COMPLETED')).toBe(true);
  });

  it('allows pausing and resuming a running campaign', () => {
    expect(canTransition('RUNNING', 'PAUSED')).toBe(true);
    expect(canTransition('PAUSED', 'RUNNING')).toBe(true);
  });

  it('treats COMPLETED as terminal', () => {
    // Restarting would re-send to leads already contacted, and the operator
    // would discover that one duplicate-rejection at a time.
    for (const target of ALL_STATUSES) {
      expect(canTransition('COMPLETED', target)).toBe(false);
    }
  });

  it('treats CANCELLED as terminal', () => {
    for (const target of ALL_STATUSES) {
      expect(canTransition('CANCELLED', target)).toBe(false);
    }
  });

  it('allows a draft to be activated directly', () => {
    /**
     * This assertion previously expected `false`, encoding a real bug: nothing in
     * the product ever set READY, so requiring DRAFT -> READY -> RUNNING meant no
     * campaign could be activated at all. The runtime verification caught it.
     *
     * The safety gate is `assessReadiness`, enforced inside `activateCampaign`
     * independently of this table — a campaign with no mailbox, no template, or
     * no deliverable leads is still refused.
     */
    expect(canTransition('DRAFT', 'RUNNING')).toBe(true);
  });

  it('throws with an explanation rather than a bare boolean', () => {
    expect(() => assertTransition('COMPLETED', 'RUNNING')).toThrow(/completed/i);
  });

  it('permits cancelling from every non-terminal state', () => {
    for (const from of ['DRAFT', 'READY', 'RUNNING', 'PAUSED'] as CampaignStatus[]) {
      expect(canTransition(from, 'CANCELLED')).toBe(true);
    }
  });
});

describe('skip reasons', () => {
  it('has a human-readable label for every reason', () => {
    for (const [reason, label] of Object.entries(SKIP_REASON_LABELS)) {
      expect(label.length).toBeGreaterThan(10);
      expect(label).not.toBe(reason);
    }
  });
});

describe('MockEmailSendProvider', () => {
  function mime(to: string): string {
    return buildMimeMessage({
      to,
      from: 'me@agency.in',
      subject: 'Test',
      body: 'Hello',
      unsubscribeUrl: 'https://app.example/unsubscribe/x',
      messageId: 'x@app.example',
    });
  }

  /**
   * Regression: the verification scripts mint a fresh address per run
   * (`good-<uuid>@verify-example.in`). Against the probabilistic failure branch
   * that made `verify:outreach` fail roughly one run in seventeen for no product
   * reason — observed as PROVIDER_UNAVAILABLE on an address hashing to 0.9607.
   *
   * The addresses below are chosen to hash ABOVE the 0.94 threshold, so this
   * test genuinely reproduces the original failure if the reserved domain
   * regresses, rather than passing by luck.
   */
  describe('reserved verification domain is deterministic', () => {
    // Verified to hash above 0.94: 0.9503, 0.9558, 0.9949, 0.9793 respectively.
    // Without the reserved-domain branch every one of these returns
    // PROVIDER_UNAVAILABLE, so this list is the actual guard on the bug.
    const aboveThreshold = ['good-2f', 'good-30', 'good-3c', 'revenue-46'];

    it.each(aboveThreshold)('accepts %s@verify-example.in despite its hash', async (local) => {
      const provider = new MockEmailSendProvider();
      const to = `${local}@verify-example.in`;
      const result = await provider.send({ accessToken: 't', mime: mime(to), to });

      expect(result.ok).toBe(true);
    });

    it('accepts every address on the reserved domain across many samples', async () => {
      const provider = new MockEmailSendProvider();

      for (let i = 0; i < 400; i += 1) {
        const to = `good-${i.toString(16)}@verify-example.in`;
        const result = await provider.send({ accessToken: 't', mime: mime(to), to });
        if (!result.ok) {
          throw new Error(`reserved domain rejected ${to}: ${result.error.code}`);
        }
      }
    });

    it('still bounces an explicit failure prefix on the reserved domain', async () => {
      // Determinism must mean "the address states the outcome", not "everything
      // succeeds" — otherwise the failure paths become untestable there.
      const provider = new MockEmailSendProvider();
      const to = 'bounce@verify-example.in';
      const result = await provider.send({ accessToken: 't', mime: mime(to), to });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.isRetryable).toBe(false);
    });

    it('leaves ordinary domains subject to the probabilistic failure', async () => {
      // The realism that justifies the failure branch must survive the fix.
      const provider = new MockEmailSendProvider();
      let failures = 0;

      for (let i = 0; i < 600; i += 1) {
        const to = `user-${i}@ordinary-example.in`;
        const result = await provider.send({ accessToken: 't', mime: mime(to), to });
        if (!result.ok) failures += 1;
      }

      expect(failures).toBeGreaterThan(0);
    });
  });

  it('accepts an ordinary recipient and records it in the outbox', async () => {
    const provider = new MockEmailSendProvider();
    const result = await provider.send({
      accessToken: 'token',
      mime: mime('owner@clinic.in'),
      to: 'owner@clinic.in',
    });

    expect(result.ok).toBe(true);
    expect(provider.sentMessages()).toHaveLength(1);
  });

  it('delivers nowhere — the message stays in process', async () => {
    const provider = new MockEmailSendProvider();
    await provider.send({ accessToken: 't', mime: mime('a@b.in'), to: 'a@b.in' });

    expect(provider.sentMessages()[0]!.to).toBe('a@b.in');
    provider.clear();
    expect(provider.sentMessages()).toEqual([]);
  });

  it('fails permanently for a bounce address, so the failure path is exercisable', async () => {
    const provider = new MockEmailSendProvider();
    const result = await provider.send({
      accessToken: 't',
      mime: mime('bounce@clinic.in'),
      to: 'bounce@clinic.in',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.isRetryable).toBe(false);
  });

  it('simulates a rate limit for a designated address', async () => {
    const provider = new MockEmailSendProvider();
    const result = await provider.send({
      accessToken: 't',
      mime: mime('ratelimit@clinic.in'),
      to: 'ratelimit@clinic.in',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PROVIDER_RATE_LIMITED');
  });

  it('behaves deterministically for the same address, so tests are not flaky', async () => {
    const a = new MockEmailSendProvider();
    const b = new MockEmailSendProvider();

    const first = await a.send({ accessToken: 't', mime: mime('x@y.in'), to: 'x@y.in' });
    const second = await b.send({ accessToken: 't', mime: mime('x@y.in'), to: 'x@y.in' });

    expect(first.ok).toBe(second.ok);
  });

  it('omits the refresh token on refresh, matching Google', async () => {
    // The behaviour that makes the "do not overwrite with null" logic testable.
    const provider = new MockEmailSendProvider();
    const result = await provider.refreshAccessToken('mock-refresh-token');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.refreshToken).toBeNull();
  });

  it('rejects an unknown refresh token permanently', async () => {
    const provider = new MockEmailSendProvider();
    const result = await provider.refreshAccessToken('some-other-token');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.isRetryable).toBe(false);
  });

  it('issues a refresh token on the initial code exchange', async () => {
    const provider = new MockEmailSendProvider();
    const result = await provider.exchangeCode('mock-authorization-code');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.refreshToken).toBe('mock-refresh-token');
  });

  it('grants the send scope', async () => {
    const provider = new MockEmailSendProvider();
    const result = await provider.exchangeCode('code');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.scopes.some((s) => s.endsWith('/gmail.send'))).toBe(true);
    }
  });

  it('bounds the outbox so a long-running worker cannot grow without limit', async () => {
    const provider = new MockEmailSendProvider();

    for (let i = 0; i < 600; i += 1) {
      await provider.send({
        accessToken: 't',
        mime: mime(`user${i}@clinic.in`),
        to: `user${i}@clinic.in`,
      });
    }

    expect(provider.sentMessages().length).toBeLessThanOrEqual(500);
  });

  it('identifies itself as a mock', () => {
    expect(new MockEmailSendProvider().isMock).toBe(true);
  });
});
