import { describe, expect, it } from 'vitest';

import {
  CLOSED_STAGES,
  DEAL_STAGE_LABELS,
  DEAL_STAGE_ORDER,
  STAGE_PROBABILITY,
  assertStageMove,
  canMoveStage,
  formatMoney,
  leadStatusForStage,
  toMinorUnits,
  type DealStage,
} from '@/modules/crm/deals';
import { canTransition } from '@/modules/crm/lead-status';

const ALL: DealStage[] = [...DEAL_STAGE_ORDER];

describe('deal stage transitions', () => {
  it('allows the normal forward path', () => {
    const path: DealStage[] = [
      'QUALIFICATION',
      'DISCOVERY',
      'MEETING',
      'PROPOSAL',
      'NEGOTIATION',
      'WON',
    ];

    for (let i = 0; i < path.length - 1; i += 1) {
      expect(canMoveStage(path[i]!, path[i + 1]!)).toBe(true);
    }
  });

  it('allows any open stage to be lost', () => {
    for (const stage of ALL) {
      if (stage === 'LOST') continue;
      expect(canMoveStage(stage, 'LOST')).toBe(true);
    }
  });

  it('allows a mistakenly closed deal to be reopened', () => {
    // A deal marked lost in error must be fixable; the change is recorded.
    expect(canMoveStage('LOST', 'QUALIFICATION')).toBe(true);
    expect(canMoveStage('WON', 'NEGOTIATION')).toBe(true);
  });

  it('allows a stalled deal to move backwards', () => {
    expect(canMoveStage('PROPOSAL', 'MEETING')).toBe(true);
    expect(canMoveStage('NEGOTIATION', 'PROPOSAL')).toBe(true);
  });

  it('treats a no-op as allowed', () => {
    for (const stage of ALL) expect(canMoveStage(stage, stage)).toBe(true);
  });

  it('explains a refusal', () => {
    expect(() => assertStageMove('WON', 'QUALIFICATION')).toThrow(/cannot move from WON/);
  });

  it('has a label for every stage', () => {
    for (const stage of ALL) expect(DEAL_STAGE_LABELS[stage]).toBeTruthy();
  });
});

describe('stage probability', () => {
  it('rises monotonically along the forward path', () => {
    const path: DealStage[] = [
      'QUALIFICATION',
      'DISCOVERY',
      'MEETING',
      'PROPOSAL',
      'NEGOTIATION',
      'WON',
    ];

    for (let i = 0; i < path.length - 1; i += 1) {
      expect(STAGE_PROBABILITY[path[i + 1]!]).toBeGreaterThan(STAGE_PROBABILITY[path[i]!]);
    }
  });

  it('puts won at 100 and lost at 0', () => {
    expect(STAGE_PROBABILITY.WON).toBe(100);
    expect(STAGE_PROBABILITY.LOST).toBe(0);
  });

  it('keeps every probability in range', () => {
    for (const stage of ALL) {
      expect(STAGE_PROBABILITY[stage]).toBeGreaterThanOrEqual(0);
      expect(STAGE_PROBABILITY[stage]).toBeLessThanOrEqual(100);
    }
  });
});

describe('deal stage to lead status', () => {
  it('maps only the stages that mean something happened', () => {
    // QUALIFICATION and DISCOVERY imply nothing about the relationship: a deal
    // can be opened off a reply before the lead reaches SQL.
    expect(leadStatusForStage('QUALIFICATION')).toBeNull();
    expect(leadStatusForStage('DISCOVERY')).toBeNull();

    expect(leadStatusForStage('MEETING')).toBe('MEETING');
    expect(leadStatusForStage('PROPOSAL')).toBe('PROPOSAL');
    expect(leadStatusForStage('NEGOTIATION')).toBe('NEGOTIATION');
    expect(leadStatusForStage('WON')).toBe('WON');
    expect(leadStatusForStage('LOST')).toBe('LOST');
  });

  it('never implies a lead status an unsubscribed lead could be forced into', () => {
    // Propagation is best-effort and the lead table is the final guard.
    for (const stage of ALL) {
      const implied = leadStatusForStage(stage);
      if (implied) expect(canTransition('UNSUBSCRIBED', implied)).toBe(false);
    }
  });

  it('identifies the closed stages', () => {
    expect([...CLOSED_STAGES].sort()).toEqual(['LOST', 'WON']);
  });
});

describe('money handling', () => {
  it('converts major units to integer minor units', () => {
    expect(toMinorUnits(45000)).toBe(4_500_000);
    expect(toMinorUnits('45000')).toBe(4_500_000);
  });

  it('tolerates thousands separators from a form', () => {
    expect(toMinorUnits('45,000')).toBe(4_500_000);
  });

  it('handles fractional major units without floating-point drift', () => {
    expect(toMinorUnits(1234.56)).toBe(123_456);
    expect(toMinorUnits(0.1)).toBe(10);
  });

  it('returns null for an absent amount rather than zero', () => {
    // "Not estimated" is not "worth nothing", and conflating them would drag
    // every average down.
    expect(toMinorUnits(null)).toBeNull();
    expect(toMinorUnits(undefined)).toBeNull();
    expect(toMinorUnits('')).toBeNull();
  });

  it('rejects a value that is not a number', () => {
    expect(() => toMinorUnits('about fifty thousand')).toThrow();
  });

  it('renders null as unknown, never as zero', () => {
    expect(formatMoney(null)).toBe('—');
    expect(formatMoney(0)).not.toBe('—');
  });

  it('formats an amount in the given currency', () => {
    const formatted = formatMoney(4_500_000, 'INR');
    expect(formatted).toMatch(/45,000/);
  });

  it('falls back rather than throwing on an unknown currency code', () => {
    expect(() => formatMoney(100_000, 'XYZ')).not.toThrow();
  });

  it('round-trips through minor units without drift across many values', () => {
    // The property that matters for a pipeline total: summing integers is exact.
    const majors = [1, 99.99, 1234.5, 45000, 999999.99];
    const minors = majors.map((m) => toMinorUnits(m)!);
    const total = minors.reduce((a, b) => a + b, 0);

    expect(Number.isInteger(total)).toBe(true);
    expect(total).toBe(100 + 9999 + 123450 + 4500000 + 99999999);
  });
});
