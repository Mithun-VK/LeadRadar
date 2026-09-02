/**
 * GET    /api/email/suppression — list.
 * POST   /api/email/suppression — add manually.
 * DELETE /api/email/suppression — remove, but only a MANUAL entry.
 *
 * The list is readable on purpose. A suppression list an operator cannot inspect
 * is one they cannot honour when a person writes to ask "am I on your list?" —
 * and answering that question is part of what the list is for.
 */
import { z } from 'zod';

import { AppError } from '@/lib/errors';
import { handler } from '@/modules/api/handler';
import { listSuppressions, suppress, unsuppress } from '@/modules/email/suppression';

const querySchema = z
  .object({
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

export const GET = handler(
  async ({ tenant, query }) =>
    listSuppressions(tenant, {
      ...(query.page !== undefined && { page: query.page }),
      ...(query.pageSize !== undefined && { pageSize: query.pageSize }),
    }),
  { querySchema },
);

const postSchema = z
  .object({
    emails: z.array(z.string().trim().min(3).max(254)).min(1).max(1_000),
    detail: z.string().trim().max(300).optional(),
  })
  .strict();

export const POST = handler(
  async ({ tenant, body }) => {
    let added = 0;

    for (const email of body.emails) {
      // Always MANUAL from this endpoint: an operator adding an address by hand
      // is a different act from a recipient unsubscribing, and only the former
      // may later be undone.
      const result = await suppress(tenant, {
        email,
        reason: 'MANUAL',
        ...(body.detail && { detail: body.detail }),
      });
      if (result.added) added += 1;
    }

    return { requested: body.emails.length, added };
  },
  { bodySchema: postSchema, auditAction: 'suppression.add' },
);

const deleteSchema = z.object({ email: z.string().trim().min(3).max(254) }).strict();

export const DELETE = handler(
  async ({ tenant, body }) => {
    const result = await unsuppress(tenant, body.email);

    if (!result.removed && result.refusedReason) {
      /**
       * An unsubscribe or a bounce cannot be cleared.
       *
       * Removing an UNSUBSCRIBED entry would let an operator undo a recipient's
       * own decision, which is the exact thing the list exists to prevent.
       * Removing a BOUNCED entry would resume mailing an address the provider
       * already rejected, damaging the operator's own sending reputation.
       */
      throw new AppError({
        code: 'FORBIDDEN',
        message: `Cannot remove a ${result.refusedReason} suppression`,
        safeMessage:
          result.refusedReason === 'UNSUBSCRIBED'
            ? 'This person asked not to be contacted. That cannot be undone here.'
            : `This address was suppressed automatically (${result.refusedReason.toLowerCase()}) and cannot be removed.`,
      });
    }

    return { removed: result.removed };
  },
  { bodySchema: deleteSchema, auditAction: 'suppression.remove' },
);
