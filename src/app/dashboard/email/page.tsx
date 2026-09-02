/**
 * Email settings: the Gmail connection and the suppression list.
 *
 * Deliberately the page where the consequences of sending are stated plainly.
 * An operator arriving here to connect a mailbox is about to give this
 * application the ability to send mail as them, and the trade — what it can and
 * cannot do with that access — belongs on this screen rather than in a document
 * nobody opens.
 */
import { Banner, Card, EmptyState } from '@/components/ui/primitives';
import { env } from '@/lib/env';
import { currentSession } from '@/modules/auth/session';
import { db } from '@/modules/database/client';
import { getConnectedAccount } from '@/modules/email/gmail-account';
import { providers } from '@/modules/providers/registry';

import { GmailControls } from './controls';

export const metadata = { title: 'Email — LeadRadar' };
export const dynamic = 'force-dynamic';

export default async function EmailPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const session = await currentSession();
  const config = env();
  const registry = providers();

  const tenant = { organizationId: session!.organizationId, userId: session!.userId };
  const account = await getConnectedAccount(tenant);

  const [suppressions, suppressionCount, recentMessages] = await Promise.all([
    db().suppressionEntry.findMany({
      where: { organizationId: tenant.organizationId },
      orderBy: { createdAt: 'desc' },
      take: 25,
      select: { id: true, email: true, reason: true, createdAt: true },
    }),
    db().suppressionEntry.count({ where: { organizationId: tenant.organizationId } }),
    db().emailMessage.findMany({
      where: { organizationId: tenant.organizationId },
      orderBy: { createdAt: 'desc' },
      take: 15,
      select: {
        id: true,
        toEmail: true,
        subject: true,
        status: true,
        mocked: true,
        sentAt: true,
        errorCode: true,
        createdAt: true,
      },
    }),
  ]);

  const callbackStatus = typeof params.gmail === 'string' ? params.gmail : null;
  const sendingPossible = config.EMAIL_SENDING_ENABLED || registry.mode === 'mock';

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Email</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Connect the mailbox campaigns send from, and manage who must never be contacted.
        </p>
      </div>

      {callbackStatus === 'connected' && (
        <Banner>Gmail account connected. Campaigns can now send from it.</Banner>
      )}
      {callbackStatus === 'declined' && (
        <Banner tone="warn">
          The Google consent screen was declined, so no mailbox was connected.
        </Banner>
      )}
      {callbackStatus === 'missing_scope' && (
        <Banner tone="warn">
          The connection was granted without permission to send. Connect again and leave the
          &ldquo;send email&rdquo; permission ticked.
        </Banner>
      )}
      {callbackStatus === 'error' && (
        <Banner tone="warn">
          Connecting Gmail failed
          {typeof params.reason === 'string' ? ` (${params.reason})` : ''}. Please try again.
        </Banner>
      )}

      {registry.email?.isMock && (
        <Banner tone="warn">
          Mock mode: messages are composed and accepted by an in-process sender and reach nobody.
          Nothing on this page sends real email.
        </Banner>
      )}

      {!sendingPossible && (
        <Banner tone="warn">
          Outbound email is disabled on this server. Set <code>EMAIL_SENDING_ENABLED=true</code> and
          configure the Google OAuth client to enable it.
        </Banner>
      )}

      <Card
        title="Sending mailbox"
        description="Campaigns send through the Gmail API using OAuth. No password is ever stored."
      >
        {account ? (
          <div className="space-y-3">
            <dl className="space-y-2 text-sm">
              <Row label="Address" value={account.emailAddress} />
              <Row
                label="Status"
                value={
                  account.healthy
                    ? 'Connected'
                    : `Needs reconnection (${account.invalidatedCode ?? 'revoked'})`
                }
                tone={account.healthy ? undefined : 'warn'}
              />
              <Row label="Connected" value={account.connectedAt.toLocaleString('en-IN')} />
              <Row
                label="Sent today"
                value={`${account.sentCountToday} of ${config.EMAIL_DAILY_LIMIT}`}
              />
            </dl>

            {!account.healthy && (
              <Banner tone="warn">
                Google has rejected the stored credentials, usually because access was revoked or
                the account password changed. Sending is stopped until the account is reconnected.
              </Banner>
            )}

            <GmailControls connected accountId={account.id} />
          </div>
        ) : (
          <div className="space-y-3">
            <EmptyState
              title="No mailbox connected"
              hint="Campaigns cannot send until a Gmail account is connected."
            />
            <GmailControls connected={false} accountId={null} />
          </div>
        )}

        <div className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-4 py-3 text-xs text-[var(--muted)]">
          <p className="font-medium text-[var(--foreground)]">What this access allows</p>
          <p className="mt-1">
            LeadRadar requests <code>gmail.send</code> and <code>gmail.readonly</code>. It can send
            mail as you, and it can <strong>read your mailbox</strong> in order to detect replies to
            campaigns it sent.
          </p>
          <p className="mt-1">
            What it does with what it reads is deliberately narrow. A message is stored{' '}
            <strong>only</strong> if it matches a thread LeadRadar started. Everything else — your
            accountant, your family, your other customers — is read during the scan, matched against
            nothing, and discarded without ever being written down.
          </p>
          <p className="mt-1">
            Stored reply text expires after 90 days. The fact that someone replied is kept, because
            it drives the pipeline; their words are not, because there is no continuing need for
            them.
          </p>
          <p className="mt-1">
            You can revoke this access at any time from your Google account&rsquo;s security
            settings, independently of this application. Sending stops immediately when you do.
          </p>
        </div>
      </Card>

      <Card
        title="Suppression list"
        description={`${suppressionCount.toLocaleString('en-IN')} address(es) that will never be contacted.`}
      >
        {suppressions.length === 0 ? (
          <EmptyState
            title="Nobody is suppressed"
            hint="Unsubscribes and bounces are added here automatically."
          />
        ) : (
          <div className="table-scroll">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-left text-[11px] uppercase tracking-wide text-[var(--muted)]">
                  <th className="px-3 py-2 font-medium">Address</th>
                  <th className="px-3 py-2 font-medium">Reason</th>
                  <th className="px-3 py-2 font-medium">Added</th>
                </tr>
              </thead>
              <tbody>
                {suppressions.map((entry) => (
                  <tr key={entry.id} className="border-b border-[var(--border)] last:border-0">
                    <td className="px-3 py-2">{entry.email}</td>
                    <td className="px-3 py-2 text-[var(--muted)]">{entry.reason}</td>
                    <td className="px-3 py-2 text-[var(--muted)]">
                      {entry.createdAt.toLocaleDateString('en-IN')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="mt-3 text-[11px] text-[var(--muted)]">
          Unsubscribes and bounces are permanent and cannot be removed here. Only entries you added
          manually can be cleared — an operator must not be able to undo a recipient&rsquo;s
          decision, and re-mailing a bounced address damages your own sending reputation.
        </p>
      </Card>

      <Card title="Recent messages" description="The last 15 messages, whatever their outcome.">
        {recentMessages.length === 0 ? (
          <EmptyState title="No messages yet" />
        ) : (
          <div className="table-scroll">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-left text-[11px] uppercase tracking-wide text-[var(--muted)]">
                  <th className="px-3 py-2 font-medium">To</th>
                  <th className="px-3 py-2 font-medium">Subject</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">When</th>
                </tr>
              </thead>
              <tbody>
                {recentMessages.map((message) => (
                  <tr key={message.id} className="border-b border-[var(--border)] last:border-0">
                    <td className="px-3 py-2">{message.toEmail}</td>
                    <td className="max-w-[20rem] truncate px-3 py-2 text-[var(--muted)]">
                      {message.subject}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className="text-xs"
                        style={{
                          color:
                            message.status === 'SENT'
                              ? 'var(--grade-a)'
                              : message.status === 'FAILED' || message.status === 'BOUNCED'
                                ? 'var(--grade-d)'
                                : 'var(--muted)',
                        }}
                      >
                        {message.status}
                      </span>
                      {message.mocked && (
                        <span className="ml-1 text-[10px] text-[var(--grade-c)]">mock</span>
                      )}
                      {message.errorCode && (
                        <div className="text-[10px] text-[var(--muted)]">{message.errorCode}</div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-[var(--muted)]">
                      {(message.sentAt ?? message.createdAt).toLocaleString('en-IN')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: 'warn' }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[var(--muted)]">{label}</dt>
      <dd
        className="text-right font-medium"
        style={tone === 'warn' ? { color: 'var(--grade-c)' } : undefined}
      >
        {value}
      </dd>
    </div>
  );
}
