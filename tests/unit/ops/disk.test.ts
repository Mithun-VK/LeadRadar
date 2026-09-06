import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DISK_CRITICAL_BYTES,
  DISK_WARN_BYTES,
  diskHealth,
} from '@/modules/ops/disk';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, statfs: vi.fn() };
});

const { statfs } = await import('node:fs/promises');
const statfsMock = vi.mocked(statfs);

/** A statfs result with `free` bytes available, 100 GB total. */
function withFree(free: number): void {
  const bsize = 4096;
  statfsMock.mockResolvedValue({
    bsize,
    // `bavail` is what the module must read. `bfree` is deliberately larger:
    // the reserved blocks it includes are not usable, and counting them would
    // overstate headroom — a test that set them equal could not catch the swap.
    bavail: free / bsize,
    bfree: (free + 5 * 1024 ** 3) / bsize,
    blocks: (100 * 1024 ** 3) / bsize,
    type: 0,
    files: 0,
    ffree: 0,
  } as Awaited<ReturnType<typeof statfs>>);
}

afterEach(() => {
  vi.clearAllMocks();
});

/**
 * The condition these tests exist for: at 0.62 GB free, PostgreSQL blocked
 * WRITES while READS kept succeeding. Every read-only health probe returned 200
 * while logins — which write a session row — hung for 317 seconds.
 *
 * So the properties worth pinning are not "does it divide bytes correctly" but
 * "does it ever say `ok` when it should not".
 */
describe('diskHealth', () => {
  it('reports ok with comfortable headroom', async () => {
    withFree(50 * 1024 ** 3);
    const health = await diskHealth();

    expect(health.state).toBe('ok');
    expect(health.action).toBeNull();
    expect(health.freeGb).toBe(50);
  });

  it('warns below the 10 GB operational floor', async () => {
    withFree(DISK_WARN_BYTES - 1024 ** 3);
    const health = await diskHealth();

    expect(health.state).toBe('warning');
    expect(health.action).not.toBeNull();
  });

  it('is critical below 2 GB', async () => {
    withFree(DISK_CRITICAL_BYTES - 1024 ** 2);
    const health = await diskHealth();

    expect(health.state).toBe('critical');
  });

  it('is critical at the free space that produced the real incident', async () => {
    withFree(0.62 * 1024 ** 3);
    const health = await diskHealth();

    expect(health.state).toBe('critical');
    // The operator must be told the shape of the failure, not just the number:
    // "reads work, writes hang" is the fact that makes the incident diagnosable.
    expect(health.summary.toLowerCase()).toContain('write');
  });

  it('treats the thresholds as exclusive lower bounds', async () => {
    withFree(DISK_WARN_BYTES);
    expect((await diskHealth()).state).toBe('ok');

    withFree(DISK_CRITICAL_BYTES);
    expect((await diskHealth()).state).toBe('warning');
  });

  it('uses available blocks, not free blocks', async () => {
    // `bfree` is 5 GB higher in the fixture. Reading it would report ~5.5 GB
    // free — a warning — instead of the 0.5 GB critical state that is true.
    withFree(0.5 * 1024 ** 3);
    const health = await diskHealth();

    expect(health.state).toBe('critical');
    expect(health.freeGb).toBeCloseTo(0.5, 1);
  });

  it('reports unknown — never ok — when the disk cannot be measured', async () => {
    statfsMock.mockRejectedValue(new Error('ENOSYS: not implemented'));
    const health = await diskHealth();

    // The whole point. "We could not look" must never be recorded as "it is
    // fine", because that conflation is what let the original incident run.
    expect(health.state).toBe('unknown');
    expect(health.state).not.toBe('ok');
    expect(health.freeBytes).toBeNull();
    expect(health.action).not.toBeNull();
  });

  it('never throws, whatever statfs does', async () => {
    statfsMock.mockRejectedValue('not even an Error');
    await expect(diskHealth()).resolves.toMatchObject({ state: 'unknown' });
  });

  it('always states which filesystem it measured', async () => {
    withFree(50 * 1024 ** 3);
    const ok = await diskHealth();
    statfsMock.mockRejectedValue(new Error('nope'));
    const unknown = await diskHealth();

    // In a split deployment this process's disk is not PostgreSQL's disk, and a
    // monitoring signal whose scope is misunderstood is how the incident began.
    for (const health of [ok, unknown]) {
      expect(health.scope).toMatch(/PostgreSQL/);
    }
  });
});
