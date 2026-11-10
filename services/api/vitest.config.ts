import { defineConfig } from 'vitest/config';
export default defineConfig({
  root: '../..',
  test: {
    include: ['services/api/tests/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    maxWorkers: 1,
    coverage: {
      provider: 'v8',
      reportsDirectory: 'services/api/coverage',
      include: ['services/api/src/**/*.ts', 'packages/domain/**/*.ts'],
      thresholds: { statements: 90, branches: 90, functions: 90, lines: 90 },
    },
  },
});
