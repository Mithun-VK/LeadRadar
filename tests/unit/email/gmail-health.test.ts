import { describe, expect, it } from 'vitest';

import {
  BLOCKED_AFTER_CONSECUTIVE_FAILURES,
  resumeFrom,
} from '@/modules/email/gmail-health';

/**
 * `resumeFrom` is where the unbounded-lookback defect lived.
 *
 * The old code derived the resume point from the newest STORED inbound message,
 * which advances only when something matched. A mailbox receiving no matching
 * replies never advanced, so the query window grew by a day every day until
 * Gmail's quota refused it — at which point reply detection stopped silently.
 * These tests pin the clamp that makes that impossible.
 */
describe('resumeFrom', () => {
  const now = new Date('2026-06-01T12:00:00.000Z');
  const MAX = 30;
  const INITIAL = 7;

  it('uses the initial lookback when there is no cursor', () => {
    const from = resumeFrom(null, now, MAX, INITIAL);
    expect(from.toISOString()).toBe('2026-05-25T12:00:00.000Z');
  });

  it('resumes exactly from a recent cursor', () => {
    const cursor = new Date('2026-06-01T11:50:00.000Z');
    expect(resumeFrom(cursor, now, MAX, INITIAL).toISOString()).toBe(cursor.toISOString());
  });

  it('clamps an ancient cursor to the maximum lookback', () => {
    // The regression: six months of silence must not become a six-month query.
    const sixMonthsAgo = new Date('2025-12-01T12:00:00.000Z');
    const from = resumeFrom(sixMonthsAgo, now, MAX, INITIAL);

    expect(from.toISOString()).toBe('2026-05-02T12:00:00.000Z');
    const windowDays = (now.getTime() - from.getTime()) / 86_400_000;
    expect(windowDays).toBe(MAX);
  });

  it('never returns a window wider than the maximum, for any cursor age', () => {
    for (const daysAgo of [31, 60, 180, 365, 3650]) {
      const cursor = new Date(now.getTime() - daysAgo * 86_400_000);
      const windowDays = (now.getTime() - resumeFrom(cursor, now, MAX, INITIAL).getTime()) / 86_400_000;
      expect(windowDays).toBeLessThanOrEqual(MAX);
    }
  });

  it('recovers from a cursor in the future rather than querying nothing', () => {
    // Clock skew or a restored backup. Trusting it would mean `newer_than` selects
    // an empty window and replies are silently never seen.
    const future = new Date(now.getTime() + 86_400_000);
    expect(resumeFrom(future, now, MAX, INITIAL).toISOString()).toBe('2026-05-25T12:00:00.000Z');
  });

  it('is monotonic: a newer cursor never looks further back than an older one', () => {
    const older = resumeFrom(new Date(now.getTime() - 10 * 86_400_000), now, MAX, INITIAL);
    const newer = resumeFrom(new Date(now.getTime() - 2 * 86_400_000), now, MAX, INITIAL);
    expect(newer.getTime()).toBeGreaterThan(older.getTime());
  });

  it('does not drift forward past now', () => {
    const from = resumeFrom(new Date(now.getTime() - 1000), now, MAX, INITIAL);
    expect(from.getTime()).toBeLessThanOrEqual(now.getTime());
  });
});

describe('health thresholds', () => {
  it('does not treat a single failure as an outage', () => {
    // One timeout is ordinary internet weather. Blocking on it would have
    // campaigns stopping constantly, and an operator learning to ignore the state.
    expect(BLOCKED_AFTER_CONSECUTIVE_FAILURES).toBeGreaterThan(1);
  });

  it('blocks well before a mailbox could burn a day of quota', () => {
    expect(BLOCKED_AFTER_CONSECUTIVE_FAILURES).toBeLessThanOrEqual(10);
  });
});
