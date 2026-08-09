'use client';

import { useState } from 'react';

import { api } from '@/lib/api-client';

/** Signed-in identity and sign-out. */
export function UserMenu({ email, role }: { email: string; role: string }) {
  const [signingOut, setSigningOut] = useState(false);

  async function signOut() {
    setSigningOut(true);
    await api.post('/api/auth/logout');
    // Full navigation rather than router.push: a client-side transition keeps the
    // Router Cache, so previously rendered lead data would remain in memory after
    // sign-out. A hard load discards it. The lint rule is a routing-style
    // preference; here correctness outweighs it.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = '/login';
  }

  return (
    <div className="flex items-center gap-3 text-xs">
      <span className="text-[var(--muted)]" title={`Role: ${role.toLowerCase()}`}>
        {email}
      </span>
      <button
        type="button"
        onClick={signOut}
        disabled={signingOut}
        className="rounded-md border border-[var(--border)] px-2 py-1 transition-colors hover:text-[var(--foreground)] disabled:opacity-50"
      >
        {signingOut ? 'Signing out…' : 'Sign out'}
      </button>
    </div>
  );
}
