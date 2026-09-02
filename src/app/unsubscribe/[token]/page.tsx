/**
 * Unsubscribe.
 *
 * Public, unauthenticated, and one click. A recipient who wants out must not be
 * asked to sign in, confirm twice, state a reason, or find anything — the whole
 * point of the promise made in the email footer is that it is trivially easy to
 * take up. Anything that adds friction here converts an unsubscribe into a spam
 * complaint, which is far worse for the sender.
 *
 * The action runs on GET rather than behind a form. That is unusual and
 * deliberate: some mail clients require a plain link, and the "correct" pattern
 * of a POST-only mutation would leave a portion of recipients unable to leave.
 * The token is single-purpose, random, and unguessable, and the only state it can
 * change is to stop mail — so the usual argument against a state-changing GET
 * (an attacker causing an unwanted effect) has no bite: causing someone to
 * receive less mail is not an attack worth defending against.
 */
import { processUnsubscribe } from '@/modules/email/send';

export const dynamic = 'force-dynamic';
export const metadata = {
  title: 'Unsubscribed',
  // Never index an unsubscribe URL: it contains a token.
  robots: { index: false, follow: false },
};

export default async function UnsubscribePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  // Always reports success, including for an unknown token. Telling a visitor
  // "that token is invalid" is unhelpful to them, and confirming which tokens
  // exist would let someone enumerate them.
  await processUnsubscribe(token);

  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-6 py-16">
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-6 py-8">
        <h1 className="text-lg font-semibold tracking-tight">You have been unsubscribed</h1>

        <p className="mt-3 text-sm text-[var(--muted)]">
          You will not receive any further emails from this sender. Nothing else is required from
          you, and you do not need to reply to this message.
        </p>

        <p className="mt-3 text-sm text-[var(--muted)]">
          If you received a message you consider spam, you can also report it directly in your email
          client — that signal reaches the sender&apos;s provider, not just the sender.
        </p>
      </div>
    </main>
  );
}
