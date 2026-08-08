/**
 * POST /api/search/parse
 *
 * Turns natural language into validated filters and prices the search. No
 * discovery spend: the user reviews the criteria and the estimate before
 * committing, so a typo cannot become a bill.
 */
import { handler } from '@/modules/api/handler';
import { rawQuerySchema } from '@/schemas/query';
import { parseSearchQuery } from '@/modules/search/service';

export const POST = handler(
  async ({ tenant, body }) => parseSearchQuery(tenant, body.query),
  {
    bodySchema: rawQuerySchema,
    // Parsing costs a Groq call, so it is rate limited even though it is cheap.
    rateLimit: { capacity: 20, refillPerSecond: 0.5 },
  },
);
