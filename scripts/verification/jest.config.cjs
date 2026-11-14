module.exports = {
  rootDir: '../..',
  testEnvironment: 'node',
  transform: {},
  testMatch: ['<rootDir>/scripts/verification/tests/*.test.cjs'],
  collectCoverageFrom: ['scripts/verification/{process,stream-capture,source,profile,runner,cli,coverage}.cjs'],
  coverageThreshold: { global: { statements: 90, branches: 90, functions: 90, lines: 90 } },
  coverageReporters: ['text', 'json-summary'],
};
