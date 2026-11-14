import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { client } from './composed-fixture.mjs';
import { password } from './profile-fixture.mjs';
import { linuxJournalPlatform } from './journal-linux-platform.mjs';
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && context.parentURL && /\/(apps\/mobile|packages\/domain)\//.test(context.parentURL)) {
    const candidate = new URL(`${specifier}.ts`, context.parentURL);
    if (existsSync(candidate)) return next(candidate.href, context);
  }
  return next(specifier, context);
} });
const { createSessionController } = await import('../../../../apps/mobile/src/auth/controller.ts');
const { createJournal } = await import('../../../../apps/mobile/src/chat/journal/engine.ts');
hooks.deregister();
let controller, platform, engine, lastToken, contextGateCount = 0;
const requests = [], barriers = new Map(), armed = new Set();
const snapshot = () => ({ view: controller?.getSnapshot(), journal: controller?.journal?.getSnapshot(), requests, crypto: platform?.stats() });
async function stopAt(name) {
  if (!armed.delete(name)) return;
  await new Promise(resolve => { barriers.set(name, resolve); process.send({ event: 'barrier', name }); });
}
async function init({ baseURL, directory }) {
  platform = await linuxJournalPlatform(directory);
  engine = createJournal({ store: platform.store, keys: platform.keyProvider, cipher: platform.cipher, randomId: randomUUID });
  const port = { ...engine,
    async bindVerifiedScope(scope) { const result = await engine.bindVerifiedScope(scope); if (result.ok) lastToken = result.value; return result; },
    async prepareSend(...args) { const result = await engine.prepareSend(...args); if (result.ok) await stopAt('prepared'); return result; },
    async settlePending(...args) { await stopAt('before-settle'); return engine.settlePending(...args); },
  };
  const connection = client(baseURL);
  const sessionClient = {
    async signIn(email, secret) {
      const result = await connection.auth.signIn.email({ email, password: secret });
      if (result.error) return null;
      const verified = await connection.auth.getSession({ query: { disableCookieCache: true } });
      return { userId: verified.data.user.id, sessionId: verified.data.session.id };
    },
    async signOut() { return !(await connection.auth.signOut()).error; }, getCookie: connection.getCookie,
  };
  controller = createSessionController({ mode: 'synthetic-loopback', baseURL }, sessionClient, async request => {
    if (new URL(request.url).origin !== baseURL) throw Error('non-loopback request');
    const body = request.method === 'GET' ? undefined : await request.clone().json();
    const response = await fetch(request);
    if (new URL(request.url).pathname === '/v1/session/context' && armed.has('second-context')
      && ++contextGateCount === 2) await stopAt('second-context');
    requests.push({ method: request.method, path: new URL(request.url).pathname,
      clientId: body?.client_message_id, replyToId: body?.reply_to_id, status: response.status });
    if (request.method === 'POST' && /\/chat\/(messages|replies)$/.test(new URL(request.url).pathname)) await stopAt('server-committed');
    return response;
  }, randomUUID, undefined, port);
  return snapshot();
}
async function command(message) {
  if (message.op === 'init') return init(message);
  if (message.op === 'arm') { armed.add(message.name); if (message.name === 'second-context') contextGateCount = 0; return true; }
  if (message.op === 'release') { barriers.get(message.name)?.(); barriers.delete(message.name); return true; }
  if (message.op === 'snapshot') return snapshot();
  if (message.op === 'fail-next-commit') { platform.failNextCommit(); return true; }
  if (message.op === 'signIn') { await controller.signIn(message.email ?? 'reply-0@example.test', password); return snapshot(); }
  if (message.op === 'call') {
    const target = message.journal ? controller.journal : controller;
    if (typeof target?.[message.method] !== 'function') throw Error('unsupported harness action');
    const result = await target[message.method](...(message.args ?? []));
    return { ...snapshot(), result };
  }
  if (message.op === 'delayed-engine-draft') {
    const token = lastToken; await stopAt('old-writer');
    return engine.saveDraft(token, message.draft);
  }
  throw Error('unknown harness operation');
}
process.on('message', message => {
  void command(message).then(value => process.send?.({ id: message.id, ok: true, value }),
    error => process.send?.({ id: message.id, ok: false, error: error instanceof Error ? error.message : 'harness_error' }));
});
