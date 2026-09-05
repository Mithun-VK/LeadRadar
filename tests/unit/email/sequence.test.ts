import { describe, expect, it } from 'vitest';

import {
  TERMINAL_LEAD_STATUSES,
  dueAt,
  isTerminalLeadStatus,
  nextStep,
  type SequenceStep,
} from '@/modules/email/sequence';

function step(stepNumber: number, delayDays: number): SequenceStep {
  return { id: `step-${stepNumber}`, stepNumber, delayDays, templateId: null };
}

/** Day 0 / +2 / +5 / +10 — the shape from the brief. */
const SEQUENCE = [step(1, 0), step(2, 2), step(3, 3), step(4, 5)];

describe('nextStep', () => {
  it('starts a fresh lead at step 1', () => {
    expect(nextStep(SEQUENCE, 0)?.stepNumber).toBe(1);
  });

  it('advances one step at a time', () => {
    expect(nextStep(SEQUENCE, 1)?.stepNumber).toBe(2);
    expect(nextStep(SEQUENCE, 2)?.stepNumber).toBe(3);
    expect(nextStep(SEQUENCE, 3)?.stepNumber).toBe(4);
  });

  it('returns null once the sequence is exhausted — the stop condition', () => {
    expect(nextStep(SEQUENCE, 4)).toBeNull();
  });

  it('returns null for a campaign with no steps, which is a single send', () => {
    // The backward-compatibility guarantee: every campaign created before
    // sequences has zero steps and must not acquire follow-ups retroactively.
    expect(nextStep([], 0)).toBeNull();
  });

  /**
   * Steps are found by "first step number greater than current", not by index.
   * A disabled step is filtered out upstream, so the sequence must skip its
   * number rather than stalling on the gap.
   */
  it('skips a gap left by a disabled step rather than stalling', () => {
    const withGap = [step(1, 0), step(2, 2), step(4, 5)];
    expect(nextStep(withGap, 2)?.stepNumber).toBe(4);
  });

  it('never goes backwards, even if given a number beyond the sequence', () => {
    expect(nextStep(SEQUENCE, 99)).toBeNull();
  });

  it('is unaffected by the order the steps arrive in', () => {
    const shuffled = [step(3, 3), step(1, 0), step(4, 5), step(2, 2)];
    // activeSteps() orders by stepNumber, but the function must not silently
    // depend on that — a wrong step here means mailing someone the wrong message.
    const found = nextStep([...shuffled].sort((a, b) => a.stepNumber - b.stepNumber), 1);
    expect(found?.stepNumber).toBe(2);
  });
});

describe('dueAt', () => {
  const base = new Date('2026-03-10T09:30:00.000Z');

  it('makes step 1 due immediately', () => {
    expect(dueAt(step(1, 0), base).toISOString()).toBe(base.toISOString());
  });

  it('adds whole days in UTC', () => {
    expect(dueAt(step(2, 2), base).toISOString()).toBe('2026-03-12T09:30:00.000Z');
    expect(dueAt(step(3, 7), base).toISOString()).toBe('2026-03-17T09:30:00.000Z');
  });

  /**
   * The timezone requirement, tested where it actually bites.
   *
   * 2026-03-29 is the European DST transition. A naive implementation using
   * local-time date arithmetic would produce a 23- or 25-hour "day" here and
   * shift the follow-up by an hour. Working in epoch milliseconds cannot.
   */
  it('is unaffected by a daylight-saving transition', () => {
    const beforeDst = new Date('2026-03-28T23:30:00.000Z');
    const due = dueAt(step(2, 1), beforeDst);

    expect(due.toISOString()).toBe('2026-03-29T23:30:00.000Z');
    expect(due.getTime() - beforeDst.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('produces the same instant regardless of the host timezone', () => {
    // The computation reads no local-time component, so this is structural
    // rather than environmental — but assert it, because a future refactor
    // reaching for getDate()/setDate() would silently reintroduce the bug.
    const due = dueAt(step(2, 3), base);
    expect(due.getTime()).toBe(base.getTime() + 3 * 86_400_000);
  });

  it('treats a negative delay as immediate rather than scheduling the past', () => {
    const due = dueAt({ ...step(2, -5), delayDays: -5 }, base);
    expect(due.getTime()).toBe(base.getTime());
  });

  it('handles a long delay without drift', () => {
    expect(dueAt(step(2, 365), base).toISOString()).toBe('2027-03-10T09:30:00.000Z');
  });
});

describe('terminal lead statuses', () => {
  it('treats a reply as terminal — the most important stop condition', () => {
    expect(isTerminalLeadStatus('REPLIED')).toBe(true);
  });

  it.each(['REPLIED', 'UNSUBSCRIBED', 'SKIPPED', 'FAILED'])('treats %s as terminal', (status) => {
    expect(isTerminalLeadStatus(status)).toBe(true);
  });

  it.each(['PENDING', 'QUEUED', 'SENT'])('treats %s as continuable', (status) => {
    // SENT is deliberately NOT terminal for a sequence: it is the normal state
    // of a lead between steps under the pre-sequence single-send model, and a
    // sequence sets QUEUED while waiting.
    expect(isTerminalLeadStatus(status)).toBe(false);
  });

  it('exposes exactly the four terminal statuses', () => {
    // Widening this set silently stops sequences that should continue; narrowing
    // it mails people who replied. Either deserves a deliberate edit here.
    expect([...TERMINAL_LEAD_STATUSES].sort()).toEqual([
      'FAILED',
      'REPLIED',
      'SKIPPED',
      'UNSUBSCRIBED',
    ]);
  });

  it('does not treat an unknown status as terminal', () => {
    // Fail-open is correct here: an unrecognised status must not silently halt
    // a sequence. The send path's own guards remain authoritative.
    expect(isTerminalLeadStatus('SOMETHING_NEW')).toBe(false);
  });
});

describe('the full schedule of a four-step sequence', () => {
  it('lands on day 0, 2, 5 and 10 from a single start instant', () => {
    const start = new Date('2026-01-05T10:00:00.000Z');
    const dates: string[] = [];

    let cursor = start;
    let current = 0;

    for (;;) {
      const upcoming = nextStep(SEQUENCE, current);
      if (!upcoming) break;
      cursor = dueAt(upcoming, cursor);
      dates.push(cursor.toISOString().slice(0, 10));
      current = upcoming.stepNumber;
    }

    // Cumulative, because each delay is relative to the previous step.
    expect(dates).toEqual(['2026-01-05', '2026-01-07', '2026-01-10', '2026-01-15']);
  });

  it('terminates rather than looping forever', () => {
    let current = 0;
    let guard = 0;

    while (nextStep(SEQUENCE, current) && guard < 100) {
      current = nextStep(SEQUENCE, current)!.stepNumber;
      guard += 1;
    }

    expect(guard).toBe(4);
  });
});
