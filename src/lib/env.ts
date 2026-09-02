/**
 * Environment configuration — validated once, at boot, then frozen.
 *
 * Rules enforced here (not by convention elsewhere):
 *   1. Every variable is parsed and typed. Nothing in the codebase reads
 *      `process.env` directly except this file.
 *   2. Boot fails loudly on invalid config rather than surfacing as a
 *      confusing runtime error deep inside a worker.
 *   3. This module is server-only. Importing it from a client component is
 *      a build/runtime error, so secrets cannot be bundled by accident.
 *   4. No secret value may be reachable through a NEXT_PUBLIC_* variable.
 *      This is checked against actual values, not just names.
 *   5. Live provider mode requires live credentials. Mock mode requires none.
 *      Production may not run in mock mode.
 */
import { z } from 'zod';

if (typeof window !== 'undefined') {
  throw new Error(
    'src/lib/env.ts was imported in a browser bundle. This module reads server ' +
      'secrets and must never reach the client. Import it only from server ' +
      'components, route handlers, or workers.',
  );
}

/** Accepts the several spellings a boolean takes in a shell or .env file. */
const booleanish = z
  .enum(['true', 'false', '1', '0', 'yes', 'no', ''])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

/** A positive integer bound, e.g. a per-job request ceiling. */
const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

/** A non-negative USD amount. */
const usd = (fallback: number) => z.coerce.number().nonnegative().default(fallback);

/** Optional secret: absent and empty-string both normalise to undefined. */
const optionalSecret = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v === '' ? undefined : v));

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    // --- datastores ---------------------------------------------------------
    DATABASE_URL: z
      .string()
      .min(1, 'DATABASE_URL is required')
      .refine(
        (v) => v.startsWith('postgres://') || v.startsWith('postgresql://'),
        'DATABASE_URL must be a PostgreSQL connection string',
      ),
    REDIS_URL: z
      .string()
      .min(1, 'REDIS_URL is required')
      .refine(
        (v) => v.startsWith('redis://') || v.startsWith('rediss://'),
        'REDIS_URL must start with redis:// or rediss://',
      ),

    // --- providers ----------------------------------------------------------
    GOOGLE_MAPS_API_KEY: optionalSecret,
    GROQ_API_KEY: optionalSecret,
    /**
     * Never hard-coded in application code. Defaulted here only so mock mode
     * and local development boot without configuration.
     */
    GROQ_MODEL: z.string().trim().min(1).default('openai/gpt-oss-20b'),
    FIRECRAWL_API_KEY: optionalSecret,

    // --- Gmail (outreach) ---------------------------------------------------
    /**
     * OAuth 2.0 client for sending on the operator's behalf.
     *
     * Optional at boot even in production: an operator may run LeadRadar purely
     * as a prospecting tool and never connect a mailbox. The failure is raised
     * when someone actually tries to connect Gmail, which is where it is
     * actionable — refusing to boot the whole application over an unused
     * optional feature would be worse.
     */
    GOOGLE_CLIENT_ID: optionalSecret,
    GOOGLE_CLIENT_SECRET: optionalSecret,
    GOOGLE_REDIRECT_URI: optionalSecret,

    /**
     * Master switch for outbound email.
     *
     * Off by default and deliberately so. Everything else in this product reads
     * public data; this is the one subsystem that acts in the world on the
     * operator's behalf and under their sending reputation. An operator must
     * turn it on knowingly rather than discover it running.
     */
    EMAIL_SENDING_ENABLED: booleanish.default(false),

    /** Organization-wide ceiling on messages per day, across all campaigns. */
    EMAIL_DAILY_LIMIT: positiveInt(50),
    /** Minimum seconds between sends. A burst is the fastest route to a spam label. */
    EMAIL_MIN_DELAY_SECONDS: positiveInt(60),
    /**
     * Public origin used to build unsubscribe links. Must be reachable by
     * recipients — a localhost link in a real email is a broken promise.
     */
    APP_PUBLIC_URL: z.string().trim().url().default('http://localhost:3000'),

    MOCK_EXTERNAL_APIS: booleanish.default(false),

    // --- cost + concurrency guardrails --------------------------------------
    MAX_RESULTS_PER_SEARCH: positiveInt(2000),
    MAX_GOOGLE_REQUESTS_PER_JOB: positiveInt(200),
    MAX_FIRECRAWL_REQUESTS_PER_JOB: positiveInt(1500),
    MAX_GROQ_REQUESTS_PER_JOB: positiveInt(500),
    MAX_CONCURRENT_JOBS: positiveInt(5),

    DAILY_BUDGET_USD: usd(5),
    MONTHLY_BUDGET_USD: usd(50),

    // --- crypto -------------------------------------------------------------
    /**
     * 32 bytes, hex-encoded. Required only in production; development and test
     * fall back to a well-known non-secret key so the app boots unconfigured.
     */
    /**
     * Preprocessed so an EMPTY value normalises to undefined BEFORE the regex
     * runs. Ordering matters: with `.regex().optional()` an empty string fails
     * the pattern rather than being treated as absent, which would break the
     * documented "copy .env.example and run" path — the file ships this key blank.
     */
    ENCRYPTION_KEY: z.preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
      z
        .string()
        .trim()
        .regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY must be 64 hex characters (32 bytes)')
        .optional(),
    ),

    // --- observability ------------------------------------------------------
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
  })
  .superRefine((cfg, ctx) => {
    // Mock mode is a development affordance. Shipping it to production would
    // silently serve fabricated leads to paying users.
    if (cfg.NODE_ENV === 'production' && cfg.MOCK_EXTERNAL_APIS) {
      ctx.addIssue({
        code: 'custom',
        path: ['MOCK_EXTERNAL_APIS'],
        message:
          'MOCK_EXTERNAL_APIS must be false in production — mock mode returns ' +
          'fabricated business data.',
      });
    }

    // Live mode without credentials fails here rather than on the first
    // provider call, halfway through a user's search job.
    if (!cfg.MOCK_EXTERNAL_APIS) {
      const missing = (
        [
          ['GOOGLE_MAPS_API_KEY', cfg.GOOGLE_MAPS_API_KEY],
          ['GROQ_API_KEY', cfg.GROQ_API_KEY],
          ['FIRECRAWL_API_KEY', cfg.FIRECRAWL_API_KEY],
        ] as const
      ).filter(([, value]) => !value);

      for (const [name] of missing) {
        ctx.addIssue({
          code: 'custom',
          path: [name],
          message:
            `${name} is required when MOCK_EXTERNAL_APIS=false. ` +
            'Set MOCK_EXTERNAL_APIS=true to run without provider credentials.',
        });
      }
    }

    if (cfg.NODE_ENV === 'production' && !cfg.ENCRYPTION_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['ENCRYPTION_KEY'],
        message: 'ENCRYPTION_KEY is required in production.',
      });
    }

    if (cfg.DAILY_BUDGET_USD > cfg.MONTHLY_BUDGET_USD) {
      ctx.addIssue({
        code: 'custom',
        path: ['DAILY_BUDGET_USD'],
        message: 'DAILY_BUDGET_USD cannot exceed MONTHLY_BUDGET_USD.',
      });
    }

    /**
     * Live sending needs a real OAuth client. Without one the connect flow would
     * fail halfway through, after the operator had already granted consent at
     * Google — a confusing place to discover a configuration error.
     *
     * Mock mode is exempt: it satisfies the same interface with an in-process
     * sender that delivers nowhere, which is exactly how the whole outreach
     * pipeline is exercised without credentials.
     */
    if (cfg.EMAIL_SENDING_ENABLED && !cfg.MOCK_EXTERNAL_APIS) {
      const missing = (
        [
          ['GOOGLE_CLIENT_ID', cfg.GOOGLE_CLIENT_ID],
          ['GOOGLE_CLIENT_SECRET', cfg.GOOGLE_CLIENT_SECRET],
          ['GOOGLE_REDIRECT_URI', cfg.GOOGLE_REDIRECT_URI],
        ] as const
      ).filter(([, value]) => !value);

      for (const [name] of missing) {
        ctx.addIssue({
          code: 'custom',
          path: [name],
          message:
            `${name} is required when EMAIL_SENDING_ENABLED=true. ` +
            'Set EMAIL_SENDING_ENABLED=false to run without outbound email.',
        });
      }
    }

    /**
     * A localhost unsubscribe link in a real email is unreachable by the
     * recipient, which turns a compliance obligation into a dead link.
     */
    if (
      cfg.NODE_ENV === 'production' &&
      cfg.EMAIL_SENDING_ENABLED &&
      /^https?:\/\/(localhost|127\.0\.0\.1)/i.test(cfg.APP_PUBLIC_URL)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['APP_PUBLIC_URL'],
        message:
          'APP_PUBLIC_URL must be a publicly reachable URL when sending email — ' +
          'recipients cannot open a localhost unsubscribe link.',
      });
    }

    if (cfg.EMAIL_MIN_DELAY_SECONDS < 5) {
      ctx.addIssue({
        code: 'custom',
        path: ['EMAIL_MIN_DELAY_SECONDS'],
        message:
          'EMAIL_MIN_DELAY_SECONDS below 5 sends faster than any human could, which reads as spam.',
      });
    }
  });

export type Env = z.infer<typeof schema> & {
  /** True when any provider credential is absent and mocks stand in. */
  readonly isMockMode: boolean;
  readonly isProduction: boolean;
  readonly isTest: boolean;
};

/**
 * Names that must never appear on a NEXT_PUBLIC_* variable, regardless of
 * value — a public var called NEXT_PUBLIC_GROQ_API_KEY is a mistake even if
 * it happens to be empty today.
 */
const SECRET_NAME_PATTERN = /(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|DATABASE_URL|REDIS_URL)/i;

/**
 * Fails the boot if a secret has been copied into a client-visible variable.
 * Checks names *and* values: a public var holding the same string as a known
 * secret is a leak even under an innocent name.
 */
function assertNoPublicSecrets(source: NodeJS.ProcessEnv, secretValues: string[]): void {
  const leaks: string[] = [];

  for (const [name, value] of Object.entries(source)) {
    if (!name.startsWith('NEXT_PUBLIC_')) continue;

    if (SECRET_NAME_PATTERN.test(name.slice('NEXT_PUBLIC_'.length))) {
      leaks.push(`${name} (name indicates a secret)`);
      continue;
    }
    if (value && secretValues.includes(value)) {
      leaks.push(`${name} (value matches a server secret)`);
    }
  }

  if (leaks.length > 0) {
    throw new Error(
      'Refusing to boot: secrets are exposed to the client bundle via ' +
        `NEXT_PUBLIC_* variables:\n  - ${leaks.join('\n  - ')}\n` +
        'Remove these variables. Secrets must stay server-side.',
    );
  }
}

/** Formats Zod issues into an actionable, secret-free error message. */
function formatIssues(error: z.ZodError): string {
  const lines = error.issues.map((issue) => {
    const key = issue.path.join('.') || '(root)';
    return `  - ${key}: ${issue.message}`;
  });
  return `Invalid environment configuration:\n${lines.join('\n')}`;
}

export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = schema.safeParse(source);
  if (!result.success) {
    // Never echo the offending values — they may be secrets.
    throw new Error(formatIssues(result.error));
  }

  const cfg = result.data;

  assertNoPublicSecrets(
    source,
    [cfg.GOOGLE_MAPS_API_KEY, cfg.GROQ_API_KEY, cfg.FIRECRAWL_API_KEY, cfg.ENCRYPTION_KEY].filter(
      (v): v is string => typeof v === 'string' && v.length > 0,
    ),
  );

  return Object.freeze({
    ...cfg,
    isMockMode: cfg.MOCK_EXTERNAL_APIS,
    isProduction: cfg.NODE_ENV === 'production',
    isTest: cfg.NODE_ENV === 'test',
  });
}

let cached: Env | undefined;

/**
 * The validated environment. Lazily parsed so that importing a module which
 * transitively imports env.ts does not crash a unit test that never uses it.
 */
export function env(): Env {
  cached ??= parseEnv();
  return cached;
}

/** Test-only: drop the memoised environment. */
export function resetEnvCache(): void {
  cached = undefined;
}
