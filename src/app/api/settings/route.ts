/**
 * GET   /api/settings — effective configuration.
 * PATCH /api/settings — write the small set of preferences that are safe to edit.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT WRITABLE
 * ---------------------------------------------------------------------------
 *
 * Spending limits, provider mode, crawl ceilings, and the email daily limit stay
 * in environment configuration. Putting the budget guard behind a web form would
 * place the strongest cost control in the system behind its weakest boundary —
 * one compromised session, or one mis-click, and a spend ceiling designed to be
 * unbypassable becomes a text input.
 *
 * The values below are preferences: defaults for new campaigns and the operator's
 * own identity in outgoing mail. Getting one wrong costs an edit, not money.
 */
import { z } from 'zod';

import { env } from '@/lib/env';
import { handler } from '@/modules/api/handler';
import { db } from '@/modules/database/client';
import { DEFAULT_CAPS, DEFAULT_WEIGHTS, SIGNALS_VERSION } from '@/modules/scoring/config';
import { ANALYZER_VERSION, CATEGORY_WEIGHTS } from '@/modules/enrichment/website-analysis';
import { providers } from '@/modules/providers/registry';

/** Preferences an operator may change, with the bounds that keep them sane. */
const WRITABLE = {
  defaultSenderName: z.string().trim().min(1).max(80),
  defaultCompanyName: z.string().trim().min(1).max(120),
  defaultCampaignDailyLimit: z.number().int().min(1).max(500),
  defaultCampaignDelaySeconds: z.number().int().min(5).max(86_400),
  defaultUseAiPersonalization: z.boolean(),
} as const;

export const GET = handler(async ({ tenant }) => {
  const config = env();
  const registry = providers();

  const rows = await db().orgSetting.findMany({
    where: { organizationId: tenant.organizationId },
    select: { key: true, value: true },
  });

  const preferences: Record<string, unknown> = {};
  for (const row of rows) preferences[row.key] = row.value;

  return {
    /** Editable, tenant-scoped. */
    preferences: {
      defaultSenderName: preferences.defaultSenderName ?? null,
      defaultCompanyName: preferences.defaultCompanyName ?? null,
      defaultCampaignDailyLimit:
        preferences.defaultCampaignDailyLimit ?? Math.min(50, config.EMAIL_DAILY_LIMIT),
      defaultCampaignDelaySeconds:
        preferences.defaultCampaignDelaySeconds ?? Math.max(120, config.EMAIL_MIN_DELAY_SECONDS),
      defaultUseAiPersonalization: preferences.defaultUseAiPersonalization ?? false,
    },

    /**
     * Read-only, from the environment. Exposed so the dashboard can show the
     * effective configuration; no secret value is included, only whether each
     * credential is present.
     */
    runtime: {
      mode: registry.mode,
      mockMode: config.isMockMode,
      providers: {
        googleMaps: Boolean(config.GOOGLE_MAPS_API_KEY),
        firecrawl: Boolean(config.FIRECRAWL_API_KEY),
        groq: Boolean(config.GROQ_API_KEY),
        gmail: Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET),
      },
      aiModel: config.GROQ_MODEL,
      emailSendingEnabled: config.EMAIL_SENDING_ENABLED,
      emailDailyLimit: config.EMAIL_DAILY_LIMIT,
      emailMinDelaySeconds: config.EMAIL_MIN_DELAY_SECONDS,
      crawler: {
        maxResultsPerSearch: config.MAX_RESULTS_PER_SEARCH,
        maxGoogleRequestsPerJob: config.MAX_GOOGLE_REQUESTS_PER_JOB,
        maxFirecrawlRequestsPerJob: config.MAX_FIRECRAWL_REQUESTS_PER_JOB,
        maxGroqRequestsPerJob: config.MAX_GROQ_REQUESTS_PER_JOB,
        maxConcurrentJobs: config.MAX_CONCURRENT_JOBS,
      },
      budgets: {
        dailyUsd: config.DAILY_BUDGET_USD,
        monthlyUsd: config.MONTHLY_BUDGET_USD,
      },
      /** Explains why the form has fewer fields than the display. */
      readOnlyReason:
        'Spending limits, crawl ceilings, and provider mode are environment configuration. ' +
        'They are not editable from the web so that the budget guard cannot be changed by ' +
        'anyone who gains access to a session.',
    },

    scoring: {
      signalsVersion: SIGNALS_VERSION,
      weights: DEFAULT_WEIGHTS,
      caps: DEFAULT_CAPS,
    },

    websiteAnalysis: {
      analyzerVersion: ANALYZER_VERSION,
      categoryWeights: CATEGORY_WEIGHTS,
      performanceMeasured: false,
    },
  };
});

const patchSchema = z
  .object({
    defaultSenderName: WRITABLE.defaultSenderName.optional(),
    defaultCompanyName: WRITABLE.defaultCompanyName.optional(),
    defaultCampaignDailyLimit: WRITABLE.defaultCampaignDailyLimit.optional(),
    defaultCampaignDelaySeconds: WRITABLE.defaultCampaignDelaySeconds.optional(),
    defaultUseAiPersonalization: WRITABLE.defaultUseAiPersonalization.optional(),
  })
  .strict();

export const PATCH = handler(
  async ({ tenant, body }) => {
    const entries = Object.entries(body).filter(([, value]) => value !== undefined);

    for (const [key, value] of entries) {
      await db().orgSetting.upsert({
        where: { organizationId_key: { organizationId: tenant.organizationId, key } },
        update: { value: value as never, updatedByUserId: tenant.userId ?? null },
        create: {
          organizationId: tenant.organizationId,
          key,
          value: value as never,
          updatedByUserId: tenant.userId ?? null,
        },
      });
    }

    return { updated: entries.map(([key]) => key) };
  },
  { bodySchema: patchSchema, auditAction: 'settings.update' },
);
