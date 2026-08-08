/**
 * Result type.
 *
 * Provider calls and enrichment steps fail routinely and unremarkably — a dead
 * website, a rate limit, an ambiguous match. Modelling those as return values
 * rather than exceptions keeps the pipeline readable and makes it impossible to
 * forget a failure case, because the type system will not let you reach `.value`
 * without checking `.ok` first.
 *
 * Exceptions remain reserved for genuinely exceptional conditions: bad config,
 * violated invariants, bugs.
 */
import { AppError, toAppError } from './errors';

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E = AppError> = { readonly ok: false; readonly error: E };
export type Result<T, E = AppError> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E = AppError>(error: E): Err<E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

/** Maps the success value, passing failures through untouched. */
export function mapResult<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

/**
 * Unwraps or throws. Use only where a failure genuinely is a bug — never to
 * dodge handling an expected provider failure.
 */
export function unwrap<T>(result: Result<T, AppError>): T {
  if (!result.ok) throw result.error;
  return result.value;
}

export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}

/** Runs a throwing async function and captures any failure as an Err. */
export async function attempt<T>(
  fn: () => Promise<T>,
  onError?: Parameters<typeof toAppError>[1],
): Promise<Result<T, AppError>> {
  try {
    return ok(await fn());
  } catch (error) {
    return err(toAppError(error, onError));
  }
}

/** Synchronous counterpart of {@link attempt}. */
export function attemptSync<T>(
  fn: () => T,
  onError?: Parameters<typeof toAppError>[1],
): Result<T, AppError> {
  try {
    return ok(fn());
  } catch (error) {
    return err(toAppError(error, onError));
  }
}

/**
 * Splits a batch of results, so a partially successful enrichment pass can
 * persist what worked and report what did not — the normal case at scale.
 */
export function partition<T, E>(results: readonly Result<T, E>[]): {
  values: T[];
  errors: E[];
} {
  const values: T[] = [];
  const errors: E[] = [];
  for (const result of results) {
    if (result.ok) values.push(result.value);
    else errors.push(result.error);
  }
  return { values, errors };
}
