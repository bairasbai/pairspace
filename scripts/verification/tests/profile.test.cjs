const path = require('node:path');
const { plan } = require('../profile.cjs');
const root = path.resolve(__dirname, '../../..');
test('full fixed manifest contains required gates, native claims excluded, legacy explicitly not run', () => {
  const full = plan(root, '/tmp/fixture');
  expect(full.filter(step => step.required)).toHaveLength(11);
  expect(full.map(step => step.id)).toEqual(['runner-coverage', 'api-typecheck', 'api-lint', 'api-domain-coverage',
    'mobile-typecheck', 'mobile-lint', 'mobile-domain-coverage', 'postgres-safety', 'real-postgres', 'root-domain',
    'mobile-js-export', 'legacy-next-typecheck-build']);
  expect(full.find(step => step.id === 'real-postgres').timeoutMs).toBe(1140000);
  expect(full.find(step => step.id === 'real-postgres').graceMs).toBe(15000);
  expect(full.find(step => step.id === 'api-domain-coverage').timeoutMs).toBe(450000);
  expect(full.at(-1).skip).toMatch(/NOT_RUN/);
  expect(plan(root, '/tmp/x', 'runner')).toHaveLength(1);
  expect(() => plan(root, '/tmp/x', 'custom')).toThrow('UNKNOWN_PROFILE');
});

test('API coverage reserve changes only outer deadline, not complete coverage or other gates', () => {
  const full = plan(root, '/tmp/fixture');
  const api = full.find(step => step.id === 'api-domain-coverage');
  expect(api.required).toBe(true);
  expect(api.cwd).toBe('services/api');
  expect(api.args).toEqual([
    'node_modules/vitest/vitest.mjs', 'run', '--coverage',
    '--coverage.thresholds.statements=90', '--coverage.thresholds.branches=90',
    '--coverage.thresholds.functions=90', '--coverage.thresholds.lines=90',
    '--coverage.reporter=json-summary', '--coverage.include=services/api/src/**/*.ts',
    '--coverage.include=packages/domain/**/*.ts',
    '--coverage.reportsDirectory=' + path.join('/tmp/fixture', 'api-coverage'),
    '--fsModuleCachePath=' + path.join('/tmp/fixture', 'vitest-fs-cache'), '--no-cache',
  ]);
  expect(full.filter(step => step.required).map(step => [step.id,step.timeoutMs])).toEqual([
    ['runner-coverage',180000],['api-typecheck',180000],['api-lint',180000],
    ['api-domain-coverage',450000],['mobile-typecheck',180000],['mobile-lint',180000],
    ['mobile-domain-coverage',300000],['postgres-safety',180000],['real-postgres',1140000],
    ['root-domain',180000],['mobile-js-export',300000],
  ]);
});

// Only the aggregate PostgreSQL deadline changes; the exact entrypoint and cleanup
// margin remain fixed. Inner test/SQL guard regression lives in postgres/bounds.
test('measured PostgreSQL outer reserve preserves entrypoint and grace', () => {
  const pg = plan(root, '/tmp/fixture').find(step => step.id === 'real-postgres');
  expect(pg).toMatchObject({cwd:'services/api',command:'bash',args:['scripts/run-postgres.sh'],
    timeoutMs:1140000,graceMs:15000,required:true});
  expect(pg.timeoutMs - 1110000).toBe(30000);
});
