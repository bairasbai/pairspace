import { defineConfig } from 'vitest/config';
export default defineConfig({
  root: '../..',
  test: {
    include: ['services/api/tests/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    maxWorkers: 1,
    // Execute real Expo plugin logic while mocking only native I/O in contract tests.
    server: { deps: { inline: ['@better-auth/expo'] } },
    coverage: {
      provider: 'v8',
      reportsDirectory: 'services/api/coverage',
      include: ['services/api/src/**/*.ts', 'packages/domain/**/*.ts'],
      thresholds: { statements: 90, branches: 90, functions: 90, lines: 90 },
    },
  },
});
