/**
 * Jobs.
 *
 * Shows the funnel per search — discovered, filtered, enriched, qualified — rather
 * than a bare progress bar. The funnel is what tells a user their filters were too
 * strict, which is the most common reason a search "found nothing".
 */
import Link from 'next/link';

import { formatMicros } from '@/config/pricing';
import { Card, EmptyState } from '@/components/ui/primitives';
import { db } from '@/modules/database/client';
import { requireTenant } from '@/modules/auth/tenant';
import { queueDepths } from '@/modules/jobs/queues';

export const metadata = { title: 'Jobs — LeadRadar' };
export const dynamic = 'force-dynamic';

const STATUS_COLOURS: Record<string, string> = {
  COMPLETED: 'var(--grade-a)',
  RUNNING: 'var(--accent)',
  PENDING: 'var(--muted)',
  FAILED: 'var(--grade-c)',
  PAUSED_BUDGET: 'var(--grade-c)',
  CANCELLED: 'var(--muted)',
};

export default async function JobsPage() {
  const tenant = await requireTenant();

  const [jobs, queues] = await Promise.all([
    db().searchJob.findMany({
      where: { organizationId: tenant.organizationId },
      orderBy: { createdAt: 'desc' },
      take: 30,
      include: { _count: { select: { cells: true } } },
    }),
    // Redis may be unavailable while the page still needs to render job history.
    queueDepths().catch(() => []),
  ]);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Jobs</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Search progress and the funnel at each stage.
        </p>
      </div>

      <Card title="Searches">
        {jobs.length === 0 ? (
          <EmptyState title="No searches yet" hint="Start one from the Search page." />
        ) : (
          <ul className="space-y-3">
            {jobs.map((job) => {
              const funnel = [
                { label: 'Discovered', value: job.discoveredCount },
                { label: 'Passed filters', value: job.filteredCount },
                { label: 'Enriched', value: job.enrichedCount },
                { label: 'Qualified', value: job.qualifiedCount },
              ];
              const widest = Math.max(1, job.discoveredCount);

              return (
                <li key={job.id} className="rounded-lg border border-[var(--border)] px-4 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Link
                        href={`/dashboard/leads?searchJobId=${job.id}`}
                        className="text-sm font-medium hover:underline"
                      >
                        {job.rawQuery}
                      </Link>
                      <div className="mt-0.5 text-[11px] text-[var(--muted)]">
                        {job.createdAt.toISOString().slice(0, 16).replace('T', ' ')} ·{' '}
                        {job._count.cells} geographic cells
                      </div>
                    </div>
                    <span
                      className="rounded border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide"
                      style={{
                        color: STATUS_COLOURS[job.status] ?? 'var(--muted)',
                        borderColor: STATUS_COLOURS[job.status] ?? 'var(--border)',
                      }}
                    >
                      {job.status.replace(/_/g, ' ').toLowerCase()}
                    </span>
                  </div>

                  {job.statusMessage && (
                    <p className="mt-2 text-xs text-[var(--grade-c)]">{job.statusMessage}</p>
                  )}

                  <div className="mt-3 space-y-1">
                    {funnel.map((stage) => (
                      <div key={stage.label} className="flex items-center gap-3 text-[11px]">
                        <span className="w-24 shrink-0 text-[var(--muted)]">{stage.label}</span>
                        <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--surface-muted)]">
                          <span
                            className="block h-full rounded-full bg-[var(--accent)]"
                            style={{ width: `${(stage.value / widest) * 100}%` }}
                          />
                        </span>
                        <span className="w-16 text-right tabular-nums">
                          {stage.value.toLocaleString('en-IN')}
                        </span>
                      </div>
                    ))}
                  </div>

                  <div className="mt-3 flex flex-wrap gap-4 text-[11px] text-[var(--muted)]">
                    <span>Estimated {formatMicros(job.estimatedCostMicros)}</span>
                    <span>Actual {formatMicros(job.actualCostMicros)}</span>
                    {job.errorCode && (
                      <span className="text-[var(--grade-c)]">{job.errorCode}</span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card
        title="Queue health"
        description="Dead-lettered jobs exhausted their retries and need a look; they are not retried automatically."
      >
        {queues.length === 0 ? (
          <EmptyState
            title="Queue metrics unavailable"
            hint="Redis is not reachable, or no worker has started yet."
          />
        ) : (
          <div className="table-scroll">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-left text-[11px] uppercase tracking-wide text-[var(--muted)]">
                  <th className="px-2 py-2 font-medium">Queue</th>
                  <th className="px-2 py-2 font-medium">Waiting</th>
                  <th className="px-2 py-2 font-medium">Active</th>
                  <th className="px-2 py-2 font-medium">Delayed</th>
                  <th className="px-2 py-2 font-medium">Failed</th>
                  <th className="px-2 py-2 font-medium">Dead-lettered</th>
                  <th className="px-2 py-2 font-medium">State</th>
                </tr>
              </thead>
              <tbody>
                {queues.map((queue) => (
                  <tr key={queue.name} className="border-b border-[var(--border)] last:border-0">
                    <td className="px-2 py-2 font-mono text-xs">{queue.name}</td>
                    <td className="px-2 py-2 tabular-nums">{queue.waiting}</td>
                    <td className="px-2 py-2 tabular-nums">{queue.active}</td>
                    <td className="px-2 py-2 tabular-nums">{queue.delayed}</td>
                    <td className="px-2 py-2 tabular-nums">{queue.failed}</td>
                    <td
                      className="px-2 py-2 tabular-nums"
                      style={{ color: queue.deadLettered > 0 ? 'var(--grade-c)' : undefined }}
                    >
                      {queue.deadLettered}
                    </td>
                    <td className="px-2 py-2 text-xs">
                      {queue.paused ? (
                        <span className="text-[var(--grade-c)]">paused</span>
                      ) : (
                        <span className="text-[var(--muted)]">running</span>
                      )}
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
