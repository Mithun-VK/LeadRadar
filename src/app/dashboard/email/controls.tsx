'use client';

/**
 * Gmail connect / test / disconnect controls.
 *
 * The test button sends to the connected mailbox's own address and nowhere else
 * — there is no recipient field here because the API has no recipient parameter.
 * An arbitrary-recipient test control would be an open relay with a friendly
 * label.
 */
import { useState } from 'react';

import { api } from '@/lib/api-client';

interface TestResponse {
  sent: boolean;
  to: string;
  mocked: boolean;
  message: string;
}

export function GmailControls({
  connected,
  accountId,
}: {
  connected: boolean;
  accountId: string | null;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);

  async function sendTest(): Promise<void> {
    setBusy(true);
    setResult(null);
    setError(null);

    const response = await api.post<TestResponse>('/api/email/test', {});

    if (response.ok && response.data) setResult(response.data.message);
    else setError(response.error?.message ?? 'The test could not be sent.');

    setBusy(false);
  }

  async function disconnect(): Promise<void> {
    if (!accountId) return;
    setBusy(true);
    setError(null);

    const response = await api.delete<{ disconnected: boolean }>(
      `/api/email/gmail/account?id=${encodeURIComponent(accountId)}`,
    );

    if (response.ok) window.location.reload();
    else setError(response.error?.message ?? 'Could not disconnect the account.');

    setBusy(false);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <a
          href="/api/email/gmail/connect"
          className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white"
        >
          {connected ? 'Reconnect Gmail' : 'Connect Gmail'}
        </a>

        {connected && (
          <>
            <button
              type="button"
              onClick={() => void sendTest()}
              disabled={busy}
              className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm disabled:opacity-50"
            >
              {busy ? 'Sending…' : 'Send a test to yourself'}
            </button>

            {confirmingDisconnect ? (
              <span className="flex items-center gap-2 text-sm">
                <span className="text-[var(--muted)]">
                  Disconnect? Running campaigns will stop sending.
                </span>
                <button
                  type="button"
                  onClick={() => void disconnect()}
                  disabled={busy}
                  className="rounded-lg border border-[var(--grade-d)] px-3 py-1.5 text-sm text-[var(--grade-d)]"
                >
                  Yes, disconnect
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingDisconnect(false)}
                  className="text-sm text-[var(--muted)] underline"
                >
                  Cancel
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmingDisconnect(true)}
                className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--muted)]"
              >
                Disconnect
              </button>
            )}
          </>
        )}
      </div>

      {result && <p className="text-xs text-[var(--grade-a)]">{result}</p>}
      {error && (
        <p className="text-xs text-[var(--grade-d)]" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
