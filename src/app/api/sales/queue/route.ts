/**
 * GET /api/sales/queue — everything that needs a human right now.
 */
import { handler } from '@/modules/api/handler';
import { buildWorkQueue } from '@/modules/crm/work-queue';
import { openActivityCounts } from '@/modules/crm/activities';

export const GET = handler(async ({ tenant }) => {
  const [queue, counts] = await Promise.all([
    buildWorkQueue(tenant),
    openActivityCounts(tenant),
  ]);

  return { ...queue, openActivityCounts: counts };
});
