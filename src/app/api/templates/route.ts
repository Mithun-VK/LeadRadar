/**
 * GET  /api/templates — list, plus the supported variable vocabulary.
 * POST /api/templates — create, validating placeholders at save time.
 *
 * Validation happens here rather than at send time on purpose: an operator who
 * types {{buisness_name}} should be told immediately, while they are looking at
 * the template, rather than having a campaign refuse every one of its leads an
 * hour later for a reason that is hard to trace back to a typo.
 */
import { z } from 'zod';

import { AppError } from '@/lib/errors';
import { handler } from '@/modules/api/handler';
import { db } from '@/modules/database/client';
import {
  DEFAULT_TEMPLATE,
  PREVIEW_VALUES,
  TEMPLATE_VARIABLES,
  previewEmail,
  validateTemplate,
} from '@/modules/email/templates';

export const GET = handler(async ({ tenant }) => {
  const rows = await db().emailTemplate.findMany({
    where: { organizationId: tenant.organizationId, isArchived: false },
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true,
      name: true,
      description: true,
      subject: true,
      body: true,
      variables: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { campaigns: true } },
    },
  });

  return {
    rows: rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      subject: row.subject,
      body: row.body,
      variables: row.variables,
      campaignCount: row._count.campaigns,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      preview: previewEmail(row, PREVIEW_VALUES),
    })),
    /** The closed vocabulary, so the editor can offer it rather than guess. */
    availableVariables: Object.entries(TEMPLATE_VARIABLES).map(([name, description]) => ({
      name,
      description,
    })),
    starter: DEFAULT_TEMPLATE,
  };
});

const bodySchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).optional(),
    subject: z.string().trim().min(1).max(300),
    body: z.string().trim().min(20).max(10_000),
  })
  .strict();

export const POST = handler(
  async ({ tenant, body }) => {
    const validation = validateTemplate(body.subject, body.body);

    if (!validation.valid) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        message: `Template references unknown variables: ${validation.unknownVariables.join(', ')}`,
        safeMessage: `These placeholders are not available: ${validation.unknownVariables
          .map((name) => `{{${name}}}`)
          .join(', ')}. Check the list of supported variables.`,
        context: { unknownVariables: validation.unknownVariables },
      });
    }

    const template = await db().emailTemplate.create({
      data: {
        organizationId: tenant.organizationId,
        createdByUserId: tenant.userId ?? null,
        name: body.name,
        description: body.description ?? null,
        subject: body.subject,
        body: body.body,
        variables: [...validation.usedVariables],
      },
      select: { id: true, name: true, subject: true, body: true, variables: true },
    });

    return { ...template, preview: previewEmail(template, PREVIEW_VALUES) };
  },
  {
    bodySchema,
    auditAction: 'template.create',
    rateLimit: { capacity: 30, refillPerSecond: 0.5 },
  },
);
