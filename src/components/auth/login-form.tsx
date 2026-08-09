'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Sign-in form.
 *
 * The error message is whatever the server returned, which for a failed sign-in is
 * always the same generic sentence regardless of cause. That is intentional: a
 * friendlier "no account with that email" would let anyone enumerate which agencies
 * use LeadRadar.
 */
export function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Ensures the browser sends and stores the session cookie.
        credentials: 'same-origin',
        body: JSON.stringify({ email, password }),
      });

      const data = (await response.json()) as { ok?: boolean; error?: { message: string } };

      if (!response.ok || !data.ok) {
        setError(data.error?.message ?? 'Sign-in failed.');
        return;
      }

      // `next` is validated server-side to be a relative path, so this cannot be
      // used as an open redirect.
      router.push(next);
      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <label htmlFor="email" className="block text-xs font-medium text-[var(--muted)]">
          Email
        </label>
        <input
          id="email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
        />
      </div>

      <div>
        <label htmlFor="password" className="block text-xs font-medium text-[var(--muted)]">
          Password
        </label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
        />
      </div>

      {error && (
        <p role="alert" className="text-xs text-[var(--grade-c)]">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={submitting || email === '' || password === ''}
        className="w-full rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {submitting ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
