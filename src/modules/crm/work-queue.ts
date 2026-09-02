/**
 * The sales work queue.
 *
 * Answers one question: **what needs a human right now?**
 *
 * This is the daily operating screen, so it is ordered by urgency rather than by
 * recency or score. A reply sitting unanswered for two days outranks a
 * higher-scoring lead nobody has contacted — the first is a person waiting, and
 * the second is a row in a table.
 *
 * Every section corresponds to a decision a person has to make. Nothing appears
 * here that the system could have handled itself, because a queue full of things
 * that resolve on their own is a queue people stop reading.
 */
import { db, type TenantContext } from '@/modules/database/client';
import { INTENT_LABELS, type EmailIntent } from '@/modules/email/intent';
import { formatMoney } from './deals';

export interface QueueItem {
  readonly kind:
    | 'REPLY'
    | 'MEETING_REQUEST'
    | 'PRICE_REQUEST'
    | 'OVERDUE_TASK'
    | 'DUE_TASK'
    | 'STALE_PROPOSAL'
    | 'NEGOTIATION'
    | 'HOT_LEAD';
  readonly businessId: string;
  readonly businessName: string;
  readonly city: string | null;
  readonly headline: string;
  /** The specific thing that happened, quoted where possible. */
  readonly detail: string | null;
  readonly action: string;
  readonly occurredAt: Date;
  readonly leadStatus: string;
  readonly dealId: string | null;
  readonly valueLabel: string | null;
  /** Lower sorts first. */
  readonly urgency: number;
}

export interface WorkQueue {
  readonly urgent: readonly QueueItem[];
  readonly replies: readonly QueueItem[];
  readonly meetingRequests: readonly QueueItem[];
  readonly priceRequests: readonly QueueItem[];
  readonly followUpsDue: readonly QueueItem[];
  readonly proposals: readonly QueueItem[];
  readonly negotiations: readonly QueueItem[];
  readonly hotLeads: readonly QueueItem[];
  readonly totalItems: number;
}

/** Days after which a sent proposal with no answer needs chasing. */
const STALE_PROPOSAL_DAYS = 5;

function truncate(text: string | null, length = 160): string | null {
  if (!text) return null;
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > length ? `${clean.slice(0, length)}…` : clean;
}

export async function buildWorkQueue(tenant: TenantContext): Promise<WorkQueue> {
  const org = { organizationId: tenant.organizationId };
  const now = new Date();

  const [unhandledReplies, overdueTasks, dueTasks, staleProposals, negotiations, hotLeads] =
    await Promise.all([
      /**
       * Replies whose lead has not moved past REPLIED.
       *
       * The filter is what makes this a work queue rather than a log: once a
       * human has acted — moved the lead to SQL, booked a meeting — the reply
       * stops appearing, without anyone having to dismiss it.
       */
      db().emailConversation.findMany({
        where: {
          ...org,
          direction: 'INBOUND',
          business: { leadStatus: { in: ['NEW', 'QUALIFIED', 'CONTACTED', 'REPLIED'] } },
        },
        orderBy: { receivedAt: 'desc' },
        take: 100,
        include: {
          intent: true,
          business: {
            select: {
              id: true,
              displayName: true,
              city: true,
              leadStatus: true,
              opportunityScore: true,
            },
          },
        },
      }),

      db().salesActivity.findMany({
        where: { ...org, status: 'OPEN', dueAt: { lt: now } },
        orderBy: { dueAt: 'asc' },
        take: 50,
        include: {
          business: { select: { id: true, displayName: true, city: true, leadStatus: true } },
          deal: { select: { id: true, valueMinor: true, currency: true } },
        },
      }),

      db().salesActivity.findMany({
        where: {
          ...org,
          status: 'OPEN',
          dueAt: { gte: now, lte: new Date(now.getTime() + 7 * 86_400_000) },
        },
        orderBy: { dueAt: 'asc' },
        take: 50,
        include: {
          business: { select: { id: true, displayName: true, city: true, leadStatus: true } },
          deal: { select: { id: true, valueMinor: true, currency: true } },
        },
      }),

      db().proposal.findMany({
        where: {
          ...org,
          status: 'SENT',
          sentAt: { lt: new Date(now.getTime() - STALE_PROPOSAL_DAYS * 86_400_000) },
        },
        orderBy: { sentAt: 'asc' },
        take: 50,
        include: {
          business: { select: { id: true, displayName: true, city: true, leadStatus: true } },
          deal: { select: { id: true, valueMinor: true, currency: true } },
        },
      }),

      db().deal.findMany({
        where: { ...org, stage: 'NEGOTIATION' },
        orderBy: { valueMinor: { sort: 'desc', nulls: 'last' } },
        take: 50,
        include: {
          business: { select: { id: true, displayName: true, city: true, leadStatus: true } },
        },
      }),

      /**
       * High-scoring leads nobody has contacted.
       *
       * Last in the queue on purpose. An uncontacted lead has been waiting since
       * discovery and will keep; a person who wrote to you this morning will not.
       */
      db().business.findMany({
        where: {
          ...org,
          leadStatus: { in: ['NEW', 'QUALIFIED'] },
          opportunityScore: { gte: 75 },
          primaryEmail: { not: null },
          emailInvalid: false,
        },
        orderBy: { opportunityScore: 'desc' },
        take: 25,
        select: {
          id: true,
          displayName: true,
          city: true,
          leadStatus: true,
          opportunityScore: true,
          leadPriority: true,
          createdAt: true,
        },
      }),
    ]);

  const replies: QueueItem[] = [];
  const meetingRequests: QueueItem[] = [];
  const priceRequests: QueueItem[] = [];

  for (const conversation of unhandledReplies) {
    if (!conversation.business) continue;

    const intent = (conversation.intent?.intent ?? 'UNKNOWN') as EmailIntent;

    // Auto-replies are not work. They were never treated as replies, and they
    // must not appear as something to answer.
    if (intent === 'OUT_OF_OFFICE' || intent === 'BOUNCE') continue;

    const base = {
      businessId: conversation.business.id,
      businessName: conversation.business.displayName,
      city: conversation.business.city,
      detail: truncate(conversation.body),
      occurredAt: conversation.receivedAt,
      leadStatus: conversation.business.leadStatus,
      dealId: null,
      valueLabel: null,
    };

    if (intent === 'MEETING_REQUEST') {
      meetingRequests.push({
        ...base,
        kind: 'MEETING_REQUEST',
        headline: `${conversation.business.displayName} asked to meet`,
        action: 'Schedule',
        urgency: 1,
      });
    } else if (intent === 'PRICE_REQUEST') {
      priceRequests.push({
        ...base,
        kind: 'PRICE_REQUEST',
        headline: `${conversation.business.displayName} asked about pricing`,
        action: 'Send a price',
        urgency: 1,
      });
    } else {
      replies.push({
        ...base,
        kind: 'REPLY',
        headline: `${conversation.business.displayName} replied — ${INTENT_LABELS[intent]}`,
        action: 'Respond',
        urgency: intent === 'POSITIVE_INTEREST' ? 1 : 2,
      });
    }
  }

  const taskItem = (
    activity: (typeof overdueTasks)[number],
    kind: 'OVERDUE_TASK' | 'DUE_TASK',
  ): QueueItem => ({
    kind,
    businessId: activity.business.id,
    businessName: activity.business.displayName,
    city: activity.business.city,
    headline: activity.title,
    detail: truncate(activity.description),
    action: 'Complete',
    occurredAt: activity.dueAt ?? activity.createdAt,
    leadStatus: activity.business.leadStatus,
    dealId: activity.deal?.id ?? null,
    valueLabel: activity.deal
      ? formatMoney(activity.deal.valueMinor, activity.deal.currency)
      : null,
    urgency: kind === 'OVERDUE_TASK' ? 0 : 3,
  });

  const followUpsDue: QueueItem[] = [
    ...overdueTasks.map((activity) => taskItem(activity, 'OVERDUE_TASK')),
    ...dueTasks.map((activity) => taskItem(activity, 'DUE_TASK')),
  ];

  const proposals: QueueItem[] = staleProposals.map((proposal) => {
    const days = proposal.sentAt
      ? Math.floor((now.getTime() - proposal.sentAt.getTime()) / 86_400_000)
      : STALE_PROPOSAL_DAYS;

    return {
      kind: 'STALE_PROPOSAL',
      businessId: proposal.business.id,
      businessName: proposal.business.displayName,
      city: proposal.business.city,
      headline: `Proposal sent ${days} days ago, no response`,
      detail: proposal.title,
      action: 'Follow up',
      occurredAt: proposal.sentAt ?? proposal.createdAt,
      leadStatus: proposal.business.leadStatus,
      dealId: proposal.deal?.id ?? null,
      valueLabel: formatMoney(proposal.amountMinor, proposal.currency),
      urgency: 2,
    };
  });

  const negotiationItems: QueueItem[] = negotiations.map((deal) => ({
    kind: 'NEGOTIATION',
    businessId: deal.business.id,
    businessName: deal.business.displayName,
    city: deal.business.city,
    headline: `In negotiation: ${deal.name}`,
    detail: deal.notes ? truncate(deal.notes) : null,
    action: 'Advance',
    occurredAt: deal.updatedAt,
    leadStatus: deal.business.leadStatus,
    dealId: deal.id,
    valueLabel: formatMoney(deal.valueMinor, deal.currency),
    urgency: 2,
  }));

  const hotLeadItems: QueueItem[] = hotLeads.map((lead) => ({
    kind: 'HOT_LEAD',
    businessId: lead.id,
    businessName: lead.displayName,
    city: lead.city,
    headline: `Uncontacted, score ${lead.opportunityScore ?? '—'}`,
    detail: null,
    action: 'Contact',
    occurredAt: lead.createdAt,
    leadStatus: lead.leadStatus,
    dealId: null,
    valueLabel: null,
    urgency: 5,
  }));

  /**
   * The urgent band: things a person is waiting on, plus work already overdue.
   *
   * Capped at eight. A screen that opens with forty "urgent" items has no urgent
   * items — the label only works if it is short enough to act on this morning.
   */
  const urgent = [
    ...meetingRequests,
    ...priceRequests,
    ...replies.filter((item) => item.urgency <= 1),
    ...followUpsDue.filter((item) => item.kind === 'OVERDUE_TASK'),
  ]
    .sort((a, b) => a.urgency - b.urgency || b.occurredAt.getTime() - a.occurredAt.getTime())
    .slice(0, 8);

  const totalItems =
    replies.length +
    meetingRequests.length +
    priceRequests.length +
    followUpsDue.length +
    proposals.length +
    negotiationItems.length +
    hotLeadItems.length;

  return {
    urgent,
    replies,
    meetingRequests,
    priceRequests,
    followUpsDue,
    proposals,
    negotiations: negotiationItems,
    hotLeads: hotLeadItems,
    totalItems,
  };
}
