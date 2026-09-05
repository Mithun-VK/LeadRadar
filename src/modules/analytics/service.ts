/**
 * Analytics.
 *
 * Reports counts of things that happened. It does NOT report revenue, pipeline
 * value, ROI, or a conversion rate to closed business, because LeadRadar does not
 * observe any of those — an agency's deals close in conversations this system
 * never sees. A dashboard number that looks like revenue but is actually a guess
 * multiplied by an assumption is worse than no number, because someone will
 * eventually plan against it.
 *
 * Reply counts are similarly honest: the Gmail scope this product requests can
 * send but cannot read, so a reply is only ever recorded when a human marks it.
 * The figure is therefore labelled as manually recorded rather than measured.
 */
import { db, type TenantContext } from '@/modules/database/client';

export interface FunnelStage {
  readonly key: string;
  readonly label: string;
  readonly count: number;
  /** Share of the previous stage, or null for the first. */
  readonly conversionFromPrevious: number | null;
}

export interface OverviewAnalytics {
  readonly leads: {
    readonly total: number;
    readonly qualified: number;
    readonly hot: number;
    readonly withEmail: number;
    readonly withWebsite: number;
    readonly newLast7Days: number;
  };
  readonly email: {
    readonly sent: number;
    readonly queued: number;
    readonly failed: number;
    readonly bounced: number;
    readonly unsubscribed: number;
    readonly repliedManuallyRecorded: number;
    readonly suppressed: number;
    readonly sentLast7Days: number;
  };
  readonly campaigns: {
    readonly total: number;
    readonly running: number;
    readonly draft: number;
    readonly completed: number;
  };
  readonly funnel: readonly FunnelStage[];
  readonly opportunityDistribution: ReadonlyArray<{ flag: string; count: number }>;
  /** True when some of the counted messages were sent by a mock provider. */
  readonly includesMockedSends: boolean;
  /**
   * Caveats that travel WITH the numbers rather than living in UI copy.
   *
   * Attached here so every consumer — the dashboard, the API, anything built on
   * it later — carries the same statement of which figures are measurements and
   * which are not. A caveat that lives only in one page's markup is a caveat that
   * gets lost the first time someone reads the data somewhere else.
   */
  readonly notes: {
    readonly replies: string;
    readonly revenue: string;
    readonly mocked?: string;
  };
}

const REPLIES_NOTE =
  'Replies are detected by reading the connected mailbox and matching messages to threads ' +
  'LeadRadar started. A reply on a thread it did not start — someone writing to you from a ' +
  'different address, for instance — is not counted.';

const REVENUE_NOTE =
  'No revenue or ROI figures are reported. LeadRadar does not observe deal outcomes, ' +
  'and any such number would be an assumption rather than a measurement.';

const MOCKED_NOTE = 'Some counted messages were sent by the mock provider and reached nobody.';

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

export async function overviewAnalytics(tenant: TenantContext): Promise<OverviewAnalytics> {
  const org = { organizationId: tenant.organizationId };
  const sevenDaysAgo = daysAgo(7);

  const [
    totalLeads,
    qualifiedLeads,
    hotLeads,
    leadsWithEmail,
    leadsWithWebsite,
    newLeads,
    crawledLeads,
    contactedLeads,
    messagesByStatus,
    sentLast7,
    mockedSends,
    suppressedCount,
    campaignsByStatus,
    flagRows,
  ] = await Promise.all([
    db().business.count({ where: org }),
    db().business.count({ where: { ...org, opportunityScore: { gte: 60 } } }),
    db().business.count({ where: { ...org, leadPriority: { in: ['A_PLUS', 'A'] } } }),
    db().business.count({ where: { ...org, primaryEmail: { not: null } } }),
    db().business.count({
      where: { ...org, independentWebsiteStatus: 'INDEPENDENT_WEBSITE_FOUND' },
    }),
    db().business.count({ where: { ...org, createdAt: { gte: sevenDaysAgo } } }),
    db().business.count({ where: { ...org, enrichedAt: { not: null } } }),
    db().business.count({
      where: { ...org, emailMessages: { some: { status: 'SENT' } } },
    }),
    db().emailMessage.groupBy({
      by: ['status'],
      where: org,
      _count: { _all: true },
    }),
    db().emailMessage.count({ where: { ...org, status: 'SENT', sentAt: { gte: sevenDaysAgo } } }),
    db().emailMessage.count({ where: { ...org, mocked: true } }),
    db().suppressionEntry.count({ where: org }),
    db().campaign.groupBy({ by: ['status'], where: org, _count: { _all: true } }),
    /**
     * Flag distribution, aggregated in Postgres rather than in Node.
     *
     * This previously read up to 20,000 lead rows — the array column for every
     * lead — and counted them in a JavaScript loop. Measured at 10,000 leads
     * that made the overview 655ms at p95, five to twenty-five times slower than
     * any other query on the dashboard, and it was the landing page.
     *
     * `unnest` + `GROUP BY` does the same work in one indexed pass and returns
     * a handful of rows. It also fixes a quiet correctness bug: the old `take`
     * silently truncated at 20,000 leads, so beyond that the distribution was
     * simply wrong with nothing to indicate it.
     *
     * Raw because Prisma cannot express `unnest`. The organization id is a bound
     * parameter, never interpolated.
     */
    db().$queryRaw<Array<{ flag: string; count: number }>>`
      SELECT flag, count(*)::int AS count
      FROM businesses, unnest("opportunityFlags") AS flag
      WHERE "organizationId" = ${tenant.organizationId}
      GROUP BY flag
      ORDER BY count DESC, flag ASC
    `,
  ]);

  const messageCount = (status: string): number =>
    messagesByStatus.find((row) => row.status === status)?._count._all ?? 0;

  const campaignCount = (status: string): number =>
    campaignsByStatus.find((row) => row.status === status)?._count._all ?? 0;

  const sent = messageCount('SENT');
  const replied = messageCount('REPLIED');

  /**
   * The funnel counts distinct BUSINESSES at each stage, not events.
   *
   * Counting messages here would let one lead mailed by two campaigns appear
   * twice and produce a conversion rate above 100%, which is the sort of number
   * that quietly discredits a dashboard.
   */
  const funnel: FunnelStage[] = [
    { key: 'discovered', label: 'Discovered', count: totalLeads, conversionFromPrevious: null },
    {
      key: 'crawled',
      label: 'Crawled',
      count: crawledLeads,
      conversionFromPrevious: rate(crawledLeads, totalLeads),
    },
    {
      key: 'qualified',
      label: 'Qualified',
      count: qualifiedLeads,
      conversionFromPrevious: rate(qualifiedLeads, crawledLeads),
    },
    {
      key: 'contactable',
      label: 'Has email',
      count: leadsWithEmail,
      conversionFromPrevious: rate(leadsWithEmail, qualifiedLeads),
    },
    {
      key: 'contacted',
      label: 'Contacted',
      count: contactedLeads,
      conversionFromPrevious: rate(contactedLeads, leadsWithEmail),
    },
    {
      key: 'replied',
      label: 'Replied',
      count: replied,
      conversionFromPrevious: rate(replied, contactedLeads),
    },
  ];

  return {
    leads: {
      total: totalLeads,
      qualified: qualifiedLeads,
      hot: hotLeads,
      withEmail: leadsWithEmail,
      withWebsite: leadsWithWebsite,
      newLast7Days: newLeads,
    },
    email: {
      sent,
      queued: messageCount('QUEUED') + messageCount('SENDING'),
      failed: messageCount('FAILED'),
      bounced: messageCount('BOUNCED'),
      unsubscribed: messageCount('UNSUBSCRIBED'),
      repliedManuallyRecorded: replied,
      suppressed: suppressedCount,
      sentLast7Days: sentLast7,
    },
    campaigns: {
      total: campaignsByStatus.reduce((sum, row) => sum + row._count._all, 0),
      running: campaignCount('RUNNING'),
      draft: campaignCount('DRAFT'),
      completed: campaignCount('COMPLETED'),
    },
    funnel,
    // Already grouped and ordered by Postgres.
    opportunityDistribution: flagRows,
    includesMockedSends: mockedSends > 0,
    notes: {
      replies: REPLIES_NOTE,
      revenue: REVENUE_NOTE,
      ...(mockedSends > 0 && { mocked: MOCKED_NOTE }),
    },
  };
}

/** Share of the previous stage, or null when the previous stage is empty. */
function rate(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Number((current / previous).toFixed(4));
}

export interface CampaignAnalyticsRow {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly enrolled: number;
  readonly sent: number;
  readonly failed: number;
  readonly unsubscribed: number;
  readonly skipped: number;
  /** Sent as a share of enrolled. Null while nothing is enrolled. */
  readonly deliveryRate: number | null;
}

export async function campaignAnalytics(
  tenant: TenantContext,
): Promise<readonly CampaignAnalyticsRow[]> {
  const campaigns = await db().campaign.findMany({
    where: { organizationId: tenant.organizationId },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: {
      id: true,
      name: true,
      status: true,
      _count: { select: { leads: true } },
    },
  });

  const [leadStatuses, messageStatuses] = await Promise.all([
    db().campaignLead.groupBy({
      by: ['campaignId', 'status'],
      where: { campaignId: { in: campaigns.map((c) => c.id) } },
      _count: { _all: true },
    }),
    db().emailMessage.groupBy({
      by: ['campaignId', 'status'],
      where: { campaignId: { in: campaigns.map((c) => c.id) } },
      _count: { _all: true },
    }),
  ]);

  return campaigns.map((campaign) => {
    const leadCount = (status: string): number =>
      leadStatuses.find((row) => row.campaignId === campaign.id && row.status === status)?._count
        ._all ?? 0;
    const msgCount = (status: string): number =>
      messageStatuses.find((row) => row.campaignId === campaign.id && row.status === status)?._count
        ._all ?? 0;

    const enrolled = campaign._count.leads;
    const sent = msgCount('SENT');

    return {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      enrolled,
      sent,
      failed: msgCount('FAILED'),
      unsubscribed: msgCount('UNSUBSCRIBED') + leadCount('UNSUBSCRIBED'),
      skipped: leadCount('SKIPPED'),
      deliveryRate: enrolled === 0 ? null : Number((sent / enrolled).toFixed(4)),
    };
  });
}
