const fs = require('node:fs');
const path = require('node:path');
const directories = [];
afterEach(() => directories.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));
const { runProcess } = require('../process.cjs');
const step = (code, more = {}) => ({ command: process.execPath, args: ['-e', code], timeoutMs: 3000, graceMs: 30, ...more });
const options = () => {
  const logsDirectory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'capture-test-'));
  directories.push(logsDirectory);
  return { cwd: process.cwd(), env: { PATH: process.env.PATH }, logsDirectory, stepIndex: 0 };
};
test('exit codes, signals and printed PASS cannot conceal failures', async () => {
  expect((await runProcess(step('console.log("PASS"); process.exit(7)'), options())).exitCode).toBe(7);
  expect((await runProcess(step(''), options())).status).toBe('PASS');
  const signal = await runProcess(step('process.kill(process.pid,"SIGTERM")'), options());
  expect(signal.status).toBe('FAIL'); expect(signal.signal).toBe('SIGTERM');
});
test('missing executable and bad cwd fail closed', async () => {
  expect((await runProcess({ ...step(''), command: '/nonexistent-pairspace-binary' }, options())).error).toBe('ENOENT');
  expect((await runProcess(step(''), { ...options(), cwd: '/nonexistent-pairspace-dir' })).status).toBe('ERROR');
});
test('timeout kills TERM-ignoring children and bounds output memory', async () => {
  const result = await runProcess(step('process.on("SIGTERM",()=>{});setInterval(()=>process.stdout.write("x".repeat(65536)),1)', { timeoutMs: 200 }), options());
  expect(result.status).toBe('TIMEOUT'); expect(result.timedOut).toBe(true);
  expect(result.durationMs).toBeLessThan(3000); expect(result.stdout.bytes).toBeGreaterThan(65536);
  expect(result.stdout.artifact).toBe('logs/0000-stdout.bin'); expect(JSON.stringify(result).length).toBeLessThan(2000);
});
test('both streams retained privately without embedding secret or request text', async () => {
  const result = await runProcess(step('process.stdout.write("private-token");process.stderr.write("private-payload")'), options());
  expect(result.stdout.bytes).toBe(13); expect(result.stderr.bytes).toBe(15);
  expect(JSON.stringify(result)).not.toMatch(/private-token|private-payload/);
});
test('abort before and during execution yields interrupted, never PASS', async () => {
  const first = new AbortController(); first.abort();
  expect((await runProcess(step('setInterval(()=>{},100)'), { ...options(), signal: first.signal })).status).toBe('INTERRUPTED');
  const second = new AbortController();
  const result = runProcess(step('setInterval(()=>{},100)'), { ...options(), signal: second.signal });
  setTimeout(() => second.abort(), 40);
  expect((await result).interrupted).toBe(true);
});
test('leader success cannot leave a closed-stdio TERM-ignoring descendant', async () => {
  const code = `const {spawn}=require('node:child_process');
    const c=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},100)'],{stdio:'ignore'});
    c.unref();setTimeout(()=>process.exit(0),100);`;
  const result = await runProcess(step(code), options());
  expect(result.cleanupRequired).toBe(true); expect(result.status).toBe('FAIL');
  expect(result.durationMs).toBeLessThan(3000);
});
test('default cleanup grace and timeout values are supported', async () => {
  expect((await runProcess({ command: process.execPath, args: ['-e', ''], timeoutMs: 2000 }, options())).status).toBe('PASS');
});

test('binary streams are exact and log IO failure or overflow cannot turn exit zero into PASS', async () => {
  const { captureStream } = require('../stream-capture.cjs');
  const { createHash } = require('node:crypto');
  const bytes = Buffer.from([0, 255, 13, 10, 128]);
  const code = 'process.stdout.write(Buffer.from([0,255,13,10,128]));process.stderr.write(Buffer.from([255,0]))';
  const opts = options();
  const good = await runProcess(step(code), opts);
  expect(good).toMatchObject({ status: 'PASS', processStatus: 'PASS', exitCode: 0, evidenceComplete: true });
  expect(fs.readFileSync(path.join(opts.logsDirectory, '0000-stdout.bin'))).toEqual(bytes);
  expect(fs.readFileSync(path.join(opts.logsDirectory, '0000-stderr.bin'))).toEqual(Buffer.from([255, 0]));
  expect(good.stdout.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  for (const config of [{ limit: 2 }, { io: { ...fs, writeSync() { throw Error('private-disk-detail'); } } }]) {
    const result = await runProcess(step(code), { ...options(), capture: (stream, settings) => captureStream(stream, { ...settings, ...config }) });
    expect(result).toMatchObject({ status: 'FAIL', processStatus: 'PASS', exitCode: 0, evidenceComplete: false });
    expect(result.stdout.bytes).toBe(5);
    expect(result.stdout.sha256).toBe(good.stdout.sha256);
    expect(JSON.stringify(result)).not.toContain('private-disk-detail');
  }
});
test('default exact 16MiB boundary is complete and one extra byte fails evidence while draining', async () => {
  const { STREAM_LIMIT } = require('../stream-capture.cjs');
  for (const extra of [0, 1]) {
    const opts = options();
    const result = await runProcess(step(`process.stdout.write(Buffer.alloc(${STREAM_LIMIT + extra},97))`), opts);
    expect(result.processStatus).toBe('PASS');
    expect(result.status).toBe(extra ? 'FAIL' : 'PASS');
    expect(result.stdout).toMatchObject({ bytes: STREAM_LIMIT + extra, retainedBytes: STREAM_LIMIT, limitReached: !!extra, complete: !extra });
    expect(fs.statSync(path.join(opts.logsDirectory, '0000-stdout.bin')).size).toBe(STREAM_LIMIT);
  }
});
