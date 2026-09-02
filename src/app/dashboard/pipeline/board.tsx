'use client';

/**
 * Kanban board with drag-and-drop stage changes.
 *
 * Uses the native HTML drag-and-drop API rather than a library: the interaction
 * is one card into one column, and a dependency for that would be more code than
 * the feature.
 *
 * Two behaviours worth noting:
 *
 *   - The card moves optimistically and REVERTS if the server refuses. A board
 *     that shows a card in a stage the database rejected is worse than a brief
 *     flicker, because the operator walks away believing the move stuck.
 *   - Moving to LOST prompts for a reason, because the API requires one. "Why did
 *     we lose?" is the most useful field in a CRM and is never filled in later.
 */
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import Link from 'next/link';

import { api } from '@/lib/api-client';

interface BoardDeal {
  id: string;
  name: string;
  stage: string;
  businessId: string;
  businessName: string;
  city: string | null;
  valueLabel: string;
  hasValue: boolean;
  probability: number;
  owner: string | null;
}

const STAGE_ORDER = [
  'QUALIFICATION',
  'DISCOVERY',
  'MEETING',
  'PROPOSAL',
  'NEGOTIATION',
  'WON',
  'LOST',
];

export function PipelineBoard({
  deals,
  stageLabels,
}: {
  deals: BoardDeal[];
  stageLabels: Record<string, string>;
}) {
  const router = useRouter();
  const [items, setItems] = useState(deals);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function move(dealId: string, toStage: string): Promise<void> {
    const deal = items.find((item) => item.id === dealId);
    if (!deal || deal.stage === toStage) return;

    let lostReason: string | undefined;
    if (toStage === 'LOST') {
      const entered = window.prompt('Why was this deal lost?');
      // A cancelled prompt cancels the move rather than losing the deal with no
      // reason — the field is the point.
      if (entered === null || entered.trim() === '') return;
      lostReason = entered.trim();
    }

    const previous = items;
    setItems((current) =>
      current.map((item) => (item.id === dealId ? { ...item, stage: toStage } : item)),
    );
    setBusy(true);
    setError(null);

    const response = await api.post(`/api/deals/${dealId}/stage`, {
      stage: toStage,
      ...(lostReason !== undefined && { lostReason }),
    });

    if (!response.ok) {
      // Revert, so the board never shows a state the database refused.
      setItems(previous);
      setError(response.error?.message ?? 'That move was not allowed.');
    } else {
      router.refresh();
    }

    setBusy(false);
  }

  return (
    <div className="space-y-3">
      {error && (
        <div
          className="rounded-lg border border-[var(--grade-d)] px-4 py-2 text-xs text-[var(--grade-d)]"
          role="alert"
        >
          {error}
        </div>
      )}

      <div className="table-scroll">
        <div className="flex min-w-[1100px] gap-3">
          {STAGE_ORDER.map((stage) => {
            const inStage = items.filter((item) => item.stage === stage);
            const isOver = over === stage;

            return (
              <div
                key={stage}
                onDragOver={(event) => {
                  event.preventDefault();
                  setOver(stage);
                }}
                onDragLeave={() => setOver((current) => (current === stage ? null : current))}
                onDrop={(event) => {
                  event.preventDefault();
                  setOver(null);
                  if (dragging) void move(dragging, stage);
                  setDragging(null);
                }}
                className="flex w-56 shrink-0 flex-col rounded-xl border p-2"
                style={{
                  borderColor: isOver ? 'var(--accent)' : 'var(--border)',
                  backgroundColor: isOver ? 'var(--accent-soft)' : 'var(--surface)',
                }}
              >
                <div className="flex items-baseline justify-between px-1 pb-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]">
                    {stageLabels[stage] ?? stage}
                  </span>
                  <span className="text-[11px] tabular-nums text-[var(--muted)]">
                    {inStage.length}
                  </span>
                </div>

                <div className="space-y-2">
                  {inStage.map((deal) => (
                    <article
                      key={deal.id}
                      draggable={!busy}
                      onDragStart={() => setDragging(deal.id)}
                      onDragEnd={() => setDragging(null)}
                      className="cursor-grab rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 active:cursor-grabbing"
                      style={{ opacity: dragging === deal.id ? 0.5 : 1 }}
                    >
                      <p className="text-xs font-medium">{deal.name}</p>
                      <Link
                        href={`/dashboard/leads/${deal.businessId}`}
                        className="mt-0.5 block truncate text-[11px] text-[var(--muted)] hover:underline"
                      >
                        {deal.businessName}
                      </Link>

                      <div className="mt-1.5 flex items-baseline justify-between">
                        <span
                          className="text-xs font-semibold tabular-nums"
                          // An unvalued deal is shown as unknown, never as zero.
                          style={{ color: deal.hasValue ? undefined : 'var(--muted)' }}
                          title={deal.hasValue ? undefined : 'No value entered yet'}
                        >
                          {deal.hasValue ? deal.valueLabel : 'Not valued'}
                        </span>
                        <span className="text-[10px] text-[var(--muted)]">
                          {deal.probability}%
                        </span>
                      </div>
                    </article>
                  ))}

                  {inStage.length === 0 && (
                    <p className="px-1 py-3 text-center text-[11px] text-[var(--muted)]">
                      Drop here
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
