/**
 * GET /api/analytics/overview — headline counts, funnel, and opportunity mix.
 */
import { handler } from '@/modules/api/handler';
import { campaignAnalytics, overviewAnalytics } from '@/modules/analytics/service';

export const GET = handler(async ({ tenant }) => {
  const [overview, campaigns] = await Promise.all([
    overviewAnalytics(tenant),
    campaignAnalytics(tenant),
  ]);

  // `notes` travels inside `overview`, so the caveats are identical here and in
  // the dashboard rather than being restated (and eventually diverging).
  return { ...overview, campaignPerformance: campaigns };
});
