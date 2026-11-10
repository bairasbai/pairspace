import { afterEach, beforeEach, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createChatTransport } from '../../../apps/mobile/src/chat/transport';
import { createQueue, enqueue, login, pause, resume } from '../../../apps/mobile/src/chat/queue';
import { closeCouple, sendMessage } from '../src/chat.ts';
import { createSyntheticChatHandler as createChatHandler } from './fixtures.ts';
import { adapter, identityPrincipal, c1, c2, command, createFixture, id, principal, u2, u3, u4 } from './fixtures.ts';
let pg: PGlite;
beforeEach(async () => { pg = await createFixture(); });
afterEach(async () => { await pg.close(); });
it('queue → HTTP → SQL: lost ACK retries same ID, history isolates four accounts', async () => {
  const tokens = new Map([['one', principal.userId], ['two', u2], ['three', u3], ['four', u4]]);
  const handler = createChatHandler(adapter(pg), async token => {
    const userId = tokens.get(token); return userId ? identityPrincipal(userId) : null;
  });
  for (const [token, userId] of tokens) {
    const scope = { userId, coupleId: token === 'one' || token === 'two' ? c1 : c2, membershipEpoch: 1, sessionId: token };
    let state = enqueue(createQueue(scope), scope, command.clientId, 'Hello').state;
    let loseOnce = true;
    const transport = createChatTransport({ baseUrl: 'https://test.invalid', getCredentialGeneration: () => 1, store: { get: () => state, set: next => { state = next; } },
      request: async request => { const result = await handler(request); if (loseOnce) { loseOnce = false; throw new Error('lost ACK'); } return result; } });
    expect(await transport.send(command.clientId, { scope, token, credentialGeneration: 1 })).toEqual({ ok: false, error: 'transport_error' });
    expect(state.messages[0].status).toBe('queued');
    expect(await transport.send(command.clientId, { scope, token, credentialGeneration: 1 })).toEqual({ ok: true, value: { replay: true } });
    expect(state.messages[0].status).toBe('accepted');
    const page = await transport.history({ scope, token, credentialGeneration: 1 }, { limit: 100 });
    expect(page.ok).toBe(true);
    if (page.ok) expect(page.value.messages.every(message => message.coupleId === scope.coupleId)).toBe(true);
  }
  expect((await pg.query('SELECT * FROM chat_messages')).rows).toHaveLength(4);
  expect((await pg.query('SELECT * FROM outbox_events')).rows).toHaveLength(4);
});
it('late real SQL ACK cannot populate another login; expired test session pauses without losing text', async () => {
  const scope = { userId: principal.userId, coupleId: c1, membershipEpoch: 1, sessionId: 'first' };
  let state = enqueue(createQueue(scope), scope, command.clientId, 'Hello').state;
  let valid = true;
  const handler = createChatHandler(adapter(pg), async () => valid ? principal : null);
  const transport = createChatTransport({ baseUrl: 'https://test.invalid', getCredentialGeneration: () => 1, store: { get: () => state, set: next => { state = next; } },
    request: async request => { const result = await handler(request); state = login(state, { ...scope, userId: u3, coupleId: c2, sessionId: 'second' }).state; return result; } });
  expect(await transport.send(command.clientId, { scope, token: 'one', credentialGeneration: 1 })).toEqual({ ok: false, error: 'stale_session' });
  expect(state.scope.userId).toBe(u3);
  expect(state.messages).toEqual([]);
  valid = false;
  const newScope = state.scope;
  state = enqueue(state, newScope, id(102), 'Hello').state;
  const revoked = createChatTransport({ baseUrl: 'https://test.invalid', getCredentialGeneration: () => 1, request: handler, store: { get: () => state, set: next => { state = next; } } });
  expect(await revoked.send(id(102), { scope: newScope, token: 'revoked', credentialGeneration: 1 })).toEqual({ ok: false, error: 'auth_required' });
  expect(state.phase).toBe('paused');
  expect(state.messages).toMatchObject([{ clientId: id(102), body: 'Hello', status: 'queued' }]);
});

it('client sees idempotency conflict and membership close without fake acceptance', async () => {
  const scope = { userId: principal.userId, coupleId: c1, membershipEpoch: 1, sessionId: 'one' };
  await sendMessage(adapter(pg), principal, command);
  let state = enqueue(createQueue(scope), scope, command.clientId, 'Conflicting text').state;
  const handler = createChatHandler(adapter(pg), async () => principal);
  const transport = createChatTransport({ baseUrl: 'https://test.invalid', getCredentialGeneration: () => 1, request: handler,
    store: { get: () => state, set: next => { state = next; } } });
  expect(await transport.send(command.clientId, { scope, token: 'one', credentialGeneration: 1 })).toEqual({ ok: false, error: 'rejected' });
  expect(state.messages[0].status).toBe('failed');
  state = enqueue(state, scope, id(102), 'Next').state;
  await closeCouple(adapter(pg), principal, c1, 1);
  expect(await transport.send(id(102), { scope, token: 'one', credentialGeneration: 1 })).toEqual({ ok: false, error: 'access_required' });
  expect(state.phase).toBe('paused');
  expect(state.messages).toHaveLength(2);
  expect(state.messages[1]).toMatchObject({ clientId: id(102), body: 'Next', status: 'queued' });
  expect((await pg.query('SELECT * FROM chat_messages')).rows).toHaveLength(1);
});

it('old 401 after same-scope credential refresh cannot pause a fresh SQL-backed send', async () => {
  const scope = { userId: principal.userId, coupleId: c1, membershipEpoch: 1, sessionId: 'same' };
  let state = enqueue(createQueue(scope), scope, command.clientId, 'Hello').state;
  let generation = 1;
  let release!: () => void;
  let received!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { received = resolve; });
  const handler = createChatHandler(adapter(pg), async token => token === 'fresh' ? principal : null);
  const transport = createChatTransport({ baseUrl: 'https://test.invalid', getCredentialGeneration: () => generation,
    store: { get: () => state, set: next => { state = next; } },
    request: async request => {
      const response = await handler(request);
      if (request.headers.get('authorization') === 'Bearer expired') { received(); await gate; }
      return response;
    } });
  const pending = transport.send(command.clientId, { scope, token: 'expired', credentialGeneration: 1 });
  await entered;
  state = pause(state, scope).state;
  generation = 2;
  state = resume(state, scope).state;
  expect(await transport.send(command.clientId, { scope, token: 'fresh', credentialGeneration: 2 }))
    .toEqual({ ok: true, value: { replay: false } });
  release();
  expect(await pending).toEqual({ ok: false, error: 'stale_credentials' });
  expect(state.phase).toBe('active');
  expect(state.messages[0]).toMatchObject({ body: 'Hello', status: 'accepted', attempt: 2 });
  expect((await pg.query('SELECT * FROM chat_messages')).rows).toHaveLength(1);
});
