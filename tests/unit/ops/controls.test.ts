import { describe, expect, it } from 'vitest';

import { CONTROLS, type ControlName } from '@/modules/ops/controls';

/**
 * These test the *policy* the controls encode, not the database plumbing —
 * the read/write path is covered end to end by the outreach verification, which
 * runs against real PostgreSQL.
 *
 * The policy is the part worth pinning down in a unit test, because it is the
 * part someone could plausibly "simplify" later without realising the asymmetry
 * is load-bearing.
 */
describe('operational control policy', () => {
  const names = Object.keys(CONTROLS) as ControlName[];

  it('defines the three controls an operator needs during an incident', () => {
    expect(names.sort()).toEqual(['ai', 'crawler', 'outbound']);
  });

  it('gives every control a distinct storage key', () => {
    const keys = names.map((n) => CONTROLS[n].key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('namespaces every key under ops., so a control cannot collide with a preference', () => {
    for (const name of names) {
      expect(CONTROLS[name].key).toMatch(/^ops\./);
    }
  });

  /**
   * The central asymmetry. An unsent email is recoverable; an unwanted one is
   * not — so only outbound may fail closed, and it MUST.
   */
  it('fails CLOSED for outbound, because an unwanted email cannot be recalled', () => {
    expect(CONTROLS.outbound.failsClosed).toBe(true);
  });

  it('fails OPEN for ai and crawler, so a read blip cannot halt the pipeline', () => {
    expect(CONTROLS.ai.failsClosed).toBe(false);
    expect(CONTROLS.crawler.failsClosed).toBe(false);
  });

  it('has exactly one fail-closed control', () => {
    // If this ever becomes two, someone has widened the blast radius of a
    // transient database error into the crawl or AI path. That should be a
    // deliberate decision, not a quiet one.
    const failClosed = names.filter((n) => CONTROLS[n].failsClosed);
    expect(failClosed).toEqual(['outbound']);
  });

  it('describes each control in terms of what an operator will observe', () => {
    for (const name of names) {
      const { label, description } = CONTROLS[name];
      expect(label.length).toBeGreaterThan(3);
      expect(description.length).toBeGreaterThan(40);
    }
  });

  it('promises in the outbound description that queued work survives a pause', () => {
    // An operator who believes pausing loses the queue will not press the brake.
    expect(CONTROLS.outbound.description).toMatch(/resume|not lost/i);
  });
});
