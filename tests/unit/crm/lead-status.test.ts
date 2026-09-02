import { describe, expect, it } from 'vitest';

import {
  LEAD_STATUS_LABELS,
  LEAD_STATUS_ORDER,
  TERMINAL_STATUSES,
  allowedTransitions,
  assertTransition,
  canTransition,
  countsInFunnel,
  statusForEvent,
  statusesAtOrBeyond,
  type LeadStatus,
} from '@/modules/crm/lead-status';

const ALL: LeadStatus[] = [...LEAD_STATUS_ORDER];

describe('lead status transitions', () => {
  it('allows the normal forward path', () => {
    const path: LeadStatus[] = [
      'NEW',
      'QUALIFIED',
      'CONTACTED',
      'REPLIED',
      'SQL',
      'MEETING',
      'PROPOSAL',
      'NEGOTIATION',
      'WON',
    ];

    for (let i = 0; i < path.length - 1; i += 1) {
      expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
    }
  });

  it('treats a no-op as allowed, so callers can set a status idempotently', () => {
    for (const status of ALL) {
      expect(canTransition(status, status)).toBe(true);
    }
  });

  it('allows skipping ahead, because reality skips', () => {
    // A lead who replies to the first email asking to meet goes straight there.
    expect(canTransition('CONTACTED', 'MEETING')).toBe(true);
    expect(canTransition('REPLIED', 'PROPOSAL')).toBe(true);
  });

  it('allows moving backwards, because deals stall', () => {
    // Forcing an operator to mark a stalled proposal LOST would corrupt win rate.
    expect(canTransition('PROPOSAL', 'SQL')).toBe(true);
    expect(canTransition('NEGOTIATION', 'PROPOSAL')).toBe(true);
  });

  it('forbids arriving at WON without ever being contacted', () => {
    expect(canTransition('NEW', 'WON')).toBe(false);
    expect(canTransition('QUALIFIED', 'WON')).toBe(false);
  });

  it('permits re-engaging a lost lead', () => {
    // A lost deal is a lead worth approaching again; a dead end would destroy
    // the most valuable segment an agency has.
    expect(canTransition('LOST', 'QUALIFIED')).toBe(true);
    expect(canTransition('LOST', 'CONTACTED')).toBe(true);
  });

  it('makes UNSUBSCRIBED the only true dead end', () => {
    expect(TERMINAL_STATUSES).toEqual(['UNSUBSCRIBED']);

    for (const target of ALL) {
      if (target === 'UNSUBSCRIBED') continue;
      expect(canTransition('UNSUBSCRIBED', target)).toBe(false);
    }
  });

  it('lets any status reach UNSUBSCRIBED', () => {
    // Someone can opt out at any point, and the system must always be able to
    // record it.
    for (const from of ALL) {
      if (from === 'UNSUBSCRIBED') continue;
      expect(canTransition(from, 'UNSUBSCRIBED')).toBe(true);
    }
  });

  it('explains a refusal rather than failing bare', () => {
    expect(() => assertTransition('NEW', 'WON')).toThrow(/cannot move from NEW to WON/);
  });

  it('gives an unsubscribed lead its own message', () => {
    let message = '';
    try {
      assertTransition('UNSUBSCRIBED', 'CONTACTED');
    } catch (error) {
      message = (error as { safeMessage?: string }).safeMessage ?? '';
    }
    expect(message).toMatch(/unsubscribed/i);
  });

  it('never lists a transition it would refuse', () => {
    for (const from of ALL) {
      for (const to of allowedTransitions(from)) {
        expect(canTransition(from, to)).toBe(true);
      }
    }
  });

  it('has a label for every status', () => {
    for (const status of ALL) {
      expect(LEAD_STATUS_LABELS[status]).toBeTruthy();
    }
  });
});

describe('statusForEvent', () => {
  it('advances a new lead on the first send', () => {
    expect(statusForEvent('EMAIL_SENT', 'NEW')).toBe('CONTACTED');
    expect(statusForEvent('EMAIL_SENT', 'QUALIFIED')).toBe('CONTACTED');
  });

  it('does not drag a replied lead back to CONTACTED on a follow-up', () => {
    // The regression this prevents: a sequence step firing after someone replied
    // and resetting their pipeline position.
    expect(statusForEvent('EMAIL_SENT', 'REPLIED')).toBeNull();
    expect(statusForEvent('EMAIL_SENT', 'MEETING')).toBeNull();
    expect(statusForEvent('EMAIL_SENT', 'WON')).toBeNull();
  });

  it('advances an early lead on a reply', () => {
    expect(statusForEvent('REPLY_RECEIVED', 'CONTACTED')).toBe('REPLIED');
    expect(statusForEvent('REPLY_RECEIVED', 'NEW')).toBe('REPLIED');
  });

  it('does not regress a later lead on a reply', () => {
    expect(statusForEvent('REPLY_RECEIVED', 'PROPOSAL')).toBeNull();
    expect(statusForEvent('REPLY_RECEIVED', 'NEGOTIATION')).toBeNull();
  });

  it('treats a bounce as an address problem, not a rejection', () => {
    // A typo'd address is not a prospect saying no. The lead keeps its status.
    for (const status of ALL) {
      expect(statusForEvent('BOUNCED', status)).toBeNull();
    }
  });

  it('always honours an unsubscribe', () => {
    for (const status of ALL) {
      expect(statusForEvent('UNSUBSCRIBED', status)).toBe('UNSUBSCRIBED');
    }
  });

  it('never suggests moving an unsubscribed lead back into the funnel', () => {
    for (const event of ['EMAIL_SENT', 'REPLY_RECEIVED', 'MEETING_BOOKED', 'PROPOSAL_SENT'] as const) {
      const suggested = statusForEvent(event, 'UNSUBSCRIBED');
      if (suggested !== null) {
        expect(canTransition('UNSUBSCRIBED', suggested)).toBe(false);
      }
    }
  });

  it('only ever suggests a legal transition, or null', () => {
    // The property that makes out-of-order events safe.
    const events = [
      'EMAIL_SENT',
      'REPLY_RECEIVED',
      'MEETING_BOOKED',
      'PROPOSAL_SENT',
      'UNSUBSCRIBED',
      'BOUNCED',
    ] as const;

    for (const from of ALL) {
      for (const event of events) {
        const to = statusForEvent(event, from);
        if (to === null || to === from) continue;
        // Where it suggests something illegal, the caller drops it — but the
        // suggestion itself should be sensible for all but the terminal case.
        if (from !== 'UNSUBSCRIBED') expect(canTransition(from, to)).toBe(true);
      }
    }
  });
});

describe('funnel helpers', () => {
  it('excludes unsubscribed leads from conversion maths', () => {
    // Including opt-outs would make every rate look worse as compliance
    // improved, which is exactly the wrong incentive.
    expect(countsInFunnel('UNSUBSCRIBED')).toBe(false);
    expect(countsInFunnel('WON')).toBe(true);
    expect(countsInFunnel('LOST')).toBe(true);
  });

  it('counts a lost deal as having reached the stage it got to', () => {
    // The funnel must not narrow retroactively as deals close badly.
    expect(statusesAtOrBeyond('PROPOSAL')).toContain('LOST');
    expect(statusesAtOrBeyond('PROPOSAL')).toContain('WON');
    expect(statusesAtOrBeyond('PROPOSAL')).toContain('NEGOTIATION');
  });

  it('does not count an earlier stage as having reached a later one', () => {
    expect(statusesAtOrBeyond('PROPOSAL')).not.toContain('CONTACTED');
    expect(statusesAtOrBeyond('MEETING')).not.toContain('REPLIED');
  });

  it('includes the stage itself', () => {
    expect(statusesAtOrBeyond('MEETING')).toContain('MEETING');
  });
});
