/**
 * Structured query schema — the trust boundary for AI output.
 *
 * The natural-language parser is an LLM, and its output is untrusted by
 * definition: the input text may itself be an injection attempt, and the model
 * may hallucinate fields. This schema is the only gate. If a parsed query does
 * not satisfy it exactly, nothing executes.
 *
 * Design choices that matter:
 *
 *   - `.strict()` everywhere. An unknown key is a hard failure, not something
 *     to ignore. If the model invents `sqlFilter` or `rawQuery`, we find out
 *     here rather than discovering it downstream.
 *   - Every bound has a ceiling. An unbounded `maxResults` is a budget
 *     vulnerability, not merely a validation gap.
 *   - Location and category strings are constrained in shape and length, then
 *     used only as opaque text passed to the discovery provider. They never
 *     reach a query builder, a template, or a shell.
 */
import { z } from 'zod';

import type { StructuredQuery } from '@/types/domain';

/** Upper bounds, deliberately conservative; a search is a spending decision. */
export const QUERY_LIMITS = {
  maxCategories: 10,
  maxLocations: 25,
  maxCategoryLength: 80,
  maxLocationLength: 120,
  maxResultsCeiling: 10_000,
  maxRawQueryLength: 1_000,
} as const;

/**
 * Rejects control characters and the punctuation used to smuggle structure
 * (braces, angle brackets, backticks, semicolons). These strings are only ever
 * human-readable place and category names.
 */
const safeText = (max: number) =>
  z
    .string()
    .trim()
    .min(2)
    .max(max)
    .regex(
      /^[\p{L}\p{N}][\p{L}\p{N}\s,.'&()/-]*$/u,
      'Must contain only letters, numbers, spaces, and simple punctuation',
    );

export const categorySchema = safeText(QUERY_LIMITS.maxCategoryLength);
export const locationSchema = safeText(QUERY_LIMITS.maxLocationLength);

export const googleWebsiteStatusSchema = z.enum([
  'GOOGLE_WEBSITE_PRESENT',
  'GOOGLE_WEBSITE_NOT_LISTED',
  'GOOGLE_WEBSITE_IS_THIRD_PARTY_LISTING',
]);

export const websiteStatusFilterSchema = z.union([
  googleWebsiteStatusSchema,
  z.literal('ANY'),
]);

/**
 * Google's `minRating` accepts 0.0–5.0 in 0.5 increments. We accept any value
 * in range here and let the provider adapter round down to the nearest
 * supported step, then re-apply the exact threshold in deterministic filtering.
 * Rounding up would silently drop qualifying businesses the user asked for.
 */
const ratingSchema = z.number().min(0).max(5);
const reviewCountSchema = z.number().int().min(0).max(1_000_000);

export const structuredQuerySchema = z
  .object({
    categories: z
      .array(categorySchema)
      .min(1, 'At least one category is required')
      .max(QUERY_LIMITS.maxCategories),
    locations: z
      .array(locationSchema)
      .min(1, 'At least one location is required')
      .max(QUERY_LIMITS.maxLocations),
    minimumRating: ratingSchema.nullable().default(null),
    maximumRating: ratingSchema.nullable().default(null),
    minimumReviews: reviewCountSchema.nullable().default(null),
    maximumReviews: reviewCountSchema.nullable().default(null),
    websiteStatus: websiteStatusFilterSchema.default('ANY'),
    requireSocialPresence: z.boolean().nullable().default(null),
    excludeChains: z.boolean().default(false),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(QUERY_LIMITS.maxResultsCeiling)
      .nullable()
      .default(null),
  })
  .strict()
  .superRefine((query, ctx) => {
    if (
      query.minimumRating !== null &&
      query.maximumRating !== null &&
      query.minimumRating > query.maximumRating
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['minimumRating'],
        message: 'minimumRating cannot exceed maximumRating',
      });
    }
    if (
      query.minimumReviews !== null &&
      query.maximumReviews !== null &&
      query.minimumReviews > query.maximumReviews
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['minimumReviews'],
        message: 'minimumReviews cannot exceed maximumReviews',
      });
    }
    // Duplicate categories multiply cost with no benefit: each one becomes its
    // own fan-out across every geographic cell.
    const categories = new Set(query.categories.map((c) => c.toLowerCase()));
    if (categories.size !== query.categories.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['categories'],
        message: 'Categories must be unique',
      });
    }
    const locations = new Set(query.locations.map((l) => l.toLowerCase()));
    if (locations.size !== query.locations.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['locations'],
        message: 'Locations must be unique',
      });
    }
  });

export type ParsedStructuredQuery = z.infer<typeof structuredQuerySchema>;

/** Compile-time proof the schema and the domain type cannot drift apart. */
const _typeCheck: StructuredQuery = {} as ParsedStructuredQuery;
void _typeCheck;

/** Raw user input accepted by the parse endpoint. */
export const rawQuerySchema = z
  .object({
    query: z.string().trim().min(3).max(QUERY_LIMITS.maxRawQueryLength),
  })
  .strict();

/**
 * The exact shape the AI is asked to return: the structured query with no
 * defaults applied, so a missing field is visible rather than silently filled.
 * Used to validate the model's raw JSON before it is normalised.
 */
export const aiQueryParseSchema = z
  .object({
    categories: z.array(z.string()).max(QUERY_LIMITS.maxCategories),
    locations: z.array(z.string()).max(QUERY_LIMITS.maxLocations),
    minimumRating: z.number().nullable(),
    maximumRating: z.number().nullable(),
    minimumReviews: z.number().nullable(),
    maximumReviews: z.number().nullable(),
    websiteStatus: websiteStatusFilterSchema,
    requireSocialPresence: z.boolean().nullable(),
    excludeChains: z.boolean(),
    maxResults: z.number().nullable(),
    confidence: z.number().min(0).max(1),
    /** Spans quoted from the user's own text; never invented claims. */
    evidence: z.array(z.string().max(200)).max(10),
  })
  .strict();

export type AiQueryParse = z.infer<typeof aiQueryParseSchema>;
