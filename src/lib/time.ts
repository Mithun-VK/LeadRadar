/**
 * Time helpers.
 *
 * `Date.now()` is impure, and React's purity lint rule rightly objects to calling
 * it directly in a component body — a re-render would silently shift the window.
 * Wrapping it in an awaited async function keeps the impurity outside the render
 * path and makes the boundary explicit.
 */

/** Start of a rolling window ending now. */
export async function daysAgo(days: number): Promise<Date> {
  return new Date(Date.now() - days * 86_400_000);
}

/** Current instant, for server components that need one. */
export async function now(): Promise<Date> {
  return new Date();
}
