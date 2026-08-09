import { LoginForm } from '@/components/auth/login-form';
import { env } from '@/lib/env';

export const metadata = { title: 'Sign in — LeadRadar' };
export const dynamic = 'force-dynamic';

/**
 * Validates the post-login destination.
 *
 * Only a same-origin ABSOLUTE PATH is accepted. Without this check, `?next=` is a
 * textbook open redirect: an attacker sends a real LeadRadar login link that bounces
 * to their own page after a successful sign-in, which is a convincing phishing
 * primitive precisely because the login itself was genuine.
 *
 * Rejected: anything not starting with `/`, anything starting with `//` (protocol
 * relative, resolves to another host), and anything containing a backslash or
 * control character, which some browsers normalise into a host separator.
 */
function safeNext(raw: string | undefined): string {
  const fallback = '/dashboard';
  if (!raw) return fallback;
  if (!raw.startsWith('/')) return fallback;
  if (raw.startsWith('//')) return fallback;
  if (raw.includes('\\')) return fallback;
  if (/[\u0000-\u001f\u007f]/.test(raw)) return fallback;
  return raw;
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const rawNext = Array.isArray(params.next) ? params.next[0] : params.next;
  const next = safeNext(rawNext);
  const mockMode = env().isMockMode;

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-xl font-bold tracking-tight">
            Lead<span className="text-[var(--accent)]">Radar</span>
          </h1>
          <p className="mt-1 text-xs text-[var(--muted)]">
            Local-business prospecting and digital-opportunity intelligence
          </p>
        </div>

        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-sm">
          <LoginForm next={next} />
        </div>

        {mockMode && (
          <p className="mt-4 rounded-lg border border-[var(--grade-c)] px-3 py-2 text-[11px] text-[var(--grade-c)]">
            Mock mode is active — all business data is fabricated. The seeded
            development account is <strong>dev@leadradar.local</strong>; its password is
            printed by <code>npm run db:seed</code>.
          </p>
        )}
      </div>
    </main>
  );
}
