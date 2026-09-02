import Link from 'next/link';

import { Banner, Card, EmptyState } from '@/components/ui/primitives';
import { currentSession } from '@/modules/auth/session';
import { campaignStats, listCampaigns } from '@/modules/email/campaigns';
import { getConnectedAccount } from '@/modules/email/gmail-account';
import { db } from '@/modules/database/client';
import { providers } from '@/modules/providers/registry';

export const metadata = { title: 'Campaigns — LeadRadar' };
export const dynamic = 'force-dynamic';

const STATUS_COLOURS: Record<string, string> = {
  DRAFT: 'var(--muted)',
  READY: 'var(--accent)',
  RUNNING: 'var(--grade-a)',
  PAUSED: 'var(--grade-c)',
  COMPLETED: 'var(--muted)',
  CANCELLED: 'var(--grade-d)',
};

export default async function CampaignsPage() {
  const session = await currentSession();
  const tenant = { organizationId: session!.organizationId, userId: session!.userId };

  const [result, account, templateCount] = await Promise.all([
    listCampaigns(tenant, { pageSize: 50 }),
    getConnectedAccount(tenant),
    db().emailTemplate.count({
      where: { organizationId: tenant.organizationId, isArchived: false },
    }),
  ]);

  const registry = providers();

  const rows = await Promise.all(
    result.rows.map(async (row) => ({ ...row, stats: await campaignStats(row.id) })),
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Campaigns</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Outreach sequences. Nothing sends until a campaign is explicitly activated.
          </p>
        </div>

        <Link
          href="/dashboard/campaigns/new"
          className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white"
        >
          New campaign
        </Link>
      </div>

      {registry.email?.isMock && (
        <Banner tone="warn">
          Mock mode: campaigns will run end to end, but every message is handled by an in-process
          sender and reaches nobody.
        </Banner>
      )}

      {!account && (
        <Banner tone="warn">
          No Gmail account is connected, so campaigns cannot send.{' '}
          <Link href="/dashboard/email" className="underline">
            Connect one
          </Link>
          .
        </Banner>
      )}

      {templateCount === 0 && (
        <Banner tone="warn">
          You have no email templates yet.{' '}
          <Link href="/dashboard/templates" className="underline">
            Create one
          </Link>{' '}
          before building a campaign.
        </Banner>
      )}

      <Card>
        {rows.length === 0 ? (
          <EmptyState
            title="No campaigns yet"
            hint="Create one, select leads from your list, review the generated emails, then activate."
          />
        ) : (
          <div className="table-scroll">
            <table className="w-full min-w-[900px] text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-left text-[11px] uppercase tracking-wide text-[var(--muted)]">
                  <th className="px-3 py-2 font-medium">Campaign</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Template</th>
                  <th className="px-3 py-2 font-medium">Leads</th>
                  <th className="px-3 py-2 font-medium">Sent</th>
                  <th className="px-3 py-2 font-medium">Failed</th>
                  <th className="px-3 py-2 font-medium">Pace</th>
                  <th className="px-3 py-2 font-medium">Created</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.id}
                    className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--surface-muted)]"
                  >
                    <td className="px-3 py-2">
                      <Link
                        href={`/dashboard/campaigns/${row.id}`}
                        className="font-medium hover:underline"
                      >
                        {row.name}
                      </Link>
                      {row.description && (
                        <div className="text-[11px] text-[var(--muted)]">{row.description}</div>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className="text-xs font-medium"
                        style={{ color: STATUS_COLOURS[row.status] ?? 'var(--muted)' }}
                      >
                        {row.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-[var(--muted)]">{row.template?.name ?? '—'}</td>
                    <td className="px-3 py-2 tabular-nums">{row._count.leads}</td>
                    <td className="px-3 py-2 tabular-nums">{row.stats.messages.SENT ?? 0}</td>
                    <td className="px-3 py-2 tabular-nums">
                      {(row.stats.messages.FAILED ?? 0) + (row.stats.messages.BOUNCED ?? 0)}
                    </td>
                    <td className="px-3 py-2 text-[11px] text-[var(--muted)]">
                      {row.dailyLimit}/day · {Math.round(row.delaySeconds / 60)} min apart
                    </td>
                    <td className="px-3 py-2 text-[11px] text-[var(--muted)]">
                      {row.createdAt.toLocaleDateString('en-IN')}
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
