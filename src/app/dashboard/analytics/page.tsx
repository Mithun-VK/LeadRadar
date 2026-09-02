import { Banner, Card, EmptyState, ScoreBar, Stat, flagLabel } from '@/components/ui/primitives';
import { currentSession } from '@/modules/auth/session';
import { campaignAnalytics, overviewAnalytics } from '@/modules/analytics/service';

export const metadata = { title: 'Analytics — LeadRadar' };
export const dynamic = 'force-dynamic';

export default async function AnalyticsPage() {
  const session = await currentSession();
  const tenant = { organizationId: session!.organizationId, userId: session!.userId };

  const [overview, campaigns] = await Promise.all([
    overviewAnalytics(tenant),
    campaignAnalytics(tenant),
  ]);

  const funnelMax = Math.max(...overview.funnel.map((stage) => stage.count), 1);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Analytics</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Counts of things that actually happened. No revenue or ROI figures — LeadRadar does not
          observe deal outcomes, and a number derived from an assumption is worse than no number.
        </p>
      </div>

      {overview.includesMockedSends && (
        <Banner tone="warn">
          Some counted messages were sent by the mock provider and reached nobody.
        </Banner>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Total leads" value={overview.leads.total.toLocaleString('en-IN')} />
        <Stat
          label="Qualified"
          value={overview.leads.qualified.toLocaleString('en-IN')}
          hint="Score 60 or above"
        />
        <Stat
          label="Hot leads"
          value={overview.leads.hot.toLocaleString('en-IN')}
          hint="Grade A or A+"
        />
        <Stat
          label="Contactable"
          value={overview.leads.withEmail.toLocaleString('en-IN')}
          hint="An address was found"
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Emails sent" value={overview.email.sent.toLocaleString('en-IN')} />
        <Stat label="Pending" value={overview.email.queued.toLocaleString('en-IN')} />
        <Stat
          label="Failed"
          value={(overview.email.failed + overview.email.bounced).toLocaleString('en-IN')}
        />
        <Stat
          label="Unsubscribed"
          value={overview.email.unsubscribed.toLocaleString('en-IN')}
          hint={`${overview.email.suppressed} suppressed in total`}
        />
      </div>

      <Card
        title="Conversion funnel"
        description="Distinct businesses at each stage, so a lead mailed by two campaigns is not counted twice."
      >
        <div className="space-y-3">
          {overview.funnel.map((stage) => (
            <div key={stage.key} className="flex items-center gap-3">
              <span className="w-28 shrink-0 text-xs text-[var(--muted)]">{stage.label}</span>
              <span
                className="h-5 rounded"
                style={{
                  width: `${Math.max(1, (stage.count / funnelMax) * 100)}%`,
                  backgroundColor: 'var(--accent)',
                  opacity: 0.75,
                }}
                aria-hidden
              />
              <span className="shrink-0 tabular-nums text-sm">
                {stage.count.toLocaleString('en-IN')}
              </span>
              {stage.conversionFromPrevious !== null && (
                <span className="shrink-0 text-[11px] text-[var(--muted)]">
                  {(stage.conversionFromPrevious * 100).toFixed(0)}% of previous
                </span>
              )}
            </div>
          ))}
        </div>

        <p className="mt-4 text-[11px] text-[var(--muted)]">{overview.notes.replies}</p>
      </Card>

      <Card
        title="Opportunity distribution"
        description="What is actually wrong across your leads — and therefore what you can sell."
      >
        {overview.opportunityDistribution.length === 0 ? (
          <EmptyState
            title="No opportunity data yet"
            hint="Flags are generated when leads are enriched and scored."
          />
        ) : (
          <div className="space-y-2">
            {overview.opportunityDistribution.slice(0, 12).map((entry) => (
              <div key={entry.flag} className="flex items-center gap-3">
                <span className="w-40 shrink-0 text-xs">{flagLabel(entry.flag)}</span>
                <ScoreBar value={entry.count} max={overview.leads.total || 1} />
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="Campaign performance">
        {campaigns.length === 0 ? (
          <EmptyState title="No campaigns yet" />
        ) : (
          <div className="table-scroll">
            <table className="w-full min-w-[700px] text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-left text-[11px] uppercase tracking-wide text-[var(--muted)]">
                  <th className="px-3 py-2 font-medium">Campaign</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Enrolled</th>
                  <th className="px-3 py-2 font-medium">Sent</th>
                  <th className="px-3 py-2 font-medium">Failed</th>
                  <th className="px-3 py-2 font-medium">Unsubscribed</th>
                  <th className="px-3 py-2 font-medium">Delivered</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((row) => (
                  <tr key={row.id} className="border-b border-[var(--border)] last:border-0">
                    <td className="px-3 py-2">{row.name}</td>
                    <td className="px-3 py-2 text-xs text-[var(--muted)]">{row.status}</td>
                    <td className="px-3 py-2 tabular-nums">{row.enrolled}</td>
                    <td className="px-3 py-2 tabular-nums">{row.sent}</td>
                    <td className="px-3 py-2 tabular-nums">{row.failed}</td>
                    <td className="px-3 py-2 tabular-nums">{row.unsubscribed}</td>
                    <td className="px-3 py-2 tabular-nums">
                      {row.deliveryRate === null ? '—' : `${(row.deliveryRate * 100).toFixed(0)}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="mt-4 text-[11px] text-[var(--muted)]">{overview.notes.revenue}</p>
      </Card>
    </div>
  );
}
