/**
 * AI output schemas — the containment boundary.
 *
 * Every schema here is `.strict()`, and every one returns a CONSTRAINED verdict
 * plus a confidence and quoted evidence. Note what no schema permits: a phone
 * number, an address, a URL, a score, a SQL fragment, or free-form prose that
 * downstream code would act on.
 *
 * That is the design that bounds prompt injection. The model classifies facts
 * that deterministic code already extracted; it never supplies facts. A page
 * that successfully hijacks the model can, at most, cause one wrong enum value
 * on one lead — which the confidence bands then route to manual review.
 */
import { z } from 'zod';

/** Evidence must be short quoted spans, not arguments or invented claims. */
const evidenceSchema = z.array(z.string().max(240)).max(6).default([]);
const confidenceSchema = z.number().min(0).max(1);

export const websiteMatchOutputSchema = z
  .object({
    status: z.enum(['MATCH', 'PROBABLE_MATCH', 'PROBABLE_MISMATCH', 'MISMATCH', 'UNKNOWN']),
    matchedName: z.boolean(),
    matchedPhone: z.boolean(),
    matchedCity: z.boolean(),
    matchedCategory: z.boolean(),
    confidence: confidenceSchema,
    evidence: evidenceSchema,
  })
  .strict();

export type WebsiteMatchOutput = z.infer<typeof websiteMatchOutputSchema>;

export const digitalPresenceOutputSchema = z
  .object({
    level: z.enum(['EXCELLENT', 'GOOD', 'MODERATE', 'WEAK', 'MINIMAL']),
    reasons: z.array(z.string().max(160)).min(1).max(5),
    confidence: confidenceSchema,
    evidence: evidenceSchema,
  })
  .strict();

export type DigitalPresenceOutput = z.infer<typeof digitalPresenceOutputSchema>;

export const categoryOutputSchema = z
  .object({
    category: z.string().min(2).max(80),
    confidence: confidenceSchema,
  })
  .strict();

export const serviceRecommendOutputSchema = z
  .object({
    services: z
      .array(
        z
          .object({
            service: z.enum([
              'WEBSITE_DEVELOPMENT',
              'WEBSITE_REDESIGN',
              'SEO',
              'LOCAL_SEO',
              'SOCIAL_MEDIA_MARKETING',
              'CONTENT_MARKETING',
              'PAID_ADVERTISING',
              'BRANDING',
              'AI_AUTOMATION',
            ]),
            rationale: z.string().max(240),
          })
          .strict(),
      )
      .min(1)
      .max(4),
    confidence: confidenceSchema,
  })
  .strict();

/**
 * Narrative is the only task producing prose, and it is display-only: it never
 * feeds a decision, a filter, or a score. Length-capped so it cannot become a
 * channel for smuggled content.
 */
export const narrativeOutputSchema = z
  .object({
    summary: z.string().min(20).max(600),
    confidence: confidenceSchema,
    evidence: evidenceSchema,
  })
  .strict();

/** Chat completion envelope. */
export const chatCompletionSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable().optional(),
          role: z.string().optional(),
        }),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().optional(),
      completion_tokens: z.number().int().optional(),
      total_tokens: z.number().int().optional(),
    })
    .optional(),
  model: z.string().optional(),
});

export type ChatCompletion = z.infer<typeof chatCompletionSchema>;
