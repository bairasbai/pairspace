const fs = require('node:fs');
const path = require('node:path');
const { verify, environment } = require('../runner.cjs');
const clean = { sha: 'fixture', tree: 'tree', trackedHash: 'hash', dirty: false };
const step = (id, code = '') => ({ id, command: process.execPath, args: ['-e', code], cwd: '.', timeoutMs: 2000, required: true });
const directories = [];
async function run(options = {}) {
  const result = await verify({ root: process.cwd(), capture: () => clean, expectedIds: ['one'], makePlan: () => [step('one')], ...options });
  directories.push(result.directory); return result;
}
afterEach(() => directories.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));
test('failure then success remains nonzero, and each output reports exact exit status', async () => {
  const result = await run({ expectedIds: ['fail', 'pass'], makePlan: () => [step('fail', 'process.exit(3)'), step('pass')] });
  expect(result.exitCode).toBe(1); expect(result.report.status).toBe('FAIL');
  expect(result.report.steps.map(x => x.status)).toEqual(['FAIL', 'PASS']);
  expect(result.report.steps[0].exitCode).toBe(3);
});
test('full profile vs limited profile and optional unavailable step', async () => {
  const full = await run({ makePlan: () => [step('one'), { id: 'legacy', required: false, skip: 'NOT_RUN' }] });
  expect(full.report.acceptance).toBe(true); expect(full.exitCode).toBe(0);
  const limited = await run({ profile: 'runner' });
  expect(limited.report.status).toBe('PASS'); expect(limited.report.acceptance).toBe(false);
  expect(full.directory).not.toBe(limited.directory);
  expect(JSON.parse(fs.readFileSync(path.join(full.directory, 'report.json'))).status).toBe('PASS');
});
test('missing, invalid, skipped or absent required steps fail', async () => {
  for (const steps of [[], [{ id: 'invalid', required: true }], [{ ...step('invalid'), timeoutMs: 0 }],
    [{ id: 'skip', required: true, skip: 'missing' }], [{ id: 'optional', required: false, skip: 'not run' }],
    [{ ...step('missing'), command: '/nonexistent-pairspace-binary' }]]) {
    expect((await run({ makePlan: () => steps })).exitCode).toBe(1);
  }
});
test('dirty baseline or source change invalidates successful processes', async () => {
  expect((await run({ capture: () => ({ ...clean, dirty: true }) })).report.acceptance).toBe(false);
  let calls = 0;
  const result = await run({ capture: () => ({ ...clean, trackedHash: String(calls++) }) });
  expect(result.report.sourceValid).toBe(false); expect(result.exitCode).toBe(1);
});
test('interrupt preserves unfinished report and never runs later steps', async () => {
  const controller = new AbortController();
  const result = await run({ signal: controller.signal, makePlan: () => [step('one'), step('two')],
    onStep: () => controller.abort() });
  expect(result.report.steps[1].status).toBe('NOT_RUN'); expect(result.report.status).toBe('INTERRUPTED');
});
test('partial snapshots and unexpected exceptions never overwrite earlier reports or record errors/payloads', async () => {
  const result = await run({ capture: () => { throw new Error('secret-password'); } });
  expect(result.report.status).toBe('ERROR'); expect(JSON.stringify(result.report)).not.toContain('secret-password');
  let pending;
  const second = await run({ execute: async () => {
    // The run begins with an explicit RUNNING, acceptance=false report.
    const dirs = fs.readdirSync(require('node:os').tmpdir()).filter(name => name.startsWith('pairspace-verification-'));
    pending = dirs.some(name => {
      const file = path.join(require('node:os').tmpdir(), name, 'report.json');
      return fs.existsSync(file) && JSON.parse(fs.readFileSync(file)).status === 'RUNNING';
    });
    throw new Error('private-request');
  } });
  expect(pending).toBe(true); expect(second.report.acceptance).toBe(false);
  expect(JSON.parse(fs.readFileSync(path.join(result.directory, 'report.json'))).runId).toBe(result.report.runId);
});
test('cwd traversal rejected and credentials not inherited', async () => {
  expect((await run({ makePlan: () => [{ ...step('escape'), cwd: '../' }] })).exitCode).toBe(1);
  const env = environment('/tmp/isolated'); expect(env.HOME).toBe('/tmp/isolated');
  expect(env.PGHOST).toBeUndefined(); expect(env.NODE_OPTIONS).toBeUndefined(); expect(env.BETTER_AUTH_SECRET).toBeUndefined();
  const old = process.env.PATH; delete process.env.PATH;
  expect(environment('/tmp/x').PATH).toBe('/usr/bin:/bin'); process.env.PATH = old;
});

test('fixed required descriptor cannot be omitted, weakened, skipped or duplicated', async () => {
  for (const steps of [[{ ...step('one'), required: false }], [step('other')],
    [{ ...step('one'), skip: 'bypass' }], [step('one'), step('one')]]) {
    expect((await run({ makePlan: () => steps })).report.status).toBe('ERROR');
  }
});
test('fresh valid coverage required even with zero exit status', async () => {
  const failed = await run({ checkCoverage: () => ({ valid: false }) });
  expect(failed.report.steps[0].status).toBe('FAIL');
  expect((await run({ checkCoverage: () => ({ valid: true }) })).exitCode).toBe(0);
});
test('required command schema validation rejects missing binary, args and budget', async () => {
  for (const change of [{ command: '' }, { args: null }, { timeoutMs: NaN }, { timeoutMs: 0 }]) {
    const result = await run({ makePlan: () => [{ ...step('one'), ...change }] });
    expect(result.report.steps[0].status).toBe('ERROR');
  }
  expect((await run({ expectedIds: undefined, profile: 'invalid' })).exitCode).toBe(1);
});

test('two executed steps use private numeric raw artifacts and skipped step has none', async () => {
  const { createHash } = require('node:crypto');
  const result = await run({ expectedIds: ['../one', 'two'], makePlan: () => [
    step('../one', 'process.stdout.write("private-first");process.stderr.write("err")'),
    step('two', 'process.stdout.write("private-second")'),
    { id: 'optional', required: false, skip: 'NOT_RUN' },
  ] });
  expect(result.exitCode).toBe(0);
  const logs = path.join(result.directory, 'logs');
  expect(fs.statSync(logs).mode & 0o777).toBe(0o700);
  expect(fs.readdirSync(logs).sort()).toEqual(['0000-stderr.bin', '0000-stdout.bin', '0001-stderr.bin', '0001-stdout.bin']);
  for (const [index, value] of ['private-first', 'private-second'].entries()) {
    const info = result.report.steps[index].stdout;
    expect(info.artifact).toBe(`logs/000${index}-stdout.bin`);
    expect(fs.readFileSync(path.join(result.directory, info.artifact), 'utf8')).toBe(value);
    expect(info.sha256).toBe(createHash('sha256').update(value).digest('hex'));
    expect(fs.statSync(path.join(result.directory, info.artifact)).mode & 0o777).toBe(0o600);
  }
  expect(result.report.steps[2].childLogs).toBe('NO_PROCESS_EXECUTED');
  expect(JSON.stringify(result.report)).not.toMatch(/private-first|private-second/);
});
