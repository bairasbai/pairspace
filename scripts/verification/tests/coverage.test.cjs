const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { coverageResult } = require('../coverage.cjs');
let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-coverage-')); fs.mkdirSync(path.join(root, 'runner-coverage')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const valid = () => Object.fromEntries(['statements', 'branches', 'functions', 'lines'].map(metric => [metric, { total: 10, covered: 9, pct: 90 }]));
const write = summary => fs.writeFileSync(path.join(root, 'runner-coverage/coverage-summary.json'), JSON.stringify(summary));
test('fresh nonzero denominators and every metric enforce >=90', () => {
  expect(coverageResult('other', root)).toBeNull();
  expect(coverageResult('runner-coverage', root).valid).toBe(false);
  write({ total: valid(), 'fixture.cjs': valid() });
  expect(coverageResult('runner-coverage', root)).toMatchObject({ valid: true, fileCount: 1 });
  for (const value of [{ total: 0, covered: 0, pct: 100 }, { total: 10, covered: 8, pct: 100 },
    { total: 10, covered: 9, pct: 80 }, { total: 10, covered: 11, pct: 100 }, { total: 10, covered: 9, pct: '90' },
    { total: '10', covered: 9, pct: 90 }, { total: 10, covered: '9', pct: 90 }, null]) {
    write({ total: { ...valid(), lines: value }, 'fixture.cjs': valid() }); expect(coverageResult('runner-coverage', root).valid).toBe(false);
  }
  write({ total: valid() }); expect(coverageResult('runner-coverage', root).valid).toBe(false);
  write({ 'fixture.cjs': valid() }); expect(coverageResult('runner-coverage', root).valid).toBe(false);
  write({}); expect(coverageResult('runner-coverage', root).valid).toBe(false);
  fs.writeFileSync(path.join(root, 'runner-coverage/coverage-summary.json'), 'bad-json');
  expect(coverageResult('runner-coverage', root).valid).toBe(false);
});
