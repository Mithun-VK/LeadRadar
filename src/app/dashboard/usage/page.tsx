/**
 * Cost control.
 *
 * Two things here are more useful than a spend total:
 *
 *   - Cost per qualified lead, because that is the unit an agency buys.
 *   - Estimate-vs-actual, because the funnel assumptions behind every pre-flight
 *     estimate are the least certain numbers in the system, and a systematic bias
 *     is invisible unless it is shown.
 */
import { formatMicros, usdToMicros } from '@/config/pricing';
import { env } from '@/lib/env';
import { Banner, Card, EmptyState, Stat } from '@/components/ui/primitives';
import { daysAgo } from '@/lib/time';
import { db } from '@/modules/database/client';
import { resolveTenant } from '@/modules/api/handler';
import { skuLabel, usageSummary } from '@/modules/database/repositories';
import { currentSpend } from '@/modules/providers/rate-limit';

export const metadata = { title: 'Cost — LeadRadar' };
export const dynamic = 'force-dynamic';

const PROVIDER_LABELS: Record<string, string> = {
  GOOGLE_PLACES: 'Google Places',
  FIRECRAWL: 'Firecrawl',
  GROQ: 'Groq',
};

export default async function UsagePage() {
  const tenant = await resolveTenant(new Request('http://localhost/dashboard/usage'));
  const config = env();
  const since = await daysAgo(30);

  const [summary, jobs, qualified, bySku, dailySpend, monthlySpend] = await Promise.all([
    usageSummary(tenant, since),
    db().searchJob.aggregate({
      where: { organizationId: tenant.organizationId, createdAt: { gte: since } },
      _count: { _all: true },
      _sum: { discoveredCount: true, actualCostMicros: true, estimatedCostMicros: true },
    }),
    db().business.count({
      where: {
        organizationId: tenant.organizationId,
        createdAt: { gte: since },
        leadPriority: { in: ['A_PLUS', 'A', 'B'] },
      },
    }),
    db().apiUsage.groupBy({
      by: ['unitKind'],
      where: { organizationId: tenant.organizationId, createdAt: { gte: since }, mocked: false },
      _count: { _all: true },
      _sum: { costMicros: true, units: true },
    }),
    currentSpend({ organizationId: tenant.organizationId, scope: 'daily' }),
    currentSpend({ organizationId: tenant.organizationId, scope: 'monthly' }),
  ]);

  const total = summary.totalCostMicros;
  const discovered = jobs._sum.discoveredCount ?? 0;
  const dailyLimit = usdToMicros(config.DAILY_BUDGET_USD);
  const monthlyLimit = usdToMicros(config.MONTHLY_BUDGET_USD);
  const estimated = jobs._sum.estimatedCostMicros ?? 0;
  const actual = jobs._sum.actualCostMicros ?? 0;
  const ratio = estimated > 0 ? actual / estimated : null;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Cost control</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">Last 30 days. Mocked calls are excluded from spend.</p>
      </div>

      {config.isMockMode && (
        <Banner tone="warn">
          Mock mode is active, so {summary.mockedCalls.toLocaleString('en-IN')} simulated calls are
          reported separately and contribute nothing to spend.
        </Banner>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Total spend" value={formatMicros(total)} hint={`${summary.totalCalls} calls`} />
        <Stat
          label="Per business"
          value={discovered > 0 ? formatMicros(Math.round(total / discovered)) : '—'}
          hint={`${discovered.toLocaleString('en-IN')} discovered`}
        />
        <Stat
          label="Per qualified lead"
          value={qualified > 0 ? formatMicros(Math.round(total / qualified)) : '—'}
          hint={`${qualified.toLocaleString('en-IN')} qualified`}
        />
        <Stat
          label="Failed calls"
          value={summary.failures.toLocaleString('en-IN')}
          hint="retried or dead-lettered"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Budgets" description="Enforced in Redis before each provider call, not after.">
          <div className="space-y-4">
            <BudgetBar label="Today" spent={dailySpend} limit={dailyLimit} />
            <BudgetBar label="This month" spent={monthlySpend} limit={monthlyLimit} />
          </div>
          <p className="mt-3 text-[11px] text-[var(--muted)]">
            Reaching a limit pauses processing and records an event; in-flight jobs are allowed to
            finish rather than being failed.
          </p>
        </Card>

        <Card
          title="Estimate accuracy"
          description="A systematic gap means the funnel assumptions need recalibrating."
        >
          {ratio === null ? (
            <EmptyState title="No completed searches yet" />
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <Stat label="Estimated" value={formatMicros(estimated)} />
                <Stat label="Actual" value={formatMicros(actual)} />
              </div>
              <p className="text-xs text-[var(--muted)]">
                Actual spend is <strong>{(ratio * 100).toFixed(0)}%</strong> of estimated.{' '}
                {ratio > 1.3
                  ? 'Estimates are running low — the funnel assumptions in ProviderPricingConfig understate real work.'
                  : ratio < 0.7
                    ? 'Estimates are running high — assumptions are conservative, which is the safer direction but discourages larger searches.'
                    : 'Estimates are tracking actual spend closely.'}
              </p>
            </div>
          )}
        </Card>
      </div>

      <Card title="Spend by provider">
        {summary.byProvider.length === 0 ? (
          <EmptyState title="No provider calls recorded yet" />
        ) : (
          <ul className="space-y-2">
            {summary.byProvider.map((row) => {
              const share = total > 0 ? (row.costMicros / total) * 100 : 0;
              return (
                <li key={row.provider} className="flex items-center gap-3 text-sm">
                  <span className="w-32 shrink-0">{PROVIDER_LABELS[row.provider] ?? row.provider}</span>
                  <span className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--surface-muted)]">
                    <span
                      className="block h-full rounded-full bg-[var(--accent)]"
                      style={{ width: `${share}%` }}
                    />
                  </span>
                  <span className="w-24 text-right tabular-nums">{formatMicros(row.costMicros)}</span>
                  <span className="w-16 text-right text-xs tabular-nums text-[var(--muted)]">
                    {row.calls}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card
        title="Spend by SKU"
        description="Which billing SKU consumed the budget. Google SKU choice is the largest single cost lever."
      >
        {bySku.length === 0 ? (
          <EmptyState title="No billable calls yet" />
        ) : (
          <div className="table-scroll">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-left text-[11px] uppercase tracking-wide text-[var(--muted)]">
                  <th className="px-2 py-2 font-medium">SKU</th>
                  <th className="px-2 py-2 font-medium">Calls</th>
                  <th className="px-2 py-2 font-medium">Units</th>
                  <th className="px-2 py-2 font-medium">Cost</th>
                </tr>
              </thead>
              <tbody>
                {bySku
                  .sort((a, b) => (b._sum.costMicros ?? 0) - (a._sum.costMicros ?? 0))
                  .map((row) => (
                    <tr key={row.unitKind} className="border-b border-[var(--border)] last:border-0">
                      <td className="px-2 py-2">{skuLabel(row.unitKind)}</td>
                      <td className="px-2 py-2 tabular-nums">{row._count._all}</td>
                      <td className="px-2 py-2 tabular-nums">{row._sum.units ?? 0}</td>
                      <td className="px-2 py-2 tabular-nums">
                        {formatMicros(row._sum.costMicros ?? 0)}
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

function BudgetBar({ label, spent, limit }: { label: string; spent: number; limit: number }) {
  const share = limit > 0 ? Math.min(100, (spent / limit) * 100) : 0;
  // Amber past 80%: an operator needs warning before a queue pauses, not after.
  const colour = share >= 100 ? 'var(--grade-c)' : share >= 80 ? 'var(--grade-c)' : 'var(--accent)';

  return (
    <div>
      <div className="flex items-baseline justify-between text-xs">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums text-[var(--muted)]">
          {formatMicros(spent)} of {formatMicros(limit)}
        </span>
      </div>
      <div className="mt-1 h-2 overflow-hidden rounded-full bg-[var(--surface-muted)]">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${share}%`, backgroundColor: colour }}
        />
      </div>
    </div>
  );
}
