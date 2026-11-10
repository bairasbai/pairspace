module.exports = {
  rootDir: '../..',
  preset: require.resolve('jest-expo/jest-preset.js'),
  collectCoverageFrom: ['apps/mobile/index.ts', 'apps/mobile/App.tsx', 'apps/mobile/src/**/*.{ts,tsx}', 'packages/domain/**/*.ts'],
  coverageDirectory: 'apps/mobile/coverage',
  coverageThreshold: { global: { statements: 90, branches: 90, functions: 90, lines: 90 } },
  testMatch: ['<rootDir>/apps/mobile/__tests__/**/*.test.{ts,tsx}'],
};
