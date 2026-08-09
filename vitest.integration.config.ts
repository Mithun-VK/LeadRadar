import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Integration config.
 *
 * Separate from the default config because these tests need a real PostgreSQL and
 * Redis. They run sequentially (`fileParallelism: false`) since they share database
 * state and parallel truncation would make failures non-deterministic.
 */
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    setupFiles: ['tests/setup.integration.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
