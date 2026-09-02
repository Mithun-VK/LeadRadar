import { Banner, Card, EmptyState } from '@/components/ui/primitives';
import { currentSession } from '@/modules/auth/session';
import { DEAL_STAGE_LABELS, formatMoney, listDeals, pipelineTotals } from '@/modules/crm/deals';

import { PipelineBoard } from './board';

export const metadata = { title: 'Pipeline — LeadRadar' };
export const dynamic = 'force-dynamic';

export default async function PipelinePage() {
  const session = await currentSession();
  const tenant = { organizationId: session!.organizationId, userId: session!.userId };

  const [deals, totals] = await Promise.all([listDeals(tenant), pipelineTotals(tenant)]);

  const open = totals.filter((total) => total.stage !== 'WON' && total.stage !== 'LOST');
  const openValue = open.reduce((sum, total) => sum + total.valueMinor, 0);
  const openWeighted = open.reduce((sum, total) => sum + total.weightedMinor, 0);
  const unvalued = totals.reduce((sum, total) => sum + total.unvaluedCount, 0);
  const wonValue = totals.find((total) => total.stage === 'WON')?.valueMinor ?? 0;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Pipeline</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Drag a deal between stages. Every move is recorded with the value at the time.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Open pipeline" value={formatMoney(openValue)} />
        <Metric
          label="Weighted"
          value={formatMoney(openWeighted)}
          hint="Value × probability"
        />
        <Metric label="Won" value={formatMoney(wonValue)} />
        <Metric label="Open deals" value={String(open.reduce((s, t) => s + t.count, 0))} />
      </div>

      {unvalued > 0 && (
        <Banner>
          {unvalued} deal(s) have no value entered. They are excluded from every figure above —
          not counted as zero. Add a value to include them.
        </Banner>
      )}

      {deals.length === 0 ? (
        <Card>
          <EmptyState
            title="No deals yet"
            hint="Open a deal from a lead once a conversation turns commercial."
          />
        </Card>
      ) : (
        <PipelineBoard
          deals={deals.map((deal) => ({
            id: deal.id,
            name: deal.name,
            stage: deal.stage,
            businessId: deal.businessId,
            businessName: deal.business.displayName,
            city: deal.business.city,
            valueLabel: formatMoney(deal.valueMinor, deal.currency),
            hasValue: deal.valueMinor !== null,
            probability: deal.probability,
            owner: deal.owner?.name ?? deal.owner?.email ?? null,
          }))}
          stageLabels={DEAL_STAGE_LABELS}
        />
      )}
    </div>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-4 py-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-[var(--muted)]">{hint}</div>}
    </div>
  );
}
