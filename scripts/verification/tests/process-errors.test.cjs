const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
async function fixture({ platform = 'linux', failure, killFailure, pid = 999, aborted = false } = {}) {
  jest.resetModules();
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.pid = pid; child.kill = jest.fn();
  const platformProperty = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform });
  const kill = jest.spyOn(process, 'kill').mockImplementation(() => { throw killFailure || Object.assign(new Error(), { code: 'ESRCH' }); });
  jest.doMock('node:child_process', () => ({ spawn: () => child }));
  const { runProcess } = require('../process.cjs');
  const controller = new AbortController(); if (aborted) controller.abort();
  const logsDirectory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'capture-error-'));
  const promise = runProcess({ command: 'fixture', args: [], timeoutMs: 1 }, { cwd: '.', env: {}, signal: controller.signal, logsDirectory, stepIndex: 0 });
  await new Promise(resolve => setTimeout(resolve, 10));
  if (failure) child.emit('error', failure);
  child.emit('close', null, 'SIGTERM');
  const result = await promise;
  kill.mockRestore(); Object.defineProperty(process, 'platform', platformProperty);
  jest.dontMock('node:child_process'); jest.resetModules();
  fs.rmSync(logsDirectory, { recursive: true, force: true });
  return result;
}
test('termination errors and missing pid are explicit without raw messages', async () => {
  expect((await fixture({ killFailure: new Error('secret') })).error).toBe('KILL_ERROR');
  expect((await fixture({ killFailure: Object.assign(new Error(), { code: 'EPERM' }) })).error).toBe('EPERM');
  expect((await fixture({ pid: undefined, failure: new Error('private') })).error).toBe('SPAWN_ERROR');
  expect((await fixture({ pid: null, aborted: true })).status).toBe('INTERRUPTED');
});
test('Windows uses child termination instead of POSIX groups', async () => {
  expect((await fixture({ platform: 'win32' })).status).toBe('TIMEOUT');
});
