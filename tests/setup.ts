/**
 * Vitest setup.
 *
 * Establishes a valid, credential-free environment so importing any module that
 * touches `env()` works in a unit test. Mock mode is on: no test may make a
 * network call to a provider, and if one tries, the absence of credentials makes
 * it fail loudly rather than silently billing a real account.
 */
// Assigned via Object.assign because @types/node declares NODE_ENV read-only.
Object.assign(process.env, {
  NODE_ENV: 'test',
  MOCK_EXTERNAL_APIS: 'true',
  LOG_LEVEL: 'silent',
  DATABASE_URL:
    process.env.DATABASE_URL ??
    'postgresql://leadradar:leadradar@localhost:5432/leadradar_test?schema=public',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379/1',
  GROQ_MODEL: process.env.GROQ_MODEL ?? 'openai/gpt-oss-20b',
});

// Deliberately absent: GOOGLE_MAPS_API_KEY, GROQ_API_KEY, FIRECRAWL_API_KEY.
delete process.env.GOOGLE_MAPS_API_KEY;
delete process.env.GROQ_API_KEY;
delete process.env.FIRECRAWL_API_KEY;
