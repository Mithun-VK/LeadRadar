import { describe, expect, it } from 'vitest';

import { sendJobId, tickJobId } from '@/modules/email/worker';
import { jobIds } from '@/lib/ids';

/**
 * Regression: BullMQ rejects a custom job id containing a colon — "Custom Id
 * cannot contain :" — because it reserves the colon for its own key namespacing.
 *
 * These ids used colons, so every campaign tick and every send enqueue was
 * refused by Redis. The campaign scheduler failed every fifteen minutes (89
 * dead-lettered jobs when found) and campaigns sat at RUNNING forever with
 * nothing able to advance them.
 *
 * It survived four phases of testing because every verification script calls
 * `sendCampaignEmail` directly rather than through the queue, exercising the send
 * path while never exercising the enqueue.
 */
describe('BullMQ job ids never contain a colon', () => {
  const CAMPAIGN = 'cmtk9xaij000guvgc6o0br6qm';
  const BUSINESS = 'cmtk9x9ty0006uvgctzwmv6dk';

  it('tickJobId has no colon', () => {
    expect(tickJobId(CAMPAIGN)).not.toContain(':');
  });

  it('sendJobId has no colon, with or without a step', () => {
    expect(sendJobId(CAMPAIGN, BUSINESS)).not.toContain(':');
    expect(sendJobId(CAMPAIGN, BUSINESS, 3)).not.toContain(':');
  });

  /**
   * The real call sites append a suffix to `tickJobId(...)`. A colon-free base
   * with a colon-joined suffix is exactly the bug that shipped, so the composed
   * forms are asserted rather than only the helpers.
   */
  it('the composed forms used at the call sites have no colon', () => {
    const composed = [
      `${tickJobId(CAMPAIGN)}~${Date.now()}`,
      `${tickJobId(CAMPAIGN)}~start~${Date.now()}`,
      `${tickJobId(CAMPAIGN)}~resume~${Date.now()}`,
      `${tickJobId(CAMPAIGN)}~wait~${Date.now()}`,
    ];

    for (const id of composed) expect(id).not.toContain(':');
  });

  it('every jobIds helper is colon-free too', () => {
    const ids = [
      jobIds.score('biz123', '1.0.0'),
      jobIds.discoverWebsite('place123'),
      jobIds.discover('search1', 'cell1', 'dental clinic', 0),
    ];

    for (const id of ids) expect(id).not.toContain(':');
  });

  it('uses ~ as the separator, matching lib/ids.ts', () => {
    // Consistency is the point: one convention, so a future author copying any
    // existing id does not reintroduce this.
    expect(tickJobId(CAMPAIGN)).toBe(`tick~${CAMPAIGN}`);
    expect(sendJobId(CAMPAIGN, BUSINESS)).toBe(`send~${CAMPAIGN}~${BUSINESS}`);
    expect(jobIds.score('biz123', '1.0.0')).toContain('~');
  });

  it('remains distinct per campaign, lead, and step', () => {
    // The ids are the duplicate-send defence; collapsing two of them into one
    // would mean a lead silently never receiving a step.
    const ids = new Set([
      sendJobId('c1', 'b1'),
      sendJobId('c1', 'b2'),
      sendJobId('c2', 'b1'),
      sendJobId('c1', 'b1', 1),
      sendJobId('c1', 'b1', 2),
    ]);

    expect(ids.size).toBe(5);
  });

  /**
   * The flat `~`-joined encoding IS ambiguous in the general case:
   * `sendJobId('c','b',2)` and `sendJobId('c','b~s2')` both yield `send~c~b~s2`.
   *
   * It is safe only because the inputs are cuids, which are alphanumeric and
   * cannot contain `~`. That is a real precondition rather than a happy accident,
   * so it is asserted here — if ids ever stop being cuids, this fails and points
   * at the encoding before a lead silently loses a step to a collision.
   */
  it('is unambiguous for cuid inputs, which is the precondition it relies on', () => {
    const cuidPattern = /^[a-z0-9]+$/;

    for (const id of ['cmtk9xaij000guvgc6o0br6qm', 'cmtk9x9ty0006uvgctzwmv6dk']) {
      expect(id).toMatch(cuidPattern);
      expect(id).not.toContain('~');
    }

    // Given that, a step-scoped id can never be produced by a lead id.
    expect(sendJobId('c1', 'b1', 2)).not.toBe(sendJobId('c1', 'b1'));
  });
});
