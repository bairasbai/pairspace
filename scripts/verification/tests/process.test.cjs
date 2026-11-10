const { runProcess } = require('../process.cjs');
const step = (code, more = {}) => ({ command: process.execPath, args: ['-e', code], timeoutMs: 3000, graceMs: 30, ...more });
const options = () => ({ cwd: process.cwd(), env: { PATH: process.env.PATH } });
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
  expect(result.stdout.content).toBe('NOT_RETAINED'); expect(JSON.stringify(result).length).toBeLessThan(1000);
});
test('both streams drained without retaining secret or request text', async () => {
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
