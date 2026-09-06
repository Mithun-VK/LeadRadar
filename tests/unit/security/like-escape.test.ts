import { describe, expect, it } from 'vitest';

import { escapeLike } from '@/modules/database/repositories';

/**
 * These pin down a bug that was live in the lead search.
 *
 * Prisma's `contains` reads like a literal substring operator. It is not — it
 * compiles to SQL `LIKE`, and the user's term is placed inside the pattern. The
 * value is parameterised, so nothing here is an injection; but `%` and `_` are
 * still interpreted by `LIKE` after parameterisation, and that was enough.
 *
 * Measured against the seeded database before the fix: a search for `_` returned
 * all 27 leads, because `LIKE '%_%'` matches any name with at least one
 * character. A search for `%` did the same. Both now return only genuine
 * literal matches.
 *
 * The same trap bit a filter written as `slug: { startsWith: '__loadtest__' }`,
 * which reads as a namespace check and in SQL means "any two characters, then
 * `loadtest`, then any two characters" — a scoping clause that had quietly
 * stopped scoping.
 */
describe('escapeLike', () => {
  it('escapes the single-character wildcard', () => {
    expect(escapeLike('_')).toBe('\\_');
  });

  it('escapes the any-sequence wildcard', () => {
    expect(escapeLike('%')).toBe('\\%');
  });

  it('escapes the escape character itself, and does so first', () => {
    // If `\` were escaped after `_`, the backslash added for `_` would itself be
    // escaped, producing `\\_` — a literal backslash followed by a live
    // wildcard. A single pass over the character class avoids that ordering bug.
    expect(escapeLike('\\')).toBe('\\\\');
    expect(escapeLike('\\_')).toBe('\\\\\\_');
  });

  it('escapes every occurrence, not just the first', () => {
    expect(escapeLike('%_%')).toBe('\\%\\_\\%');
  });

  it('leaves ordinary search terms untouched', () => {
    for (const term of ['Clinic', 'Dr. Rao & Sons', "O'Brien", 'café', '中文', 'a-b_']) {
      const escaped = escapeLike(term);
      // The only characters that may change are the three metacharacters.
      expect(escaped.replace(/\\([\\%_])/g, '$1')).toBe(term);
    }
  });

  it('is idempotent under unescaping, so no term is corrupted', () => {
    const terms = ['50% off', 'snake_case', 'back\\slash', '%_\\', ''];
    for (const term of terms) {
      expect(escapeLike(term).replace(/\\([\\%_])/g, '$1')).toBe(term);
    }
  });

  it('never leaves an unescaped wildcard behind', () => {
    const term = 'a%b_c\\d%%__';
    const escaped = escapeLike(term);
    // Strip escaped pairs; whatever remains must contain no metacharacter.
    expect(escaped.replace(/\\[\\%_]/g, '')).not.toMatch(/[\\%_]/);
  });
});
