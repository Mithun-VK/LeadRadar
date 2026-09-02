/**
 * Shared outbound HTTP.
 *
 * Every provider call goes through here so that timeouts, response-size caps,
 * retry policy, and secret-safe error mapping exist once rather than three times
 * with three sets of bugs.
 *
 * Two properties worth stating explicitly:
 *
 *   - A response body is read with a hard byte ceiling, enforced WHILE
 *     streaming. Checking `content-length` is not protection: it is attacker- (or
 *     just bug-) controlled, and a chunked response has none.
 *   - Errors never carry raw response bodies into an AppError message without
 *     redaction, because provider errors routinely echo the request URL, and for
 *     Google that URL contains the API key.
 */
import { AppError, type ErrorCode } from '@/lib/errors';
import { redactSecrets } from '@/lib/logger';
import { err, ok, type Result } from '@/lib/result';

export interface HttpRequest {
  readonly url: string;
  readonly method?: 'GET' | 'POST';
  readonly headers?: Record<string, string>;
  /** JSON-serialised into the request body, with the content type set for you. */
  readonly body?: unknown;
  /**
   * Pre-encoded body, sent verbatim. Needed for OAuth token endpoints, which
   * require `application/x-www-form-urlencoded` rather than JSON. Callers must
   * set their own `content-type`. Ignored when `body` is also given.
   */
  readonly rawBody?: string;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  /** Identifies the provider in errors and logs. */
  readonly provider: string;
  readonly operation: string;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  readonly durationMs: number;
  readonly truncated: boolean;
}

const DEFAULT_TIMEOUT_MS = 15_000;
/** 5 MB: generous for an API response, far below anything that hurts memory. */
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Reads a body with a hard ceiling, aborting the stream once exceeded.
 *
 * Returns what was read plus a truncation flag rather than throwing: a truncated
 * JSON body is useless, but a truncated HTML page is often still verifiable, and
 * the caller knows which situation it is in.
 */
async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: '', truncated: false };

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  const chunks: string[] = [];
  let total = 0;
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      total += value.byteLength;
      if (total > maxBytes) {
        // Keep the portion up to the limit, then stop pulling.
        const keep = value.subarray(0, Math.max(0, value.byteLength - (total - maxBytes)));
        chunks.push(decoder.decode(keep, { stream: false }));
        truncated = true;
        break;
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    // Release the connection whether we finished or bailed out early.
    await reader.cancel().catch(() => undefined);
  }

  return { text: chunks.join(''), truncated };
}

/** Maps an HTTP status onto the error taxonomy, preserving retryability. */
export function statusToErrorCode(status: number): ErrorCode {
  if (status === 401 || status === 403) return 'PROVIDER_AUTH_FAILED';
  if (status === 429) return 'PROVIDER_RATE_LIMITED';
  if (status === 400 || status === 404 || status === 422) return 'PROVIDER_BAD_REQUEST';
  if (status >= 500) return 'PROVIDER_UNAVAILABLE';
  return 'PROVIDER_BAD_RESPONSE';
}

/** Parses `Retry-After`, accepting both the seconds and HTTP-date forms. */
export function parseRetryAfter(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (!raw) return undefined;

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);

  const date = Date.parse(raw);
  if (Number.isFinite(date)) {
    return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  }
  return undefined;
}

/** Single attempt, no retries. Retry policy lives in {@link requestWithRetry}. */
export async function request(input: HttpRequest): Promise<Result<HttpResponse>> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
  const started = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(input.url, {
      method: input.method ?? 'GET',
      headers: {
        accept: 'application/json',
        ...(input.body !== undefined && { 'content-type': 'application/json' }),
        ...input.headers,
      },
      body: input.body !== undefined ? JSON.stringify(input.body) : (input.rawBody ?? undefined),
      signal: controller.signal,
      // Redirects are not followed automatically: for provider APIs a redirect is
      // anomalous, and for scraped pages each hop must be re-validated by the
      // SSRF guard.
      redirect: 'manual',
    });

    const { text, truncated } = await readCapped(response, maxBytes);

    return ok({
      status: response.status,
      headers: response.headers,
      text,
      durationMs: Date.now() - started,
      truncated,
    });
  } catch (cause) {
    const aborted = cause instanceof Error && cause.name === 'AbortError';
    return err(
      new AppError({
        code: aborted ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE',
        message: aborted
          ? `${input.provider} ${input.operation} timed out after ${timeoutMs}ms`
          : `${input.provider} ${input.operation} transport error: ${redactSecrets(
              cause instanceof Error ? cause.message : String(cause),
            )}`,
        context: {
          provider: input.provider,
          operation: input.operation,
          durationMs: Date.now() - started,
        },
        cause,
      }),
    );
  } finally {
    clearTimeout(timer);
  }
}

export interface RetryOptions {
  readonly attempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
}

/**
 * Retries transient failures with exponential backoff and jitter.
 *
 * Jitter is not decoration: without it, a batch of workers that hit the same 429
 * retry in lockstep and reproduce the burst that caused it.
 *
 * A provider's own `Retry-After` always wins over our computed delay — it is
 * authoritative and ignoring it invites a longer ban.
 */
export async function requestWithRetry(
  input: HttpRequest,
  options: RetryOptions = {},
): Promise<Result<HttpResponse>> {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 400;
  const maxDelayMs = options.maxDelayMs ?? 8_000;

  let last: Result<HttpResponse> | undefined;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await request(input);
    last = result;

    if (result.ok) {
      const { status, headers } = result.value;
      const retryable = status === 429 || status >= 500;
      if (!retryable || attempt === attempts) return result;

      const serverDelay = parseRetryAfter(headers);
      const delay =
        serverDelay !== undefined
          ? serverDelay * 1000
          : Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1)) +
            Math.floor(Math.random() * baseDelayMs);

      await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    }

    if (!result.error.isRetryable || attempt === attempts) return result;

    const delay =
      Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1)) +
      Math.floor(Math.random() * baseDelayMs);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  return last!;
}

/** Parses JSON with a clear error rather than a raw SyntaxError. */
export function parseJson<T = unknown>(
  text: string,
  context: { provider: string; operation: string },
): Result<T> {
  try {
    return ok(JSON.parse(text) as T);
  } catch (cause) {
    return err(
      new AppError({
        code: 'PROVIDER_BAD_RESPONSE',
        message: `${context.provider} ${context.operation} returned invalid JSON`,
        // A snippet aids diagnosis; redacted in case the body echoes a key.
        context: { bodySnippet: redactSecrets(text.slice(0, 300)) },
        cause,
      }),
    );
  }
}
