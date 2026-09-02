/**
 * POST /api/campaigns/{id}/leads — enrol leads.
 *
 * Accepts either explicit ids or the same filter shape the leads table uses, so
 * "select everything matching my current filter" does not require the browser to
 * send ten thousand ids. The filter path is capped: an unbounded "enrol
 * everything" is how an operator accidentally builds a campaign far larger than
 * they intended to review.
 */
import { z } from 'zod';

import { handler } from '@/modules/api/handler';
import { db } from '@/modules/database/client';
import { enrolLeads } from '@/modules/email/campaigns';
import { leadWhere, type LeadFilters } from '@/modules/database/repositories';
import { providers } from '@/modules/providers/registry';

/** Ceiling on one enrolment, so a campaign stays reviewable by a human. */
const MAX_ENROL = 1_000;

const bodySchema = z
  .object({
    businessIds: z.array(z.string().min(1)).min(1).max(MAX_ENROL).optional(),
    filters: z
      .object({
        city: z.array(z.string()).optional(),
        category: z.array(z.string()).optional(),
        priority: z.array(z.string()).optional(),
        minScore: z.number().int().min(0).max(100).optional(),
        maxWebsiteScore: z.number().int().min(0).max(100).optional(),
        hasEmail: z.boolean().optional(),
        excludeChains: z.boolean().optional(),
        search: z.string().trim().max(120).optional(),
      })
      .strict()
      .optional(),
    limit: z.number().int().min(1).max(MAX_ENROL).optional(),
    excludeAlreadyContacted: z.boolean().optional(),
  })
  .strict()
  .refine((value) => value.businessIds !== undefined || value.filters !== undefined, {
    message: 'Provide either businessIds or filters',
  });

export const POST = handler(
  async ({ tenant, params, body }) => {
    let businessIds = body.businessIds ?? [];

    if (businessIds.length === 0 && body.filters) {
      const filters: LeadFilters = {
        ...(body.filters.city && { city: body.filters.city }),
        ...(body.filters.category && { category: body.filters.category }),
        ...(body.filters.priority && { priority: body.filters.priority }),
        ...(body.filters.minScore !== undefined && { minScore: body.filters.minScore }),
        ...(body.filters.excludeChains && { excludeChains: true }),
        ...(body.filters.search && { search: body.filters.search }),
      };

      const where = leadWhere(tenant, filters);

      // These two are campaign-specific rather than part of the general lead
      // filter vocabulary: "has an address" and "the website is weak enough to
      // be worth writing about".
      if (body.filters.hasEmail) where.primaryEmail = { not: null };
      if (body.filters.maxWebsiteScore !== undefined) {
        where.websiteQualityScore = { lte: body.filters.maxWebsiteScore };
      }

      const rows = await db().business.findMany({
        where,
        select: { id: true },
        orderBy: { opportunityScore: { sort: 'desc', nulls: 'last' } },
        take: Math.min(body.limit ?? MAX_ENROL, MAX_ENROL),
      });

      businessIds = rows.map((row) => row.id);
    }

    if (businessIds.length === 0) {
      return { requested: 0, enrolled: 0, skipped: 0, skipReasons: {} };
    }

    const registry = providers();

    return enrolLeads(tenant, params.id!, businessIds, {
      ...(body.excludeAlreadyContacted !== undefined && {
        excludeAlreadyContacted: body.excludeAlreadyContacted,
      }),
      ai: registry.ai,
    });
  },
  {
    bodySchema,
    auditAction: 'campaign.enrol',
    // Enrolment renders a preview per lead, which can involve an AI call each.
    rateLimit: { capacity: 10, refillPerSecond: 0.1 },
  },
);

/** DELETE — remove leads that have not yet been contacted. */
const deleteSchema = z
  .object({ businessIds: z.array(z.string().min(1)).min(1).max(MAX_ENROL) })
  .strict();

export const DELETE = handler(
  async ({ tenant, params, body }) => {
    const campaign = await db().campaign.findFirst({
      where: { id: params.id!, organizationId: tenant.organizationId },
      select: { id: true },
    });

    if (!campaign) return { removed: 0 };

    // Sent leads are never removed: the message exists, the recipient received
    // it, and deleting the record would make the campaign's history a lie.
    const { count } = await db().campaignLead.deleteMany({
      where: {
        campaignId: campaign.id,
        businessId: { in: body.businessIds },
        status: { in: ['PENDING', 'SKIPPED', 'QUEUED'] },
      },
    });

    return { removed: count };
  },
  { bodySchema: deleteSchema, auditAction: 'campaign.unenrol' },
);
