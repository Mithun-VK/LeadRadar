import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    // Node, not jsdom: everything under test in Phases 1-8 is server-side.
    // A jsdom environment is added alongside this one when component tests land.
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Integration tests need a real Postgres and Redis and are excluded from the
    // default run so `npm test` stays usable without Docker running.
    exclude: ['tests/integration/**', 'tests/e2e/**', 'node_modules/**'],
    globals: false,
    setupFiles: ['tests/setup.ts'],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/app/**'],
      thresholds: {
        // Raised as coverage grows; these are floors, not targets. The security
        // and scoring modules are held far higher by their own test files.
        lines: 60,
        functions: 60,
        branches: 70,
        statements: 60,
      },
    },
  },
});
