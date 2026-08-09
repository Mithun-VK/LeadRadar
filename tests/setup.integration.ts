/**
 * Integration setup.
 *
 * Points at the same local services docker compose provides. Mock mode stays on:
 * an integration test must never make a real provider call, because that would
 * spend money and make the suite depend on the network.
 */
import 'dotenv/config';

Object.assign(process.env, {
  NODE_ENV: 'test',
  MOCK_EXTERNAL_APIS: 'true',
  LOG_LEVEL: 'silent',
  DATABASE_URL:
    process.env.DATABASE_URL ??
    'postgresql://leadradar:leadradar@localhost:5433/leadradar?schema=public',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6380',
});

delete process.env.GOOGLE_MAPS_API_KEY;
delete process.env.GROQ_API_KEY;
delete process.env.FIRECRAWL_API_KEY;
