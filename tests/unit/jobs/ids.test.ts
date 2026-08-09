import { describe, expect, it } from 'vitest';

import { fingerprint, jobIds, normalizeDomain, requestId, runId } from '@/lib/ids';

/**
 * BullMQ rejects a custom job id containing ':' — it reserves the colon for its own
 * Redis key namespacing, and the rejection happens at enqueue time, not compile
 * time. This suite exists because that bug reached runtime once.
 */
describe('job ids — BullMQ compatibility', () => {
  const samples = [
    jobIds.discover('job_abc123', 'cell_def456', 'dental clinic', 0),
    jobIds.discoverWebsite('ChIJmockplace0001'),
    jobIds.verifyWebsite('ChIJmockplace0001', 'srikrishnadental.in'),
    jobIds.fetchPage('https://example.com/contact'),
    jobIds.score('biz_xyz789', '1.0.0'),
    jobIds.export('exp_123'),
  ];

  for (const id of samples) {
    it(`contains no colon: ${id.slice(0, 40)}`, () => {
      expect(id).not.toContain(':');
    });
  }

  it('uses only characters safe in a Redis key segment', () => {
    for (const id of samples) {
      expect(id).toMatch(/^[A-Za-z0-9~._-]+$/);
    }
  });

  it('stays within a sane length', () => {
    for (const id of samples) {
      expect(id.length).toBeLessThan(200);
    }
  });
});

describe('job ids — determinism and idempotency', () => {
  // Determinism is what makes retries and replays free: BullMQ collapses duplicate
  // ids, so re-running a search cannot re-spend the API budget.
  it('produces the same id for the same inputs', () => {
    expect(jobIds.discover('j1', 'c1', 'cafe', 0)).toBe(jobIds.discover('j1', 'c1', 'cafe', 0));
    expect(jobIds.discoverWebsite('place-1')).toBe(jobIds.discoverWebsite('place-1'));
    expect(jobIds.score('biz-1', '1.0.0')).toBe(jobIds.score('biz-1', '1.0.0'));
  });

  it('distinguishes different inputs', () => {
    expect(jobIds.discover('j1', 'c1', 'cafe', 0)).not.toBe(jobIds.discover('j1', 'c1', 'cafe', 1));
    expect(jobIds.discover('j1', 'c1', 'cafe', 0)).not.toBe(
      jobIds.discover('j1', 'c2', 'cafe', 0),
    );
    expect(jobIds.discover('j1', 'c1', 'cafe', 0)).not.toBe(
      jobIds.discover('j1', 'c1', 'dental clinic', 0),
    );
  });

  /**
   * A weights change must recompute every score, while an unchanged configuration
   * must never re-run — which is exactly what including the version achieves.
   */
  it('changes the score id when the signals version changes', () => {
    expect(jobIds.score('biz-1', '1.0.0')).not.toBe(jobIds.score('biz-1', '1.1.0'));
  });

  it('separates verification by both place and domain', () => {
    expect(jobIds.verifyWebsite('p1', 'a.com')).not.toBe(jobIds.verifyWebsite('p1', 'b.com'));
    expect(jobIds.verifyWebsite('p1', 'a.com')).not.toBe(jobIds.verifyWebsite('p2', 'a.com'));
  });
});

describe('fingerprint', () => {
  it('is stable and hex', () => {
    expect(fingerprint('a', 'b')).toBe(fingerprint('a', 'b'));
    expect(fingerprint('a', 'b')).toMatch(/^[0-9a-f]{24}$/);
  });

  // Without a separator, ('ab','c') and ('a','bc') would collide and two different
  // jobs would silently deduplicate into one.
  it('does not collide across different part boundaries', () => {
    expect(fingerprint('ab', 'c')).not.toBe(fingerprint('a', 'bc'));
  });

  it('handles null and undefined parts', () => {
    expect(() => fingerprint(null, undefined, 'x')).not.toThrow();
    expect(fingerprint(null, 'x')).not.toBe(fingerprint('x', null));
  });
});

describe('correlation ids', () => {
  it('are prefixed and unique', () => {
    expect(requestId()).toMatch(/^req_/);
    expect(runId()).toMatch(/^run_/);
    expect(requestId()).not.toBe(requestId());
  });
});

describe('normalizeDomain (ids re-export)', () => {
  it('canonicalises consistently with the leads normaliser', () => {
    expect(normalizeDomain('https://WWW.Example.com/path')).toBe('example.com');
  });
});
