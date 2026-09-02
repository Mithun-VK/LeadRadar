/**
 * GET /api/leads — filtered, sorted, paginated lead list.
 *
 * Filters arrive as comma-separated query parameters and are parsed into typed
 * arrays. They are never interpolated into SQL: Prisma builds the query, and the
 * sort field is constrained to an enum so it cannot become an injection point.
 */
import { z } from 'zod';

import { handler } from '@/modules/api/handler';
import { listLeads, type LeadFilters, type LeadSortField } from '@/modules/database/repositories';
import { priorityLabel } from '@/modules/scoring/config';

/** Splits a comma-separated parameter, dropping blanks. */
const csv = z
  .string()
  .optional()
  .transform((value) =>
    value
      ? value
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry) => entry !== '')
      : undefined,
  );

const querySchema = z
  .object({
    city: csv,
    category: csv,
    googleWebsiteStatus: csv,
    independentWebsiteStatus: csv,
    digitalPresence: csv,
    priority: csv,
    service: csv,
    flags: csv,
    minRating: z.coerce.number().min(0).max(5).optional(),
    minReviews: z.coerce.number().int().min(0).optional(),
    minScore: z.coerce.number().int().min(0).max(100).optional(),
    maxWebsiteScore: z.coerce.number().int().min(0).max(100).optional(),
    hasEmail: z.enum(['true', 'false']).optional(),
    excludeChains: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => value === 'true'),
    searchJobId: z.string().min(1).optional(),
    search: z.string().trim().max(120).optional(),
    // Constrained to an enum: an arbitrary string here would be an ORDER BY
    // injection point.
    sortBy: z
      .enum(['opportunityScore', 'rating', 'reviewCount', 'createdAt', 'displayName'])
      .optional(),
    sortDir: z.enum(['asc', 'desc']).optional(),
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

export const GET = handler(
  async ({ tenant, query }) => {
    const filters: LeadFilters = {
      ...(query.city && { city: query.city }),
      ...(query.category && { category: query.category }),
      ...(query.googleWebsiteStatus && { googleWebsiteStatus: query.googleWebsiteStatus }),
      ...(query.independentWebsiteStatus && {
        independentWebsiteStatus: query.independentWebsiteStatus,
      }),
      ...(query.digitalPresence && { digitalPresence: query.digitalPresence }),
      ...(query.priority && { priority: query.priority }),
      ...(query.service && { service: query.service }),
      ...(query.minRating !== undefined && { minRating: query.minRating }),
      ...(query.minReviews !== undefined && { minReviews: query.minReviews }),
      ...(query.minScore !== undefined && { minScore: query.minScore }),
      ...(query.maxWebsiteScore !== undefined && { maxWebsiteScore: query.maxWebsiteScore }),
      ...(query.hasEmail !== undefined && { hasEmail: query.hasEmail === 'true' }),
      ...(query.flags && { flags: query.flags }),
      ...(query.excludeChains && { excludeChains: true }),
      ...(query.searchJobId && { searchJobId: query.searchJobId }),
      ...(query.search && { search: query.search }),
    };

    const result = await listLeads(tenant, {
      filters,
      ...(query.sortBy && { sortBy: query.sortBy as LeadSortField }),
      ...(query.sortDir && { sortDir: query.sortDir }),
      ...(query.page !== undefined && { page: query.page }),
      ...(query.pageSize !== undefined && { pageSize: query.pageSize }),
    });

    return {
      ...result,
      rows: result.rows.map((row) => ({
        id: row.id,
        displayName: row.displayName,
        primaryCategory: row.primaryCategory,
        city: row.city,
        rating: row.rating,
        reviewCount: row.reviewCount,
        phone: row.phone,
        googleWebsiteStatus: row.googleWebsiteStatus,
        independentWebsiteStatus: row.independentWebsiteStatus,
        verifiedDomain: row.verifiedDomain,
        digitalPresence: row.digitalPresence,
        opportunityScore: row.opportunityScore,
        websiteQualityScore: row.websiteQualityScore,
        opportunityFlags: row.opportunityFlags,
        // The address itself, not merely a boolean: an operator scanning the
        // table for who to contact wants to see it.
        primaryEmail: row.primaryEmail,
        leadPriority: row.leadPriority,
        priorityLabel: row.leadPriority ? priorityLabel(row.leadPriority) : null,
        identityVerification: row.identityVerification,
        isChain: row.isChain,
        recommendedServices: row.recommendations.map((rec) => rec.service),
        topPitch: row.recommendations[0]?.reasons.at(-1) ?? null,
        verificationConfidence: row.verifications[0]?.confidence ?? null,
        socialPlatforms: [...new Set(row.socialProfiles.map((p) => p.platform))],
      })),
    };
  },
  { querySchema },
);
