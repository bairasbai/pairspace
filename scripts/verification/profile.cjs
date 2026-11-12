'use strict';
const path = require('node:path');
const { readdirSync } = require('node:fs');
function plan(root, runtime, profile = 'full') {
  if (!['full', 'runner'].includes(profile)) throw new Error('UNKNOWN_PROFILE');
  const node = (id, cwd, args, timeoutMs = 180000) =>
    ({ id, cwd, command: process.execPath, args, timeoutMs, required: true });
  const steps = [node('runner-coverage', '.', [
    'apps/mobile/node_modules/jest/bin/jest.js', '--config', 'scripts/verification/jest.config.cjs',
    '--runInBand', '--coverage', '--no-cache', '--cacheDirectory', path.join(runtime, 'runner-cache'),
    '--coverageDirectory', path.join(runtime, 'runner-coverage'),
  ])];
  if (profile === 'runner') return steps;
  steps.push(
    node('api-typecheck', 'services/api', ['node_modules/typescript/bin/tsc', '--noEmit']),
    node('api-lint', '.', ['services/api/node_modules/eslint/bin/eslint.js', '--config',
      'services/api/eslint.config.js', 'services/api', 'packages/domain']),
    node('api-domain-coverage', 'services/api', ['node_modules/vitest/vitest.mjs', 'run', '--coverage',
      '--coverage.thresholds.statements=90', '--coverage.thresholds.branches=90',
      '--coverage.thresholds.functions=90', '--coverage.thresholds.lines=90',
      '--coverage.reporter=json-summary', '--coverage.include=services/api/src/**/*.ts',
      '--coverage.include=packages/domain/**/*.ts', '--coverage.reportsDirectory=' + path.join(runtime, 'api-coverage'),
      '--fsModuleCachePath=' + path.join(runtime, 'vitest-fs-cache'), '--no-cache'], 240000),
    node('mobile-typecheck', 'apps/mobile', ['node_modules/typescript/bin/tsc', '--noEmit']),
    node('mobile-lint', 'apps/mobile', ['node_modules/eslint/bin/eslint.js', '.']),
    node('mobile-domain-coverage', '.', ['apps/mobile/node_modules/jest/bin/jest.js',
      '--config', 'apps/mobile/jest.config.cjs', '--runInBand', '--coverage', '--no-cache',
      '--cacheDirectory', path.join(runtime, 'mobile-cache'),
      '--coverageDirectory', path.join(runtime, 'mobile-coverage'),
      '--coverageReporters=json-summary', '--collectCoverageFrom=apps/mobile/index.ts',
      '--collectCoverageFrom=apps/mobile/App.tsx', '--collectCoverageFrom=apps/mobile/src/**/*.{ts,tsx}',
      '--collectCoverageFrom=packages/domain/**/*.ts', '--coverageThreshold', JSON.stringify({ global: { statements: 90, branches: 90, functions: 90, lines: 90 } })], 300000),
    node('postgres-safety', 'services/api', ['--test', ...readdirSync(path.join(root, 'services/api/tests/postgres'))
      .filter(name => name.endsWith('.test.mjs')).sort().map(name => 'tests/postgres/' + name)]),
    { id: 'real-postgres', cwd: 'services/api', command: 'bash', args: ['scripts/run-postgres.sh'],
      timeoutMs: 330000, graceMs: 15000, required: true },
    node('root-domain', '.', ['--test', ...readdirSync(path.join(root, 'tests'))
      .filter(name => name.endsWith('.test.ts')).sort().map(name => 'tests/' + name)]),
    node('mobile-js-export', 'apps/mobile', ['node_modules/expo/bin/cli', 'export', '--platform', 'ios',
      '--platform', 'android', '--max-workers', '2', '--output-dir', path.join(runtime, 'js-export')], 300000),
    { id: 'legacy-next-typecheck-build', required: false, skip: 'NOT_RUN: legacy Next dependencies not provisioned; not a mobile/product readiness gate' },
  );
  return steps;
}
const requiredIds = { runner: ['runner-coverage'], full: ['runner-coverage', 'api-typecheck', 'api-lint',
  'api-domain-coverage', 'mobile-typecheck', 'mobile-lint', 'mobile-domain-coverage',
  'postgres-safety', 'real-postgres', 'root-domain', 'mobile-js-export'] };
module.exports = { plan, requiredIds };
