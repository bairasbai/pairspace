import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDeadline } from './async-bounds.mjs';

export const journalDirectory = () => mkdtemp(path.join(tmpdir(), 'synthetic-chat-journal-'));
export async function journalChild(f, directory) {
  const child = fork(fileURLToPath(new URL('./journal-process-child.mjs', import.meta.url)), [], { execArgv: ['--experimental-transform-types'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let serial = 0, exited = false, diagnostics = '';
  const awaiting = new Map(), events = new Map();
  child.stderr.on('data', chunk => { if (diagnostics.length < 4000) diagnostics += String(chunk); });
  child.on('message', message => {
    if (message.event === 'barrier') { const event = events.get(message.name); if (event) event.resolve(); else events.set(message.name, { arrived: true }); return; }
    const pending = awaiting.get(message.id); if (!pending) return; awaiting.delete(message.id);
    if (message.ok) pending.resolve(message.value); else pending.reject(Error(message.error));
  });
  const exit = new Promise(resolve => child.once('exit', (code, signal) => {
    exited = true; for (const pending of awaiting.values()) pending.reject(Error('journal child exited')); awaiting.clear(); resolve({ code, signal });
  }));
  const send = message => {
    const task = new Promise((resolve, reject) => { const id = ++serial; awaiting.set(id, { resolve, reject }); child.send({ ...message, id }); });
    task.catch(() => {}); const bounded = withDeadline(task, 12000, 'journal process command'); bounded.catch(() => {}); return bounded;
  };
  const handle = { send,
    barrier(name) {
      if (events.get(name)?.arrived) return Promise.resolve();
      return withDeadline(new Promise(resolve => events.set(name, { resolve })), 5000, `journal barrier ${name}`);
    },
    async kill() { if (!exited) child.kill('SIGKILL'); const result = await withDeadline(exit, 5000, 'journal child exit'); assert.equal(result.signal, 'SIGKILL'); },
    diagnostics: () => diagnostics,
  };
  try { await send({ op: 'init', baseURL: f.baseURL, directory }); return handle; }
  catch (error) {
    // Boot failures may exit naturally before cleanup. Preserve that cause/stderr;
    // successful harness handles retain the strict SIGKILL assertion above.
    if (!exited) child.kill('SIGKILL');
    const result = await withDeadline(exit, 5000, 'journal failed boot cleanup');
    throw new Error(`journal child init failed (exit ${result.code}, signal ${result.signal}): ${diagnostics}`, { cause: error });
  }
}
export async function assertCiphertext(directory, texts) {
  const vault = JSON.parse(await readFile(path.join(directory, 'synthetic-vault.json'), 'utf8'));
  assert.deepEqual(Object.keys(vault).sort(), ['installationId', 'secret']);
  assert.equal(Buffer.from(vault.secret, 'base64').length, 32, 'synthetic vault stores only AES key material and installation identity');
  for (const name of await readdir(directory)) {
    if (!name.startsWith('journal.sqlite')) continue;
    const data = await readFile(path.join(directory, name));
    for (const text of texts) assert.equal(data.includes(Buffer.from(text)), false, `no plaintext in ${name}`);
  }
}
