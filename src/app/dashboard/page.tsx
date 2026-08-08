/**
 * Overview.
 *
 * Answers three questions an agency operator has on opening the tool: what have I
 * got, what is it costing, and is anything stuck. Deliberately not a chart wall —
 * the numbers here are the ones that drive a decision.
 */
import Link from 'next/link';

import { formatMicros } from '@/config/pricing';
import { env } from '@/lib/env';
import { Banner, Card, EmptyState, GradeBadge, Stat } from '@/components/ui/primitives';
import { daysAgo } from '@/lib/time';
import { db } from '@/modules/database/client';
import { resolveTenant } from '@/modules/api/handler';
import { usageSummary } from '@/modules/database/repositories';

export const metadata = { title: 'Overview — LeadRadar' };
export const dynamic = 'force-dynamic';

export default async function OverviewPage() {
  const tenant = await resolveTenant(new Request('http://localhost/dashboard'));
  const since = await daysAgo(30);

  const [byGrade, totals, usage, recentJobs, events] = await Promise.all([
    db().business.groupBy({
      by: ['leadPriority'],
      where: { organizationId: tenant.organizationId },
      _count: { _all: true },
    }),
    db().business.aggregate({
      where: { organizationId: tenant.organizationId },
      _count: { _all: true },
    }),
    usageSummary(tenant, since),
    db().searchJob.findMany({
      where: { organizationId: tenant.organizationId },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: {
        id: true,
        rawQuery: true,
        status: true,
        discoveredCount: true,
        qualifiedCount: true,
        actualCostMicros: true,
        createdAt: true,
      },
    }),
    // Surfaced prominently: budget exhaustion and coverage gaps are things an
    // operator must see, not discover in a log.
    db().systemEvent.findMany({
      where: {
        OR: [{ organizationId: tenant.organizationId }, { organizationId: null }],
        level: { in: ['WARN', 'ERROR'] },
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
    }),
  ]);

  const gradeCounts = new Map(byGrade.map((row) => [row.leadPriority ?? 'UNSCORED', row._count._all]));
  const qualified =
    (gradeCounts.get('A_PLUS') ?? 0) + (gradeCounts.get('A') ?? 0) + (gradeCounts.get('B') ?? 0);
  const config = env();

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Overview</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">Last 30 days.</p>
        </div>
        <Link
          href="/dashboard/search"
          className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white"
        >
          New search
        </Link>
      </div>

      {config.isMockMode && (
        <Banner tone="warn">
          Mock mode is active. Every business shown is fabricated sample data — do not contact
          anyone from this list. Set <code>MOCK_EXTERNAL_APIS=false</code> and supply provider
          credentials for real results.
        </Banner>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Total leads" value={totals._count._all.toLocaleString('en-IN')} />
        <Stat
          label="Qualified (A+/A/B)"
          value={qualified.toLocaleString('en-IN')}
          hint="worth a call"
        />
        <Stat
          label="Provider spend"
          value={formatMicros(usage.totalCostMicros)}
          hint={`${usage.totalCalls.toLocaleString('en-IN')} calls`}
        />
        <Stat
          label="Cost per qualified lead"
          value={qualified > 0 ? formatMicros(Math.round(usage.totalCostMicros / qualified)) : '—'}
          hint="the metric that matters"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Leads by grade" description="Grade is need × value × reach, capped by commercial judgement.">
          {totals._count._all === 0 ? (
            <EmptyState title="No leads yet" hint="Run your first search to populate this." />
          ) : (
            <ul className="space-y-2">
              {['A_PLUS', 'A', 'B', 'C', 'D', 'UNSCORED'].map((grade) => {
                const count = gradeCounts.get(grade) ?? 0;
                const share = totals._count._all > 0 ? (count / totals._count._all) * 100 : 0;

                return (
                  <li key={grade} className="flex items-center gap-3">
                    <span className="w-10">
                      {grade === 'UNSCORED' ? (
                        <span className="text-xs text-[var(--muted)]">—</span>
                      ) : (
                        <GradeBadge priority={grade} />
                      )}
                    </span>
                    <span className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--surface-muted)]">
                      <span
                        className="block h-full rounded-full bg-[var(--accent)]"
                        style={{ width: `${share}%` }}
                      />
                    </span>
                    <span className="w-16 text-right text-xs tabular-nums text-[var(--muted)]">
                      {count.toLocaleString('en-IN')}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card title="Recent searches">
          {recentJobs.length === 0 ? (
            <EmptyState title="No searches yet" />
          ) : (
            <ul className="space-y-2 text-sm">
              {recentJobs.map((job) => (
                <li key={job.id} className="rounded-lg border border-[var(--border)] px-3 py-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Link
                      href={`/dashboard/leads?searchJobId=${job.id}`}
                      className="truncate font-medium hover:underline"
                    >
                      {job.rawQuery}
                    </Link>
                    <span className="text-[11px] uppercase tracking-wide text-[var(--muted)]">
                      {job.status.toLowerCase()}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-3 text-[11px] text-[var(--muted)]">
                    <span>{job.discoveredCount.toLocaleString('en-IN')} found</span>
                    <span>{job.qualifiedCount.toLocaleString('en-IN')} qualified</span>
                    <span>{formatMicros(job.actualCostMicros)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {events.length > 0 && (
        <Card title="Attention required" description="Budget limits, coverage gaps, and provider problems.">
          <ul className="space-y-2 text-xs">
            {events.map((event) => (
              <li key={event.id} className="flex flex-wrap items-baseline gap-2">
                <span
                  className="font-mono text-[10px] uppercase"
                  style={{
                    color: event.level === 'ERROR' ? 'var(--grade-c)' : 'var(--muted)',
                  }}
                >
                  {event.code}
                </span>
                <span>{event.message}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
