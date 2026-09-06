/**
 * Structured logging.
 *
 * Three defences against leaking credentials, applied together because any one
 * of them can be bypassed by an unusual call site:
 *
 *   1. Path-based redaction for the field names secrets normally arrive under.
 *   2. Value-based scrubbing: the actual configured secret strings are replaced
 *      wherever they appear in a message. This catches the common real-world
 *      leak — an API key embedded in a URL inside a provider error message.
 *   3. Query-string stripping on anything URL-shaped, since Google Places keys
 *      travel as `?key=...`.
 *
 * Every log line carries a correlation id: `requestId` for HTTP, `jobId` for
 * queue work. Both are always present on child loggers created by the helpers
 * below, so an operator can follow one search end to end.
 */
import { createRequire } from 'node:module';

import { pino, type Logger as PinoLogger } from 'pino';

import { env } from './env';

export type Logger = PinoLogger;

/** Field names whose values are never logged, at any depth. */
const REDACT_PATHS = [
  'apiKey',
  'api_key',
  'key',
  'token',
  'accessToken',
  'refreshToken',
  'password',
  'secret',
  'authorization',
  'Authorization',
  'cookie',
  'Cookie',
  'setCookie',
  'encryptionKey',
  'DATABASE_URL',
  'REDIS_URL',
  'GOOGLE_MAPS_API_KEY',
  'GROQ_API_KEY',
  'FIRECRAWL_API_KEY',
  'ENCRYPTION_KEY',
  '*.apiKey',
  '*.token',
  '*.password',
  '*.secret',
  '*.authorization',
  'headers.authorization',
  'headers.cookie',
  'req.headers.authorization',
  'req.headers.cookie',
  'context.apiKey',
  'context.url',
];

const REDACTED = '[redacted]';

/**
 * Secret values collected from the environment, longest first so that a longer
 * secret is scrubbed before a shorter one that is a prefix of it.
 */
function secretValues(): string[] {
  try {
    const cfg = env();
    return [
      cfg.GOOGLE_MAPS_API_KEY,
      cfg.GROQ_API_KEY,
      cfg.FIRECRAWL_API_KEY,
      cfg.ENCRYPTION_KEY,
      cfg.DATABASE_URL,
      cfg.REDIS_URL,
    ]
      .filter((v): v is string => typeof v === 'string' && v.length >= 8)
      .sort((a, b) => b.length - a.length);
  } catch {
    // Logging must work even when configuration is invalid — that is precisely
    // when we need it most.
    return [];
  }
}

let cachedSecrets: string[] | undefined;

/**
 * Removes secret material from an arbitrary string. Exported because provider
 * adapters use it on upstream error bodies before those reach an AppError.
 */
export function redactSecrets(input: string): string {
  cachedSecrets ??= secretValues();

  let output = input;
  for (const secret of cachedSecrets) {
    output = output.replaceAll(secret, REDACTED);
  }

  // Credentials also hide in query strings and userinfo, which value matching
  // misses when the key is only a substring of a longer parameter.
  output = output.replace(
    /([?&](?:key|api_?key|token|access_token|password|secret)=)[^&\s"']+/gi,
    `$1${REDACTED}`,
  );
  output = output.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, `$1${REDACTED}@`);

  return output;
}

/** Test-only: forget memoised secret values after the environment changes. */
export function resetRedactionCache(): void {
  cachedSecrets = undefined;
}

/**
 * Whether `pino-pretty` can actually be loaded.
 *
 * It is a devDependency and the production container is built with
 * `--omit=dev`, so it is genuinely absent there. `pretty` is already false under
 * `NODE_ENV=production`, but the two conditions are not the same thing: running
 * the production image in mock mode — which is how the image is verified without
 * real provider credentials — sets `NODE_ENV=development` inside a tree that has
 * no `pino-pretty`, and pino would then fail to start the transport.
 *
 * A process that dies because a log *formatter* is missing has turned a cosmetic
 * dependency into a fatal one. Checking resolvability keeps the failure cosmetic:
 * no colours, same logs.
 */
function prettyAvailable(): boolean {
  try {
    // Resolved from the application root rather than `import.meta.url`: this
    // file is transpiled to CJS in some entry points, where `import.meta` is a
    // syntax error.
    createRequire(`${process.cwd()}/`).resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

function createRootLogger(): Logger {
  let level = 'info';
  let pretty = false;
  try {
    const cfg = env();
    level = cfg.LOG_LEVEL;
    pretty = !cfg.isProduction && !cfg.isTest && prettyAvailable();
  } catch {
    // Fall through to defaults; a config error will be logged by the caller.
  }

  return pino({
    level,
    base: { service: 'leadradar' },
    redact: { paths: REDACT_PATHS, censor: REDACTED },
    formatters: {
      level: (label) => ({ level: label }),
    },
    hooks: {
      // Applied to every log call, so no call site can forget it.
      logMethod(args, method) {
        const scrubbed = args.map((arg) =>
          typeof arg === 'string' ? redactSecrets(arg) : arg,
        );
        return method.apply(this, scrubbed as Parameters<typeof method>);
      },
    },
    serializers: {
      err: (error: unknown) => {
        if (error instanceof Error) {
          return {
            type: error.name,
            message: redactSecrets(error.message),
            stack: error.stack ? redactSecrets(error.stack) : undefined,
          };
        }
        return { message: redactSecrets(String(error)) };
      },
    },
    ...(pretty && {
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service' },
      },
    }),
  });
}

let root: Logger | undefined;

export function logger(): Logger {
  root ??= createRootLogger();
  return root;
}

/** Correlated logger for an HTTP request. */
export function requestLogger(requestId: string, bindings: Record<string, unknown> = {}): Logger {
  return logger().child({ requestId, ...bindings });
}

/** Correlated logger for a queue job. */
export function jobLogger(
  jobId: string,
  queue: string,
  bindings: Record<string, unknown> = {},
): Logger {
  return logger().child({ jobId, queue, ...bindings });
}

/**
 * Correlated logger for one outbound provider call. `provider` and `operation`
 * are always present so cost and latency can be grouped by SKU downstream.
 */
export function providerLogger(
  provider: string,
  operation: string,
  bindings: Record<string, unknown> = {},
): Logger {
  return logger().child({ provider, operation, ...bindings });
}

/** Test-only: drop the memoised root logger. */
export function resetLoggerCache(): void {
  root = undefined;
  cachedSecrets = undefined;
}
