/**
 * Browser-side API client.
 *
 * Exists so no component has to remember the CSRF header. Every mutating request
 * in the app goes through here, which means "did we send the token?" is answered
 * once rather than per call site — and a forgotten header shows up as a 403 during
 * development rather than a silent hole in production.
 */

const CSRF_COOKIE = 'leadradar_csrf';
const CSRF_HEADER = 'x-csrf-token';

/** Reads the double-submit cookie. Readable by design; the binding HMAC is what protects it. */
function csrfToken(): string | undefined {
  if (typeof document === 'undefined') return undefined;

  const match = document.cookie
    .split('; ')
    .find((entry) => entry.startsWith(`${CSRF_COOKIE}=`));

  return match ? decodeURIComponent(match.slice(CSRF_COOKIE.length + 1)) : undefined;
}

export interface ApiError {
  readonly code: string;
  readonly message: string;
}

export interface ApiResult<T> {
  readonly ok: boolean;
  readonly status: number;
  readonly data?: T;
  readonly error?: ApiError;
}

async function request<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';

  if (method !== 'GET') {
    const token = csrfToken();
    if (token) headers[CSRF_HEADER] = token;
  }

  try {
    const response = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });

    const payload = (await response.json().catch(() => ({}))) as
      | (T & { error?: ApiError })
      | { error?: ApiError };

    if (!response.ok) {
      // A 401 means the session expired while the page was open; send the user to
      // sign in rather than leaving a dashboard that silently fails every action.
      if (response.status === 401 && typeof window !== 'undefined') {
        // Hard navigation on purpose: the session is gone, so every cached server
        // component payload in the Router Cache is now stale and must not be
        // re-shown. This module is not a component, so the router hook is
        // unavailable here in any case.
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
      }
      return {
        ok: false,
        status: response.status,
        error: (payload as { error?: ApiError }).error ?? {
          code: 'INTERNAL',
          message: 'Request failed.',
        },
      };
    }

    return { ok: true, status: response.status, data: payload as T };
  } catch {
    return {
      ok: false,
      status: 0,
      error: { code: 'NETWORK', message: 'Could not reach the server.' },
    };
  }
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
};
