/**
 * Firecrawl response schemas.
 *
 * Permissive by design: a scrape that returns metadata but no markdown is a real
 * outcome (a JS-only page, a parked domain), and rejecting it as malformed would
 * turn ordinary web decay into a job failure. The caller decides what a thin
 * page means — for LeadRadar, a thin page is itself a strong signal.
 */
import { z } from 'zod';

const searchItemSchema = z.object({
  url: z.string().min(1),
  title: z.string().optional(),
  description: z.string().optional(),
  position: z.number().int().optional(),
});

export const searchResponseSchema = z.object({
  success: z.boolean().optional(),
  data: z
    .object({
      web: z.array(searchItemSchema).optional(),
      news: z.array(searchItemSchema).optional(),
      images: z.array(z.unknown()).optional(),
    })
    .optional(),
  warning: z.string().optional(),
});

export type FirecrawlSearchResponse = z.infer<typeof searchResponseSchema>;

const pageMetadataSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  language: z.string().optional(),
  sourceURL: z.string().optional(),
  url: z.string().optional(),
  statusCode: z.number().int().optional(),
  error: z.string().optional(),
});

export const scrapeResponseSchema = z.object({
  success: z.boolean().optional(),
  data: z
    .object({
      markdown: z.string().optional(),
      html: z.string().optional(),
      links: z.array(z.string()).optional(),
      metadata: pageMetadataSchema.optional(),
    })
    .optional(),
  warning: z.string().optional(),
});

export type FirecrawlScrapeResponse = z.infer<typeof scrapeResponseSchema>;
