/**
 * Revenue analytics.
 *
 * ---------------------------------------------------------------------------
 * THE RULE: NEVER FABRICATE REVENUE
 * ---------------------------------------------------------------------------
 *
 * Every figure here is either a count of rows or a sum of values a human
 * actually entered. Nothing is estimated, imputed, or extrapolated.
 *
 * Concretely:
 *
 *   - A deal with no `valueMinor` is EXCLUDED from money sums and counted
 *     separately as `unvalued`. It is never treated as zero, because averaging a
 *     null in as zero drags every average down and understates the pipeline.
 *   - `revenueWon` sums only deals in stage WON with a value entered. There is
 *     no "estimated revenue", no "projected close", and no default deal size.
 *   - A rate whose denominator is zero is `null`, not 0 and not 100. "No data
 *     yet" and "nobody replied" are different facts, and rendering the first as
 *     0% invites someone to conclude the second.
 *
 * The reason this is stated so heavily: a revenue dashboard is the screen an
 * operator plans against. A number here that looks like money but is actually an
 * assumption is worse than a blank, because a blank prompts a question and a
 * fabricated figure does not.
 */
import { db, type TenantContext } from '@/modules/database/client';
import { statusesAtOrBeyond, type LeadStatus } from '@/modules/crm/lead-status';
import { formatMoney } from '@/modules/crm/deals';

export interface DateRange {
  readonly from: Date | null;
  readonly to: Date | null;
  readonly label: string;
}

/** The presets the dashboard offers, plus a custom range. */
export function presetRange(preset: string): DateRange {
  const now = new Date();
  const daysAgo = (days: number): Date => new Date(now.getTime() - days * 86_400_000);

  switch (preset) {
    case 'today': {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      return { from: start, to: null, label: 'Today' };
    }
    case '7d':
      return { from: daysAgo(7), to: null, label: 'Last 7 days' };
    case '30d':
      return { from: daysAgo(30), to: null, label: 'Last 30 days' };
    case '90d':
      return { from: daysAgo(90), to: null, label: 'Last 90 days' };
    case 'all':
    default:
      return { from: null, to: null, label: 'All time' };
  }
}

export interface FunnelStage {
  readonly key: string;
  readonly label: string;
  readonly count: number;
  /** Share of the PREVIOUS stage. Null when the previous stage is empty. */
  readonly conversionFromPrevious: number | null;
}

export interface RevenueMetrics {
  readonly range: { readonly label: string; readonly from: Date | null };

  readonly counts: {
    readonly leads: number;
    readonly qualified: number;
    readonly contacted: number;
    readonly replied: number;
    readonly meetings: number;
    readonly proposals: number;
    readonly won: number;
    readonly lost: number;
  };

  readonly money: {
    readonly currency: string;
    /** Open deals with a value entered. */
    readonly pipelineMinor: number;
    readonly weightedPipelineMinor: number;
    readonly revenueWonMinor: number;
    /** Mean value of WON deals that carry one. */
    readonly averageDealMinor: number | null;
    /** Deals excluded from the sums because nobody has valued them yet. */
    readonly unvaluedOpenDeals: number;
    readonly unvaluedWonDeals: number;
  };

  /** Every rate is null when its denominator is zero. */
  readonly rates: {
    readonly reply: number | null;
    readonly meeting: number | null;
    readonly proposal: number | null;
    readonly win: number | null;
    readonly leadToClient: number | null;
  };

  readonly funnel: readonly FunnelStage[];

  /** Caveats that travel with the numbers rather than living in UI copy. */
  readonly notes: {
    readonly replies: string;
    readonly unvalued: string | null;
    readonly revenue: string;
  };
}

/** Divides, returning null rather than a misleading zero. */
function rate(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return Number((numerator / denominator).toFixed(4));
}

export async function revenueMetrics(
  tenant: TenantContext,
  range: DateRange = presetRange('all'),
): Promise<RevenueMetrics> {
  const org = { organizationId: tenant.organizationId };
  const createdFilter = range.from ? { createdAt: { gte: range.from } } : {};

  /**
   * Stage counts are CUMULATIVE — a lead at PROPOSAL has also been contacted and
   * has also replied. Counting only leads *currently* at each status would
   * produce a funnel that narrows as deals progress, which is the opposite of
   * what a funnel means.
   */
  const atOrBeyond = (stage: LeadStatus) =>
    db().business.count({
      where: {
        ...org,
        ...createdFilter,
        leadStatus: { in: statusesAtOrBeyond(stage) },
      },
    });

  const [
    leads,
    qualified,
    contacted,
    replied,
    meetingsReached,
    proposalsReached,
    won,
    lost,
    openDeals,
    wonDeals,
  ] = await Promise.all([
    db().business.count({ where: { ...org, ...createdFilter } }),
    atOrBeyond('QUALIFIED'),
    atOrBeyond('CONTACTED'),
    atOrBeyond('REPLIED'),
    atOrBeyond('MEETING'),
    atOrBeyond('PROPOSAL'),
    db().business.count({ where: { ...org, ...createdFilter, leadStatus: 'WON' } }),
    db().business.count({ where: { ...org, ...createdFilter, leadStatus: 'LOST' } }),
    db().deal.findMany({
      where: { ...org, stage: { notIn: ['WON', 'LOST'] } },
      select: { valueMinor: true, probability: true, currency: true },
    }),
    db().deal.findMany({
      where: {
        ...org,
        stage: 'WON',
        ...(range.from && { closedAt: { gte: range.from } }),
      },
      select: { valueMinor: true, currency: true },
    }),
  ]);

  const valuedOpen = openDeals.filter((deal) => deal.valueMinor !== null);
  const valuedWon = wonDeals.filter((deal) => deal.valueMinor !== null);

  const pipelineMinor = valuedOpen.reduce((sum, deal) => sum + (deal.valueMinor ?? 0), 0);
  const weightedPipelineMinor = Math.round(
    valuedOpen.reduce((sum, deal) => sum + (deal.valueMinor ?? 0) * (deal.probability / 100), 0),
  );
  const revenueWonMinor = valuedWon.reduce((sum, deal) => sum + (deal.valueMinor ?? 0), 0);

  const unvaluedOpenDeals = openDeals.length - valuedOpen.length;
  const unvaluedWonDeals = wonDeals.length - valuedWon.length;

  // Currency is taken from the data rather than assumed. Mixed-currency
  // portfolios are not summed correctly by this and would need conversion; the
  // note below says so rather than silently adding rupees to dollars.
  const currencies = new Set([...openDeals, ...wonDeals].map((deal) => deal.currency));
  const currency = currencies.size === 1 ? [...currencies][0]! : 'INR';

  const funnelStages: Array<{ key: string; label: string; count: number }> = [
    { key: 'discovered', label: 'Discovered', count: leads },
    { key: 'qualified', label: 'Qualified', count: qualified },
    { key: 'contacted', label: 'Contacted', count: contacted },
    { key: 'replied', label: 'Replied', count: replied },
    { key: 'meeting', label: 'Meeting', count: meetingsReached },
    { key: 'proposal', label: 'Proposal', count: proposalsReached },
    { key: 'won', label: 'Won', count: won },
  ];

  const funnel: FunnelStage[] = funnelStages.map((stage, index) => ({
    ...stage,
    conversionFromPrevious:
      index === 0 ? null : rate(stage.count, funnelStages[index - 1]!.count),
  }));

  const unvaluedTotal = unvaluedOpenDeals + unvaluedWonDeals;

  return {
    range: { label: range.label, from: range.from },
    counts: {
      leads,
      qualified,
      contacted,
      replied,
      meetings: meetingsReached,
      proposals: proposalsReached,
      won,
      lost,
    },
    money: {
      currency,
      pipelineMinor,
      weightedPipelineMinor,
      revenueWonMinor,
      averageDealMinor:
        valuedWon.length === 0 ? null : Math.round(revenueWonMinor / valuedWon.length),
      unvaluedOpenDeals,
      unvaluedWonDeals,
    },
    rates: {
      reply: rate(replied, contacted),
      meeting: rate(meetingsReached, replied),
      proposal: rate(proposalsReached, meetingsReached),
      win: rate(won, proposalsReached),
      leadToClient: rate(won, qualified),
    },
    funnel,
    notes: {
      replies:
        'Replies are detected by reading the connected mailbox and matching messages ' +
        'to threads LeadRadar started. Replies on threads it did not start are not counted.',
      unvalued:
        unvaluedTotal > 0
          ? `${unvaluedTotal} deal(s) have no value entered and are excluded from every money figure above. They are not counted as zero.`
          : null,
      revenue:
        'Revenue is the sum of values entered on deals marked WON. Nothing here is ' +
        'estimated, projected, or imputed.' +
        (currencies.size > 1
          ? ' NOTE: deals exist in more than one currency and are summed without conversion — treat these totals as indicative only.'
          : ''),
    },
  };
}

/** Formats a metrics payload's money for display in one place. */
export function moneyLabels(metrics: RevenueMetrics) {
  const { money } = metrics;
  return {
    pipeline: formatMoney(money.pipelineMinor, money.currency),
    weightedPipeline: formatMoney(money.weightedPipelineMinor, money.currency),
    revenueWon: formatMoney(money.revenueWonMinor, money.currency),
    averageDeal: formatMoney(money.averageDealMinor, money.currency),
  };
}

export interface CampaignRevenueRow {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly enrolled: number;
  readonly contacted: number;
  readonly replies: number;
  readonly meetings: number;
  readonly proposals: number;
  readonly won: number;
  readonly revenueMinor: number;
  readonly revenueLabel: string;
  readonly replyRate: number | null;
  readonly unvaluedWonDeals: number;
}

/**
 * Campaign → revenue attribution.
 *
 * Joins through `Deal.sourceCampaignId`, which is stamped at deal creation from
 * the campaign that last emailed the lead. That is a LAST-TOUCH model and it is
 * stated plainly rather than dressed up: a lead emailed by two campaigns
 * attributes wholly to the second. Multi-touch attribution needs a weighting
 * model the operator should choose, not one this code picks silently.
 */
export async function campaignRevenue(
  tenant: TenantContext,
): Promise<readonly CampaignRevenueRow[]> {
  const campaigns = await db().campaign.findMany({
    where: { organizationId: tenant.organizationId },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: { id: true, name: true, status: true, _count: { select: { leads: true } } },
  });

  if (campaigns.length === 0) return [];

  const ids = campaigns.map((campaign) => campaign.id);

  const [sent, replies, deals] = await Promise.all([
    db().campaignLead.groupBy({
      by: ['campaignId'],
      where: { campaignId: { in: ids }, status: { in: ['SENT', 'REPLIED'] } },
      _count: { _all: true },
    }),
    db().campaignLead.groupBy({
      by: ['campaignId'],
      where: { campaignId: { in: ids }, status: 'REPLIED' },
      _count: { _all: true },
    }),
    db().deal.findMany({
      where: { organizationId: tenant.organizationId, sourceCampaignId: { in: ids } },
      select: { sourceCampaignId: true, stage: true, valueMinor: true, currency: true },
    }),
  ]);

  const countFor = (
    rows: Array<{ campaignId: string; _count: { _all: number } }>,
    id: string,
  ): number => rows.find((row) => row.campaignId === id)?._count._all ?? 0;

  return campaigns.map((campaign) => {
    const campaignDeals = deals.filter((deal) => deal.sourceCampaignId === campaign.id);
    const wonDeals = campaignDeals.filter((deal) => deal.stage === 'WON');
    const valuedWon = wonDeals.filter((deal) => deal.valueMinor !== null);

    const contacted = countFor(sent, campaign.id);
    const replyCount = countFor(replies, campaign.id);
    const revenueMinor = valuedWon.reduce((sum, deal) => sum + (deal.valueMinor ?? 0), 0);

    return {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      enrolled: campaign._count.leads,
      contacted,
      replies: replyCount,
      meetings: campaignDeals.filter((deal) =>
        ['MEETING', 'PROPOSAL', 'NEGOTIATION', 'WON'].includes(deal.stage),
      ).length,
      proposals: campaignDeals.filter((deal) =>
        ['PROPOSAL', 'NEGOTIATION', 'WON'].includes(deal.stage),
      ).length,
      won: wonDeals.length,
      revenueMinor,
      revenueLabel: formatMoney(revenueMinor),
      replyRate: rate(replyCount, contacted),
      unvaluedWonDeals: wonDeals.length - valuedWon.length,
    };
  });
}

export interface SourceRevenueRow {
  readonly source: string;
  readonly leads: number;
  readonly qualified: number;
  readonly won: number;
  readonly revenueMinor: number;
  readonly revenueLabel: string;
}

/** Which source produces the most qualified leads, clients, and revenue. */
export async function sourceAttribution(
  tenant: TenantContext,
): Promise<readonly SourceRevenueRow[]> {
  const [bySource, wonWithDeals] = await Promise.all([
    db().business.groupBy({
      by: ['source', 'leadStatus'],
      where: { organizationId: tenant.organizationId },
      _count: { _all: true },
    }),
    db().deal.findMany({
      where: { organizationId: tenant.organizationId, stage: 'WON' },
      select: { valueMinor: true, business: { select: { source: true } } },
    }),
  ]);

  const sources = [...new Set(bySource.map((row) => row.source))];

  return sources
    .map((source) => {
      const rows = bySource.filter((row) => row.source === source);
      const total = (statuses: LeadStatus[]): number =>
        rows
          .filter((row) => statuses.includes(row.leadStatus as LeadStatus))
          .reduce((sum, row) => sum + row._count._all, 0);

      const revenueMinor = wonWithDeals
        .filter((deal) => deal.business.source === source && deal.valueMinor !== null)
        .reduce((sum, deal) => sum + (deal.valueMinor ?? 0), 0);

      return {
        source,
        leads: rows.reduce((sum, row) => sum + row._count._all, 0),
        qualified: total(statusesAtOrBeyond('QUALIFIED')),
        won: total(['WON']),
        revenueMinor,
        revenueLabel: formatMoney(revenueMinor),
      };
    })
    .sort((a, b) => b.revenueMinor - a.revenueMinor || b.leads - a.leads);
}
