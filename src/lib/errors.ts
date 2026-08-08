/**
 * Error taxonomy.
 *
 * Errors carry a stable machine-readable `code`, a retryability hint the queue
 * layer uses to decide between backoff and dead-lettering, and a `safeMessage`
 * that is guaranteed free of secrets and provider internals so it can be shown
 * to a user or written to a log without review.
 *
 * Nothing in this codebase throws a bare `Error` across a module boundary, and
 * nothing swallows an error silently.
 */

export type ErrorCode =
  // configuration / programming
  | 'CONFIG_INVALID'
  | 'INVARIANT_VIOLATED'
  | 'NOT_IMPLEMENTED'
  // input
  | 'VALIDATION_FAILED'
  | 'QUERY_UNPARSEABLE'
  | 'UNSUPPORTED_QUERY'
  // authz / tenancy
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'TENANT_MISMATCH'
  | 'NOT_FOUND'
  // provider transport
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_QUOTA_EXCEEDED'
  | 'PROVIDER_AUTH_FAILED'
  | 'PROVIDER_BAD_REQUEST'
  | 'PROVIDER_BAD_RESPONSE'
  // AI layer
  | 'AI_SCHEMA_VIOLATION'
  | 'AI_REFUSED'
  | 'AI_LOW_CONFIDENCE'
  // security
  | 'URL_REJECTED'
  | 'SSRF_BLOCKED'
  | 'RESPONSE_TOO_LARGE'
  | 'CONTENT_TYPE_REJECTED'
  // cost control
  | 'BUDGET_EXCEEDED'
  | 'JOB_LIMIT_EXCEEDED'
  // infrastructure
  | 'DATABASE_ERROR'
  | 'QUEUE_ERROR'
  | 'CANCELLED'
  | 'INTERNAL';

/** Whether a failure is worth retrying, and if so how eagerly. */
export type Retryability = 'never' | 'transient' | 'after-delay';

export interface AppErrorOptions {
  code: ErrorCode;
  /** Developer-facing detail. May reference internals; never shown to users. */
  message: string;
  /**
   * User-facing detail. MUST NOT contain secrets, credentials, raw provider
   * payloads, SQL, or internal hostnames. Defaults to a generic sentence for
   * the code when omitted.
   */
  safeMessage?: string;
  retryability?: Retryability;
  /** Seconds to wait before retrying, when the provider told us. */
  retryAfterSeconds?: number;
  /** Structured, already-redacted context for logs. */
  context?: Record<string, unknown>;
  cause?: unknown;
}

const DEFAULT_RETRYABILITY: Record<ErrorCode, Retryability> = {
  CONFIG_INVALID: 'never',
  INVARIANT_VIOLATED: 'never',
  NOT_IMPLEMENTED: 'never',
  VALIDATION_FAILED: 'never',
  QUERY_UNPARSEABLE: 'never',
  UNSUPPORTED_QUERY: 'never',
  UNAUTHENTICATED: 'never',
  FORBIDDEN: 'never',
  TENANT_MISMATCH: 'never',
  NOT_FOUND: 'never',
  PROVIDER_UNAVAILABLE: 'transient',
  PROVIDER_TIMEOUT: 'transient',
  PROVIDER_RATE_LIMITED: 'after-delay',
  PROVIDER_QUOTA_EXCEEDED: 'after-delay',
  PROVIDER_AUTH_FAILED: 'never',
  PROVIDER_BAD_REQUEST: 'never',
  PROVIDER_BAD_RESPONSE: 'transient',
  AI_SCHEMA_VIOLATION: 'transient',
  AI_REFUSED: 'never',
  AI_LOW_CONFIDENCE: 'never',
  URL_REJECTED: 'never',
  SSRF_BLOCKED: 'never',
  RESPONSE_TOO_LARGE: 'never',
  CONTENT_TYPE_REJECTED: 'never',
  BUDGET_EXCEEDED: 'never',
  JOB_LIMIT_EXCEEDED: 'never',
  DATABASE_ERROR: 'transient',
  QUEUE_ERROR: 'transient',
  CANCELLED: 'never',
  INTERNAL: 'transient',
};

const DEFAULT_SAFE_MESSAGE: Record<ErrorCode, string> = {
  CONFIG_INVALID: 'The service is misconfigured.',
  INVARIANT_VIOLATED: 'An internal consistency check failed.',
  NOT_IMPLEMENTED: 'That capability is not available yet.',
  VALIDATION_FAILED: 'The request was not valid.',
  QUERY_UNPARSEABLE: 'That search could not be understood. Try rephrasing it.',
  UNSUPPORTED_QUERY: 'That search asks for something LeadRadar cannot do yet.',
  UNAUTHENTICATED: 'Sign in to continue.',
  FORBIDDEN: 'You do not have access to that.',
  TENANT_MISMATCH: 'You do not have access to that.',
  NOT_FOUND: 'Not found.',
  PROVIDER_UNAVAILABLE: 'An upstream data provider is unavailable. Retrying shortly.',
  PROVIDER_TIMEOUT: 'An upstream data provider timed out. Retrying shortly.',
  PROVIDER_RATE_LIMITED: 'Rate limited by an upstream provider. Work has been paused briefly.',
  PROVIDER_QUOTA_EXCEEDED: 'An upstream provider quota has been reached.',
  PROVIDER_AUTH_FAILED: 'An upstream provider rejected our credentials.',
  PROVIDER_BAD_REQUEST: 'An upstream provider rejected the request.',
  PROVIDER_BAD_RESPONSE: 'An upstream provider returned an unexpected response.',
  AI_SCHEMA_VIOLATION: 'The analysis step returned an unusable result.',
  AI_REFUSED: 'The analysis step declined to answer.',
  AI_LOW_CONFIDENCE: 'The result was not confident enough to accept automatically.',
  URL_REJECTED: 'That URL is not allowed.',
  SSRF_BLOCKED: 'That URL resolves to a blocked network address.',
  RESPONSE_TOO_LARGE: 'The remote page was too large to process.',
  CONTENT_TYPE_REJECTED: 'The remote resource was not a supported content type.',
  BUDGET_EXCEEDED: 'The configured API budget has been reached. Processing is paused.',
  JOB_LIMIT_EXCEEDED: 'This job reached its configured request limit.',
  DATABASE_ERROR: 'A storage error occurred.',
  QUEUE_ERROR: 'A background processing error occurred.',
  CANCELLED: 'The operation was cancelled.',
  INTERNAL: 'Something went wrong.',
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly safeMessage: string;
  readonly retryability: Retryability;
  readonly retryAfterSeconds?: number;
  readonly context: Record<string, unknown>;

  constructor(options: AppErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = 'AppError';
    this.code = options.code;
    this.safeMessage = options.safeMessage ?? DEFAULT_SAFE_MESSAGE[options.code];
    this.retryability = options.retryability ?? DEFAULT_RETRYABILITY[options.code];
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.context = options.context ?? {};
    Error.captureStackTrace?.(this, AppError);
  }

  get isRetryable(): boolean {
    return this.retryability !== 'never';
  }

  /** Shape written to logs. Contains no secrets by construction. */
  toLogObject(): Record<string, unknown> {
    return {
      errorCode: this.code,
      errorMessage: this.message,
      retryability: this.retryability,
      ...(this.retryAfterSeconds !== undefined && {
        retryAfterSeconds: this.retryAfterSeconds,
      }),
      ...this.context,
    };
  }

  /** Shape returned over HTTP. Deliberately minimal. */
  toPublicJSON(): { error: { code: ErrorCode; message: string } } {
    return { error: { code: this.code, message: this.safeMessage } };
  }
}

/** Narrowing helper. */
export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/**
 * Wraps an unknown thrown value into an AppError without losing the cause.
 * Used at module boundaries so no caller ever receives an untyped throw.
 */
export function toAppError(
  value: unknown,
  fallback: Omit<AppErrorOptions, 'cause'> = {
    code: 'INTERNAL',
    message: 'Unhandled error',
  },
): AppError {
  if (isAppError(value)) return value;

  const message =
    value instanceof Error ? value.message : typeof value === 'string' ? value : 'Unknown error';

  return new AppError({
    ...fallback,
    message: `${fallback.message}: ${message}`,
    cause: value,
  });
}

// ---------------------------------------------------------------------------
// Constructors for the codes used often enough to deserve one.
// ---------------------------------------------------------------------------

export function validationFailed(
  message: string,
  context?: Record<string, unknown>,
): AppError {
  return new AppError({ code: 'VALIDATION_FAILED', message, context });
}

export function notFound(resource: string, context?: Record<string, unknown>): AppError {
  return new AppError({
    code: 'NOT_FOUND',
    message: `${resource} not found`,
    safeMessage: `${resource} not found.`,
    context,
  });
}

export function tenantMismatch(context?: Record<string, unknown>): AppError {
  return new AppError({
    code: 'TENANT_MISMATCH',
    message: 'Resource belongs to a different organization',
    context,
  });
}

export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new AppError({ code: 'INVARIANT_VIOLATED', message });
  }
}

export function budgetExceeded(
  scope: 'job' | 'daily' | 'monthly',
  context?: Record<string, unknown>,
): AppError {
  return new AppError({
    code: 'BUDGET_EXCEEDED',
    message: `${scope} budget exhausted`,
    safeMessage: `The ${scope} API budget has been reached. Processing is paused.`,
    context: { budgetScope: scope, ...context },
  });
}
