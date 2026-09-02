'use client';

/**
 * Campaign activation controls.
 *
 * Activation requires a typed confirmation, not a single click. That is
 * deliberate friction and it is proportionate: this is the one button in the
 * product that causes messages to arrive in strangers' inboxes under the
 * operator's own name, and it cannot be undone once a message is delivered.
 * Pausing, by contrast, is a single click — the safe direction should always be
 * the easy one.
 */
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { api } from '@/lib/api-client';

const CONFIRM_WORD = 'SEND';

export function CampaignControls({
  campaignId,
  status,
  ready,
  deliverableCount,
  mocked,
}: {
  campaignId: string;
  status: string;
  ready: boolean;
  deliverableCount: number;
  mocked: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState('');

  async function act(action: string): Promise<void> {
    setBusy(true);
    setError(null);

    const response = await api.post<{ status: string }>(`/api/campaigns/${campaignId}/status`, {
      action,
      acknowledgeSending: action === 'start' || action === 'resume' ? true : undefined,
    });

    if (response.ok) {
      setConfirming(false);
      setTyped('');
      router.refresh();
    } else {
      setError(response.error?.message ?? 'That action failed.');
    }

    setBusy(false);
  }

  const canStart = (status === 'DRAFT' || status === 'READY') && ready;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {canStart && !confirming && (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="rounded-lg bg-[var(--accent)] px-4 py-1.5 text-sm font-medium text-white"
          >
            Activate campaign
          </button>
        )}

        {status === 'RUNNING' && (
          <button
            type="button"
            onClick={() => void act('pause')}
            disabled={busy}
            className="rounded-lg border border-[var(--border)] px-4 py-1.5 text-sm disabled:opacity-50"
          >
            Pause
          </button>
        )}

        {status === 'PAUSED' && (
          <button
            type="button"
            onClick={() => void act('resume')}
            disabled={busy}
            className="rounded-lg bg-[var(--accent)] px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            Resume
          </button>
        )}

        {(status === 'DRAFT' || status === 'READY' || status === 'PAUSED') && (
          <button
            type="button"
            onClick={() => void act('cancel')}
            disabled={busy}
            className="rounded-lg border border-[var(--border)] px-4 py-1.5 text-sm text-[var(--muted)] disabled:opacity-50"
          >
            Cancel
          </button>
        )}
      </div>

      {confirming && (
        <div className="max-w-md rounded-lg border border-[var(--accent)] bg-[var(--accent-soft)] px-4 py-3 text-sm">
          <p className="font-medium">
            {mocked
              ? `This will run the campaign against ${deliverableCount} lead(s) in mock mode.`
              : `This will send ${deliverableCount} real email(s) from your connected Gmail account.`}
          </p>

          {!mocked && (
            <p className="mt-1 text-xs text-[var(--muted)]">
              Messages that have already gone out cannot be recalled. Pausing stops the ones that
              have not.
            </p>
          )}

          <label className="mt-3 block text-xs">
            Type <strong>{CONFIRM_WORD}</strong> to confirm
            <input
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm"
              autoComplete="off"
            />
          </label>

          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={busy || typed.trim().toUpperCase() !== CONFIRM_WORD}
              onClick={() => void act('start')}
              className="rounded-lg bg-[var(--accent)] px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40"
            >
              {busy ? 'Starting…' : 'Start sending'}
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirming(false);
                setTyped('');
              }}
              className="text-sm text-[var(--muted)] underline"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="max-w-md text-xs text-[var(--grade-d)]" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
