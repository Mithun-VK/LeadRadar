import { describe, expect, it } from 'vitest';

import {
  MIN_REPLIES_FOR_DIRECTION,
  MIN_REPLIES_FOR_MODEL,
  MIN_SEGMENT_SAMPLE,
  MIN_WINS_FOR_REVENUE,
  computeLift,
} from '@/modules/analytics/intelligence';
import { MIN_BUCKET_SAMPLE, SCORE_BUCKETS } from '@/modules/analytics/calibration';

/**
 * Lift is the number that decides whether the score is worth having. A lift of
 * 1.0 means it sorts leads no better than shuffling them, and a scoring model
 * that adds nothing is worse than none — everyone downstream trusts it.
 */
describe('computeLift', () => {
  it('reports a real edge when the top bucket outperforms', () => {
    // Top bucket 20%, population 10% -> 2x.
    const lift = computeLift(20, 100, 50, 500);

    expect(lift.replyLift).toBe(2);
    expect(lift.topBucketReplyRate).toBe(0.2);
    expect(lift.baselineReplyRate).toBe(0.1);
    expect(lift.interpretation).toMatch(/earning its place/i);
  });

  it('says plainly when the score is not sorting usefully', () => {
    const lift = computeLift(10, 100, 50, 500);

    expect(lift.replyLift).toBe(1);
    expect(lift.interpretation).toMatch(/about the same as average|not currently sorting/i);
  });

  it('flags an INVERTED score rather than reporting a small positive number', () => {
    // The top bucket doing worse than average is the most important finding this
    // can produce, and it must not read as merely "modest".
    const lift = computeLift(2, 100, 50, 500);

    expect(lift.replyLift).toBeLessThan(1);
    expect(lift.interpretation).toMatch(/WORSE than average|inverted/i);
  });

  it('returns null rather than a number when nothing was contacted', () => {
    const lift = computeLift(0, 0, 0, 0);

    expect(lift.replyLift).toBeNull();
    expect(lift.interpretation).toMatch(/not computable/i);
  });

  it('returns null when nobody has replied, instead of dividing by zero', () => {
    const lift = computeLift(0, 100, 0, 500);

    expect(lift.replyLift).toBeNull();
    expect(lift.baselineReplyRate).toBe(0);
    expect(lift.interpretation).toMatch(/no baseline to beat/i);
  });

  it('handles a top bucket smaller than the sample without exploding', () => {
    const lift = computeLift(1, 1, 50, 500);
    expect(lift.replyLift).toBe(10);
  });
});

/**
 * The thresholds encode a judgement about how much evidence a claim needs. They
 * are asserted because the failure mode of "tuning" them is a confident report
 * built on noise.
 */
describe('sufficiency thresholds', () => {
  it('measures readiness in positive outcomes, not lead volume', () => {
    // A large unengaged list must not satisfy the bar. Replies are the binding
    // constraint because they are what the score is trying to predict.
    expect(MIN_REPLIES_FOR_DIRECTION).toBeGreaterThanOrEqual(20);
  });

  it('requires far more evidence to fit a model than to read a direction', () => {
    // Roughly the ten-events-per-feature convention, against a model with three
    // factors and a dozen flags.
    expect(MIN_REPLIES_FOR_MODEL).toBeGreaterThanOrEqual(MIN_REPLIES_FOR_DIRECTION * 5);
  });

  it('requires won deals before claiming anything about revenue', () => {
    expect(MIN_WINS_FOR_REVENUE).toBeGreaterThanOrEqual(5);
  });

  it('holds segments to the same evidentiary bar as score buckets', () => {
    expect(MIN_SEGMENT_SAMPLE).toBe(MIN_BUCKET_SAMPLE);
  });
});

describe('score buckets', () => {
  it('cover 0–100 with no gaps and no overlaps', () => {
    const ordered = [...SCORE_BUCKETS].sort((a, b) => a.min - b.min);

    expect(ordered[0]!.min).toBe(0);
    expect(ordered[ordered.length - 1]!.max).toBe(100);

    for (let i = 1; i < ordered.length; i += 1) {
      // A gap would silently drop leads from calibration; an overlap would
      // double-count them. Either makes every rate wrong.
      expect(ordered[i]!.min).toBe(ordered[i - 1]!.max + 1);
    }
  });

  it('assigns every possible score to exactly one bucket', () => {
    for (const score of [0, 39, 40, 59, 60, 79, 80, 100]) {
      const matches = SCORE_BUCKETS.filter((b) => score >= b.min && score <= b.max);
      expect(matches).toHaveLength(1);
    }
  });
});
