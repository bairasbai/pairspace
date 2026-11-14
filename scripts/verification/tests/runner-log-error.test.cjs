const fs = require('node:fs');
const path = require('node:path');

test('new log-directory failure retains sanitized durable ERROR report', async () => {
  jest.resetModules();
  const actual = jest.requireActual('node:fs');
  jest.doMock('node:fs', () => ({ ...actual, mkdirSync(directory, options) {
    if (path.basename(directory) === 'logs') throw Error('private-filesystem-detail');
    return actual.mkdirSync(directory, options);
  } }));
  let result;
  try {
    const { verify } = require('../runner.cjs');
    result = await verify({ root: process.cwd() });
    expect(result.report.status).toBe('ERROR');
    expect(result.exitCode).toBe(1);
    expect(result.report.acceptance).toBe(false);
    const saved = fs.readFileSync(path.join(result.directory, 'report.json'), 'utf8');
    expect(JSON.parse(saved).status).toBe('ERROR');
    expect(saved).not.toContain('private-filesystem-detail');
    expect(fs.existsSync(path.join(result.directory, 'runtime'))).toBe(true);
  } finally {
    jest.dontMock('node:fs');
    jest.resetModules();
    if (result) fs.rmSync(result.directory, { recursive: true, force: true });
  }
});
