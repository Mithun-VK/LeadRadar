/**
 * GET /api/usage — cost control dashboard.
 *
 * The headline metric is cost per QUALIFIED lead, not cost per business
 * discovered. Optimising the latter rewards volume; only the former tracks what
 * an agency actually buys.
 *
 * Estimate-vs-actual is reported too, because a systematically wrong funnel
 * assumption is invisible otherwise, and the funnel assumptions are the least
 * certain numbers in the whole system.
 */
import { z } from 'zod';

import { formatMicros, microsToUsd, usdToMicros } from '@/config/pricing';
import { env } from '@/lib/env';
import { handler } from '@/modules/api/handler';
import { db } from '@/modules/database/client';
import { usageSummary } from '@/modules/database/repositories';
import { currentSpend } from '@/modules/providers/rate-limit';
import { queueDepths } from '@/modules/jobs/queues';

const querySchema = z
  .object({ days: z.coerce.number().int().min(1).max(90).optional() })
  .strict();

export const GET = handler(
  async ({ tenant, query }) => {
    const days = query.days ?? 30;
    const since = new Date(Date.now() - days * 86_400_000);
    const config = env();

    const [summary, jobs, qualified, dailySpend, monthlySpend, queues] = await Promise.all([
      usageSummary(tenant, since),
      db().searchJob.aggregate({
        where: { organizationId: tenant.organizationId, createdAt: { gte: since } },
        _count: { _all: true },
        _sum: {
          discoveredCount: true,
          qualifiedCount: true,
          actualCostMicros: true,
          estimatedCostMicros: true,
        },
      }),
      db().business.count({
        where: {
          organizationId: tenant.organizationId,
          createdAt: { gte: since },
          leadPriority: { in: ['A_PLUS', 'A', 'B'] },
        },
      }),
      currentSpend({ organizationId: tenant.organizationId, scope: 'daily' }),
      currentSpend({ organizationId: tenant.organizationId, scope: 'monthly' }),
      // Operational rather than tenant data, but it belongs on this screen: a
      // stalled queue is the usual reason a cost report looks wrong.
      queueDepths().catch(() => []),
    ]);

    const totalCost = summary.totalCostMicros;
    const searches = jobs._count._all;
    const discovered = jobs._sum.discoveredCount ?? 0;
    const dailyLimit = usdToMicros(config.DAILY_BUDGET_USD);
    const monthlyLimit = usdToMicros(config.MONTHLY_BUDGET_USD);

    return {
      periodDays: days,
      providers: summary.byProvider.map((row) => ({
        ...row,
        costUsd: microsToUsd(row.costMicros),
        costFormatted: formatMicros(row.costMicros),
      })),
      totals: {
        costMicros: totalCost,
        costFormatted: formatMicros(totalCost),
        calls: summary.totalCalls,
        mockedCalls: summary.mockedCalls,
        failures: summary.failures,
        searches,
        businessesDiscovered: discovered,
        qualifiedLeads: qualified,
      },
      unitEconomics: {
        costPerSearchFormatted: searches > 0 ? formatMicros(Math.round(totalCost / searches)) : null,
        costPerBusinessFormatted:
          discovered > 0 ? formatMicros(Math.round(totalCost / discovered)) : null,
        costPerQualifiedLeadFormatted:
          qualified > 0 ? formatMicros(Math.round(totalCost / qualified)) : null,
      },
      estimateAccuracy: {
        estimatedMicros: jobs._sum.estimatedCostMicros ?? 0,
        actualMicros: jobs._sum.actualCostMicros ?? 0,
        ratio:
          (jobs._sum.estimatedCostMicros ?? 0) > 0
            ? Number(
                ((jobs._sum.actualCostMicros ?? 0) / (jobs._sum.estimatedCostMicros ?? 1)).toFixed(2),
              )
            : null,
      },
      budgets: {
        dailyLimitFormatted: formatMicros(dailyLimit),
        dailySpentFormatted: formatMicros(dailySpend),
        dailyUsedRatio: dailyLimit > 0 ? Number((dailySpend / dailyLimit).toFixed(3)) : 0,
        monthlyLimitFormatted: formatMicros(monthlyLimit),
        monthlySpentFormatted: formatMicros(monthlySpend),
        monthlyUsedRatio: monthlyLimit > 0 ? Number((monthlySpend / monthlyLimit).toFixed(3)) : 0,
      },
      mockMode: config.isMockMode,
      queues,
    };
  },
  { querySchema },
);
