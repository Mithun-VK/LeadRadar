/**
 * The sales work queue — the daily operating screen.
 *
 * Ordered by who is waiting, not by lead score. A person who wrote to you this
 * morning outranks a higher-scoring business nobody has contacted, because the
 * first is a relationship in progress and the second will keep.
 */
import Link from 'next/link';

import { Card, EmptyState } from '@/components/ui/primitives';
import { currentSession } from '@/modules/auth/session';
import { buildWorkQueue, type QueueItem } from '@/modules/crm/work-queue';
import { openActivityCounts } from '@/modules/crm/activities';

export const metadata = { title: 'Sales — LeadRadar' };
export const dynamic = 'force-dynamic';

function relativeTime(date: Date): string {
  const minutes = Math.round((Date.now() - date.getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return date.toLocaleDateString('en-IN');
}

function futureTime(date: Date): string {
  const minutes = Math.round((date.getTime() - Date.now()) / 60_000);
  if (minutes < 0) return `overdue by ${relativeTime(date).replace(' ago', '')}`;
  if (minutes < 60) return `in ${minutes}m`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)} days`;
}

export default async function SalesPage() {
  const session = await currentSession();
  const tenant = { organizationId: session!.organizationId, userId: session!.userId };

  const [queue, counts] = await Promise.all([
    buildWorkQueue(tenant),
    openActivityCounts(tenant),
  ]);

  const openTotal = Object.values(counts).reduce((sum, value) => sum + value, 0);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Sales</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Everything waiting on a person. {queue.totalItems} item(s), {openTotal} open task(s).
        </p>
      </div>

      {queue.totalItems === 0 ? (
        <EmptyState
          title="Nothing needs you right now"
          hint="Replies, due follow-ups, and stalled proposals appear here as they arrive."
        />
      ) : null}

      {queue.urgent.length > 0 && (
        <Card
          title="Urgent"
          description="People waiting on a reply, and work already overdue."
        >
          <ul className="space-y-2">
            {queue.urgent.map((item, index) => (
              <QueueRow key={`${item.kind}-${item.businessId}-${index}`} item={item} emphasise />
            ))}
          </ul>
        </Card>
      )}

      <Section
        title="Meeting requests"
        description="Leads who asked to talk."
        items={queue.meetingRequests}
      />
      <Section
        title="Pricing requests"
        description="Leads who asked what it costs. LeadRadar never quotes automatically."
        items={queue.priceRequests}
      />
      <Section title="Replies" description="Answered, awaiting your response." items={queue.replies} />
      <Section
        title="Follow-ups due"
        description="Scheduled work, soonest first."
        items={queue.followUpsDue}
      />
      <Section
        title="Proposals awaiting a response"
        description="Sent with no answer for five days or more."
        items={queue.proposals}
      />
      <Section
        title="In negotiation"
        description="Open deals at the closing stage."
        items={queue.negotiations}
      />
      <Section
        title="Hot leads not yet contacted"
        description="High-scoring, has an address, nobody has written to them."
        items={queue.hotLeads}
      />
    </div>
  );
}

function Section({
  title,
  description,
  items,
}: {
  title: string;
  description: string;
  items: readonly QueueItem[];
}) {
  if (items.length === 0) return null;

  return (
    <Card title={`${title} (${items.length})`} description={description}>
      <ul className="space-y-2">
        {items.slice(0, 25).map((item, index) => (
          <QueueRow key={`${item.kind}-${item.businessId}-${index}`} item={item} />
        ))}
      </ul>
      {items.length > 25 && (
        <p className="mt-3 text-[11px] text-[var(--muted)]">
          Showing 25 of {items.length}.
        </p>
      )}
    </Card>
  );
}

function QueueRow({ item, emphasise = false }: { item: QueueItem; emphasise?: boolean }) {
  const isTask = item.kind === 'OVERDUE_TASK' || item.kind === 'DUE_TASK';
  const overdue = item.kind === 'OVERDUE_TASK';

  return (
    <li
      className="flex flex-wrap items-start justify-between gap-3 rounded-lg border px-4 py-3"
      style={{
        borderColor: emphasise || overdue ? 'var(--accent)' : 'var(--border)',
        backgroundColor: emphasise ? 'var(--accent-soft)' : undefined,
      }}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`/dashboard/leads/${item.businessId}`}
            className="text-sm font-medium hover:underline"
          >
            {item.businessName}
          </Link>
          {item.city && <span className="text-[11px] text-[var(--muted)]">{item.city}</span>}
          <span className="text-[10px] uppercase tracking-wide text-[var(--muted)]">
            {item.leadStatus}
          </span>
          {item.valueLabel && item.valueLabel !== '—' && (
            <span className="text-[11px] font-medium tabular-nums">{item.valueLabel}</span>
          )}
        </div>

        <p className="mt-1 text-sm">{item.headline}</p>

        {/* The recipient's own words, where there are any. Far more useful than
            a category label when deciding how to respond. */}
        {item.detail && (
          <p className="mt-1 text-xs italic text-[var(--muted)]">&ldquo;{item.detail}&rdquo;</p>
        )}

        <p className="mt-1 text-[11px] text-[var(--muted)]">
          {isTask ? futureTime(item.occurredAt) : relativeTime(item.occurredAt)}
        </p>
      </div>

      <Link
        href={`/dashboard/leads/${item.businessId}`}
        className="shrink-0 rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-medium"
      >
        {item.action}
      </Link>
    </li>
  );
}
