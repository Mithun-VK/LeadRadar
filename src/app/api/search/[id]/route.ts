/**
 * GET /api/search/:id — job status and progress.
 *
 * The id is looked up together with the tenant, so an id belonging to another
 * organization returns 404 rather than confirming that it exists.
 */
import { handler } from '@/modules/api/handler';
import { getSearchStatus } from '@/modules/search/service';

export const GET = handler(async ({ tenant, params }) => getSearchStatus(tenant, params.id ?? ''));
