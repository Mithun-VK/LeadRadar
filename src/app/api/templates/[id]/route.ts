/**
 * PATCH  /api/templates/{id} — edit.
 * DELETE /api/templates/{id} — archive (never hard-delete).
 */
import { z } from 'zod';

import { AppError, notFound } from '@/lib/errors';
import { handler } from '@/modules/api/handler';
import { db } from '@/modules/database/client';
import { PREVIEW_VALUES, previewEmail, validateTemplate } from '@/modules/email/templates';

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    subject: z.string().trim().min(1).max(300).optional(),
    body: z.string().trim().min(20).max(10_000).optional(),
  })
  .strict();

export const PATCH = handler(
  async ({ tenant, params, body }) => {
    const existing = await db().emailTemplate.findFirst({
      where: { id: params.id!, organizationId: tenant.organizationId },
      select: { id: true, subject: true, body: true },
    });

    if (!existing) throw notFound('Template', { templateId: params.id });

    const subject = body.subject ?? existing.subject;
    const templateBody = body.body ?? existing.body;
    const validation = validateTemplate(subject, templateBody);

    if (!validation.valid) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        message: `Template references unknown variables: ${validation.unknownVariables.join(', ')}`,
        safeMessage: `These placeholders are not available: ${validation.unknownVariables
          .map((name) => `{{${name}}}`)
          .join(', ')}.`,
      });
    }

    const updated = await db().emailTemplate.update({
      where: { id: existing.id },
      data: {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.description !== undefined && { description: body.description }),
        subject,
        body: templateBody,
        variables: [...validation.usedVariables],
      },
      select: { id: true, name: true, subject: true, body: true, variables: true },
    });

    return { ...updated, preview: previewEmail(updated, PREVIEW_VALUES) };
  },
  { bodySchema: patchSchema, auditAction: 'template.update' },
);

export const DELETE = handler(
  async ({ tenant, params }) => {
    /**
     * Archived, never deleted.
     *
     * A campaign that already sent using this template still references it, and
     * hard-deleting would break the record of what was sent. Archiving hides it
     * from the picker while keeping history intact.
     */
    const { count } = await db().emailTemplate.updateMany({
      where: { id: params.id!, organizationId: tenant.organizationId },
      data: { isArchived: true },
    });

    if (count === 0) throw notFound('Template', { templateId: params.id });
    return { archived: true };
  },
  { auditAction: 'template.archive' },
);
