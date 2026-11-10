'use strict';
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');

// Discard content, continuously drain both pipes. Reports never contain test payloads,
// inherited environment, credential values, or unbounded child output.
function streamDigest(stream) {
  const hash = createHash('sha256');
  let bytes = 0;
  stream.on('data', chunk => { bytes += chunk.length; hash.update(chunk); });
  return () => ({ bytes, sha256: hash.digest('hex'), content: 'NOT_RETAINED' });
}

function runProcess(step, { cwd, env, signal }) {
  return new Promise(resolve => {
    const started = Date.now();
    let timedOut = false;
    let interrupted = false;
    let error = null;
    let timer;
    let cleanupRequired = false;
    let forceTimer;
    const child = spawn(step.command, step.args, {
      cwd, env, shell: false, detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = streamDigest(child.stdout);
    const stderr = streamDigest(child.stderr);
    function kill(kind) {
      try {
        if (process.platform === 'win32') child.kill(kind);
        else if (child.pid) process.kill(-child.pid, kind);
      } catch (failure) {
        if (failure.code !== 'ESRCH') error = failure.code || 'KILL_ERROR';
      }
    }
    function stop() {
      kill('SIGTERM');
      // Keep this timer alive even if the group leader exits: descendants may hold
      // pipes or ignore TERM. PG's existing EXIT cleanup gets a generous grace.
      if (!forceTimer) forceTimer = setTimeout(() => kill('SIGKILL'), step.graceMs ?? 15000);
    }
    function abort() { interrupted = true; stop(); }
    child.once('error', failure => { error = failure.code || 'SPAWN_ERROR'; });
    child.once('close', async (exitCode, exitSignal) => {
      clearTimeout(timer);
      // A group leader can close while detached descendants have closed stdio.
      // Do not interpret that as cleanup completion or a successful check.
      if (child.pid && process.platform !== 'win32') {
        try { process.kill(-child.pid, 0); cleanupRequired = true; } catch {}
        if (cleanupRequired) {
          kill('SIGTERM');
          await new Promise(done => setTimeout(done, step.graceMs ?? 15000));
          kill('SIGKILL');
        }
      }
      clearTimeout(forceTimer);
      signal?.removeEventListener('abort', abort);
      const status = interrupted ? 'INTERRUPTED' : timedOut ? 'TIMEOUT'
        : error ? 'ERROR' : cleanupRequired ? 'FAIL' : exitCode === 0 && exitSignal === null ? 'PASS' : 'FAIL';
      resolve({ status, exitCode, signal: exitSignal, error, timedOut, interrupted,
        cleanupRequired, durationMs: Date.now() - started, stdout: stdout(), stderr: stderr() });
    });
    timer = setTimeout(() => { timedOut = true; stop(); }, step.timeoutMs);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}
module.exports = { runProcess };
