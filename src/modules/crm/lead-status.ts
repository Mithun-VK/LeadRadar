/**
 * Lead lifecycle.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE AXIS
 * ---------------------------------------------------------------------------
 *
 * LeadRadar already had three status-shaped fields before this one, and the
 * temptation is to reuse one. All three mean something different:
 *
 *   leadPriority (A+..D)  — how GOOD this prospect is. A quality grade.
 *   CampaignLead.status   — where one ENROLMENT got to. Per campaign, not per lead.
 *   independentWebsiteStatus — what we established about their website.
 *
 * `leadStatus` is the fourth and answers "where is this RELATIONSHIP". A lead can
 * be grade A+ and status LOST; it can be grade C and status WON. Collapsing any
 * two of these loses information that a salesperson actually uses.
 *
 * ---------------------------------------------------------------------------
 * WHY TRANSITIONS ARE VALIDATED
 * ---------------------------------------------------------------------------
 *
 * An unvalidated status field drifts into nonsense within weeks: leads sitting in
 * MEETING that were never contacted, WON deals with no proposal, statuses set by
 * a worker that a human had already moved past. The transition table makes the
 * pipeline a state machine rather than a label, which is what lets the funnel
 * analytics mean anything — a funnel computed over a field anyone can set to
 * anything is a chart of typos.
 */
import { AppError } from '@/lib/errors';

export type LeadStatus =
  | 'NEW'
  | 'QUALIFIED'
  | 'CONTACTED'
  | 'REPLIED'
  | 'SQL'
  | 'MEETING'
  | 'PROPOSAL'
  | 'NEGOTIATION'
  | 'WON'
  | 'LOST'
  | 'UNSUBSCRIBED';

export type StatusChangeSource = 'SYSTEM' | 'USER' | 'EMAIL' | 'AI' | 'IMPORT';

/** Display order, which is also funnel order for the stages that are a funnel. */
export const LEAD_STATUS_ORDER: readonly LeadStatus[] = [
  'NEW',
  'QUALIFIED',
  'CONTACTED',
  'REPLIED',
  'SQL',
  'MEETING',
  'PROPOSAL',
  'NEGOTIATION',
  'WON',
  'LOST',
  'UNSUBSCRIBED',
];

export const LEAD_STATUS_LABELS: Record<LeadStatus, string> = {
  NEW: 'New',
  QUALIFIED: 'Qualified',
  CONTACTED: 'Contacted',
  REPLIED: 'Replied',
  SQL: 'Sales qualified',
  MEETING: 'Meeting',
  PROPOSAL: 'Proposal',
  NEGOTIATION: 'Negotiation',
  WON: 'Won',
  LOST: 'Lost',
  UNSUBSCRIBED: 'Unsubscribed',
};

/**
 * Statuses from which nothing further can happen automatically.
 *
 * LOST is deliberately NOT terminal: a lost deal is a lead worth re-approaching
 * next year, and making it a dead end would quietly destroy the most valuable
 * segment an agency has — businesses that already know who you are.
 *
 * UNSUBSCRIBED is genuinely terminal. It is the one state a system must never
 * move a lead out of on its own, because the person asked not to be contacted.
 */
export const TERMINAL_STATUSES: readonly LeadStatus[] = ['UNSUBSCRIBED'];

/**
 * Permitted transitions.
 *
 * Forward progress is the happy path, but the table is deliberately permissive
 * in two directions that a naive state machine would forbid:
 *
 *   - Backwards, because deals stall. A PROPOSAL that goes quiet returns to SQL,
 *     and forcing an operator to mark it LOST to represent that would corrupt the
 *     win/loss numbers.
 *   - Skipping ahead, because reality skips. A lead who replies to the first
 *     email asking for a meeting goes CONTACTED -> MEETING without passing
 *     through REPLIED and SQL as separate human actions.
 *
 * What it forbids is the incoherent: arriving at WON without ever being
 * contacted, or leaving UNSUBSCRIBED.
 */
const TRANSITIONS: Record<LeadStatus, readonly LeadStatus[]> = {
  /**
   * NEW and QUALIFIED reach MEETING and PROPOSAL directly.
   *
   * Not every relationship starts with an email. A referral walks in, someone
   * calls the office, a contact is met at an event — and a meeting is booked with
   * a lead that was created moments earlier. Forbidding that would force an
   * operator to fake a CONTACTED step to record something real.
   *
   * WON is still unreachable from here: closing a deal with a business nobody
   * ever spoke to is incoherent, and permitting it would let a mis-click corrupt
   * the win-rate denominator.
   */
  // REPLIED is reachable from NEW and QUALIFIED because a reply can arrive
  // without this system having sent anything — an inbound enquiry, or an answer
  // to a mail the operator sent from their own client before enrolling the lead.
  NEW: ['QUALIFIED', 'CONTACTED', 'REPLIED', 'MEETING', 'PROPOSAL', 'LOST', 'UNSUBSCRIBED'],
  QUALIFIED: ['CONTACTED', 'NEW', 'REPLIED', 'MEETING', 'PROPOSAL', 'LOST', 'UNSUBSCRIBED'],
  // PROPOSAL directly from CONTACTED: a proposal is often sent off the back of a
  // phone call that never produced an email reply.
  CONTACTED: ['REPLIED', 'SQL', 'MEETING', 'PROPOSAL', 'QUALIFIED', 'LOST', 'UNSUBSCRIBED'],
  REPLIED: ['SQL', 'MEETING', 'PROPOSAL', 'CONTACTED', 'LOST', 'UNSUBSCRIBED'],
  SQL: ['MEETING', 'PROPOSAL', 'NEGOTIATION', 'REPLIED', 'LOST', 'UNSUBSCRIBED'],
  MEETING: ['PROPOSAL', 'NEGOTIATION', 'SQL', 'WON', 'LOST', 'UNSUBSCRIBED'],
  PROPOSAL: ['NEGOTIATION', 'WON', 'LOST', 'MEETING', 'SQL', 'UNSUBSCRIBED'],
  NEGOTIATION: ['WON', 'LOST', 'PROPOSAL', 'MEETING', 'UNSUBSCRIBED'],
  // Re-engagement after a close is legitimate and common.
  WON: ['NEGOTIATION', 'LOST', 'UNSUBSCRIBED'],
  // A lost lead re-approached later can go straight to a meeting or a proposal —
  // they already know who you are, which is the whole reason to re-approach them.
  LOST: ['QUALIFIED', 'CONTACTED', 'REPLIED', 'SQL', 'MEETING', 'PROPOSAL', 'UNSUBSCRIBED'],
  // The one true dead end.
  UNSUBSCRIBED: [],
};

export function canTransition(from: LeadStatus, to: LeadStatus): boolean {
  // A no-op is always allowed, so callers can set a status idempotently without
  // branching. It produces no history row (see recordStatusChange).
  if (from === to) return true;
  return TRANSITIONS[from].includes(to);
}

export function allowedTransitions(from: LeadStatus): readonly LeadStatus[] {
  return TRANSITIONS[from];
}

export function assertTransition(from: LeadStatus, to: LeadStatus): void {
  if (canTransition(from, to)) return;

  throw new AppError({
    code: 'VALIDATION_FAILED',
    message: `A lead cannot move from ${from} to ${to}`,
    safeMessage:
      from === 'UNSUBSCRIBED'
        ? 'This person unsubscribed. Their status cannot be changed.'
        : `A ${LEAD_STATUS_LABELS[from].toLowerCase()} lead cannot become ${LEAD_STATUS_LABELS[to].toLowerCase()}.`,
    context: { from, to, allowed: TRANSITIONS[from] },
  });
}

/**
 * The status an inbound event implies, or null to leave the lead alone.
 *
 * Returns a SUGGESTION. The caller still runs it through the transition table,
 * so an event arriving out of order cannot corrupt the pipeline — a reply landing
 * on a lead already at PROPOSAL does not drag it backwards to REPLIED.
 */
export function statusForEvent(
  event: 'EMAIL_SENT' | 'REPLY_RECEIVED' | 'MEETING_BOOKED' | 'PROPOSAL_SENT' | 'UNSUBSCRIBED' | 'BOUNCED',
  current: LeadStatus,
): LeadStatus | null {
  switch (event) {
    case 'EMAIL_SENT':
      // Only the first send advances the lead. A follow-up to someone who already
      // replied must not pull them back to CONTACTED.
      return current === 'NEW' || current === 'QUALIFIED' ? 'CONTACTED' : null;

    case 'REPLY_RECEIVED':
      // Anyone past REPLIED stays where they are; a reply is not a regression.
      return current === 'NEW' || current === 'QUALIFIED' || current === 'CONTACTED'
        ? 'REPLIED'
        : null;

    case 'MEETING_BOOKED': {
      // Booking a call during negotiation does not regress the lead to MEETING —
      // a negotiation call is part of negotiating. Only leads that have not yet
      // reached a later stage move.
      const alreadyBeyond: LeadStatus[] = ['PROPOSAL', 'NEGOTIATION', 'WON', 'UNSUBSCRIBED'];
      return alreadyBeyond.includes(current) ? null : 'MEETING';
    }

    case 'PROPOSAL_SENT':
      return current === 'WON' || current === 'NEGOTIATION' || current === 'UNSUBSCRIBED'
        ? null
        : 'PROPOSAL';

    case 'UNSUBSCRIBED':
      return 'UNSUBSCRIBED';

    case 'BOUNCED':
      // A bounce says the ADDRESS is wrong, not that the prospect said no. The
      // lead keeps its status and gets `emailInvalid` set instead — treating a
      // typo'd address as a rejection would discard a real prospect.
      return null;
  }
}

/**
 * Whether a status counts as "in the funnel" for conversion maths.
 *
 * UNSUBSCRIBED is excluded from denominators: including people who opted out
 * would make every conversion rate look worse as compliance improved, which is
 * exactly backwards as an incentive.
 */
export function countsInFunnel(status: LeadStatus): boolean {
  return status !== 'UNSUBSCRIBED';
}

/** Statuses at or beyond a given funnel stage, for cumulative counts. */
export function statusesAtOrBeyond(stage: LeadStatus): LeadStatus[] {
  const funnel: LeadStatus[] = [
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

  const index = funnel.indexOf(stage);
  if (index === -1) return [stage];

  // LOST is included because a lead that reached PROPOSAL and then lost DID
  // reach proposal. Excluding it would make the funnel narrow retroactively as
  // deals close badly, which misrepresents what actually happened.
  return [...funnel.slice(index), 'LOST'];
}
