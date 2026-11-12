const path = require('node:path');
const { plan } = require('../profile.cjs');
const root = path.resolve(__dirname, '../../..');
test('full fixed manifest contains required gates, native claims excluded, legacy explicitly not run', () => {
  const full = plan(root, '/tmp/fixture');
  expect(full.filter(step => step.required)).toHaveLength(11);
  expect(full.map(step => step.id)).toEqual(['runner-coverage', 'api-typecheck', 'api-lint', 'api-domain-coverage',
    'mobile-typecheck', 'mobile-lint', 'mobile-domain-coverage', 'postgres-safety', 'real-postgres', 'root-domain',
    'mobile-js-export', 'legacy-next-typecheck-build']);
  expect(full.find(step => step.id === 'real-postgres').timeoutMs).toBe(390000);
  expect(full.find(step => step.id === 'api-domain-coverage').timeoutMs).toBe(240000);
  expect(full.at(-1).skip).toMatch(/NOT_RUN/);
  expect(plan(root, '/tmp/x', 'runner')).toHaveLength(1);
  expect(() => plan(root, '/tmp/x', 'custom')).toThrow('UNKNOWN_PROFILE');
});
