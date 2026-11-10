import { createQueue, deleteConfirmed, enqueue, login, logout, pause, resume, retry } from '../src/chat/queue';
import { createChatTransport, type ChatMessage, type TransportSession } from '../src/chat/transport';
import type { QueueResult, QueueState, Scope } from '../src/chat/types';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope: Scope = { userId: uuid(1), coupleId: uuid(2), membershipEpoch: 1, sessionId: 'session-1' };
const session: TransportSession = { scope, token: 'synthetic-token', credentialGeneration: 1 };
const clientId = uuid(3);
const message: ChatMessage = { id: uuid(4), coupleId: scope.coupleId, senderId: scope.userId,
  clientId, seq: 1, body: 'hello', version: 1, createdAt: '2026-11-10T00:00:00.000Z' };
const stateOf = (result: QueueResult) => { if (!result.ok) throw new Error(result.error); return result.state; };
const envelope = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const success = (patch: Record<string, unknown> = {}, replay = false) => envelope({ ok: true, value: { message: { ...message, ...patch }, replay } });
const page = (messages: unknown[] = [message], nextBeforeSeq: unknown = null) => envelope({ ok: true, value: { messages, nextBeforeSeq } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup(handler: (request: Request) => Promise<Response> = async () => success()) {
  let state = stateOf(enqueue(createQueue(scope), scope, clientId, 'hello'));
  const store = { get: () => state, set: (next: QueueState) => { state = next; } };
  const request = jest.fn(handler);
  let generation = 1;
  const getCredentialGeneration = () => generation;
  const setCredentialGeneration = (value: number) => { generation = value; };
  const transport = createChatTransport({ baseUrl: 'https://chat.example.invalid/prefix', store, request, getCredentialGeneration });
  return { ...transport, store, request, getCredentialGeneration, setCredentialGeneration };
}
const failed = (error: string) => ({ ok: false, error });

it('sends exact scoped JSON, opaque token and stable idempotency key without ambient credentials', async () => {
  const client = setup();
  expect(await client.send(clientId, session)).toEqual({ ok: true, value: { replay: false } });
  const request = client.request.mock.calls[0][0];
  expect(request.url).toBe(`https://chat.example.invalid/v1/couples/${scope.coupleId}/chat/messages`);
  expect(request.method).toBe('POST');
  expect(request.headers.get('authorization')).toBe('Bearer synthetic-token');
  expect(request.headers.get('idempotency-key')).toBe(clientId);
  expect(request.headers.get('content-type')).toBe('application/json');
  expect(request.credentials).toBe('omit');
  expect(request.redirect).toBe('error');
  expect(request.cache).toBe('no-store');
  expect(await request.json()).toEqual({ membership_epoch: 1, client_message_id: clientId, body: 'hello' });
  expect(client.store.get().messages[0]).toMatchObject({ status: 'accepted', serverId: message.id, seq: 1, attempt: 1 });
});
it('failed network and 5xx attempts requeue; replay retry retains body and identity', async () => {
  const client = setup();
  client.request.mockRejectedValueOnce(new Error('private connection detail'))
    .mockResolvedValueOnce(envelope({ private: 'detail' }, 503)).mockResolvedValueOnce(success({}, true));
  expect(await client.send(clientId, session)).toEqual(failed('transport_error'));
  expect(client.store.get().messages[0]).toMatchObject({ status: 'queued', attempt: 1 });
  expect(await client.send(clientId, session)).toEqual(failed('transport_error'));
  expect(client.store.get().messages[0].status).toBe('queued');
  expect(await client.send(clientId, session)).toEqual({ ok: true, value: { replay: true } });
  expect(client.store.get().messages[0].attempt).toBe(3);
  for (const [request] of client.request.mock.calls) expect((await request.json()).client_message_id).toBe(clientId);
});
it.each([400, 409])('HTTP %s is a permanent rejection until explicit retry', async status => {
  const client = setup(async () => envelope({ error: 'private text' }, status));
  expect(await client.send(clientId, session)).toEqual(failed('rejected'));
  expect(client.store.get().messages[0]).toMatchObject({ status: 'failed', error: 'rejected' });
  expect(await client.send(clientId, session)).toEqual(failed('invalid_transition'));
  client.store.set(stateOf(retry(client.store.get(), scope, clientId)));
  client.request.mockResolvedValueOnce(success());
  expect((await client.send(clientId, session)).ok).toBe(true);
});
it.each([401, 403])('HTTP %s pauses and preserves every command and body', async status => {
  const client = setup(async () => envelope({}, status));
  client.store.set(stateOf(enqueue(client.store.get(), scope, uuid(77), 'second draft')));
  const identities = client.store.get().messages.map(({ clientId, body }) => ({ clientId, body }));
  expect(await client.send(clientId, session)).toEqual(failed(status === 401 ? 'auth_required' : 'access_required'));
  expect(client.store.get().phase).toBe('paused');
  expect(client.store.get().messages.map(({ clientId, body }) => ({ clientId, body }))).toEqual(identities);
  expect(client.store.get().messages.every(item => item.status === 'queued')).toBe(true);
});
it('explicit error envelope rejects without reflecting its text', async () => {
  const client = setup(async () => envelope({ ok: false, error: 'secret response text' }));
  expect(await client.send(clientId, session)).toEqual(failed('rejected'));
});
it.each([null, [], 1, {}, { ok: true }, { ok: false, error: 2 }, { ok: true, value: [] },
  { ok: true, value: { message, replay: 'yes' } }, { ok: true, value: {} }])('rejects invalid success envelope %p', async payload => {
  const client = setup(async () => envelope(payload));
  expect(await client.send(clientId, session)).toEqual(failed('invalid_response'));
  expect(client.store.get().messages[0].status).toBe('failed');
});
it('rejects malformed JSON without recording it', async () => {
  const client = setup(async () => new Response('not JSON private data'));
  expect(await client.send(clientId, session)).toEqual(failed('invalid_response'));
});
it.each([{ id: '' }, { id: 'not-a-uuid' }, { coupleId: '' }, { coupleId: uuid(99) }, { senderId: '' },
  { senderId: uuid(99) }, { clientId: '' }, { clientId: uuid(99) }, { seq: 0 }, { seq: '1' },
  { seq: Number.MAX_SAFE_INTEGER + 1 }, { version: -1 }, { body: null }, { body: 'x'.repeat(16001) },
  { body: 'x'.repeat(8001) }, { body: 'changed' }, { body: '\uD800' }, { body: 'e\u0301' },
  { createdAt: 1 }, { createdAt: 'x'.repeat(65) }, { createdAt: '' }, { createdAt: 'not-a-date' }])('rejects malformed or foreign message %p', async patch => {
  const client = setup(async () => success(patch));
  expect(await client.send(clientId, session)).toEqual(failed('invalid_response'));
  expect(client.store.get().messages[0].status).toBe('failed');
});
it.each(['', 'with space', '\r\nInjected: value', 'x'.repeat(2049)])('rejects invalid token before any request', async token => {
  const client = setup();
  expect(await client.send(clientId, { ...session, token })).toEqual(failed('invalid_token'));
  expect(await client.history({ ...session, token }, { limit: 10 })).toEqual(failed('invalid_token'));
  expect(client.request).not.toHaveBeenCalled();
  expect(client.store.get().messages[0].status).toBe('queued');
});
it.each(['file:///private', 'https://user:password@chat.example.invalid'])('rejects unsafe base URL %s', baseUrl => {
  const client = setup();
  expect(() => createChatTransport({ baseUrl, request: client.request, store: client.store, getCredentialGeneration: client.getCredentialGeneration })).toThrow('invalid_base_url');
});
it('rejects unknown records and repeated sends without a request', async () => {
  const pending = deferred<Response>();
  const client = setup(() => pending.promise);
  expect(await client.send(uuid(999), session)).toEqual(failed('unknown_message'));
  const first = client.send(clientId, session);
  expect(await client.send(clientId, session)).toEqual(failed('invalid_transition'));
  expect(client.request).toHaveBeenCalledTimes(1);
  pending.resolve(success());
  await first;
});
it.each(['userId', 'coupleId', 'membershipEpoch', 'sessionId'] as const)('rejects foreign caller scope %s before a request', async key => {
  const client = setup();
  const foreign = { ...scope, [key]: key === 'membershipEpoch' ? 2 : uuid(99) };
  expect(await client.send(clientId, { ...session, scope: foreign })).toEqual(failed('stale_session'));
  expect(client.request).not.toHaveBeenCalled();
});
it('paused and logged-out callers cannot send or read', async () => {
  const client = setup();
  client.store.set(stateOf(pause(client.store.get(), scope)));
  expect(await client.send(clientId, session)).toEqual(failed('inactive'));
  expect(await client.history(session, { limit: 10 })).toEqual(failed('inactive'));
  client.store.set(logout(client.store.get()));
  expect(await client.send(clientId, session)).toEqual(failed('stale_session'));
  expect(client.request).not.toHaveBeenCalled();
});
it.each([200, 401, 403, 503])('late HTTP %s cannot mutate a fresh login or leak prior history', async status => {
  for (const operation of ['send', 'history'] as const) {
    const pending = deferred<Response>();
    const client = setup(() => pending.promise);
    const result = operation === 'send' ? client.send(clientId, session) : client.history(session, { limit: 10 });
    const newScope = { ...scope, sessionId: 'session-2' };
    client.store.set(stateOf(enqueue(stateOf(login(client.store.get(), newScope)), newScope, clientId, 'new secret')));
    const fresh = client.store.get();
    pending.resolve(status === 200 ? (operation === 'send' ? success() : page()) : envelope({}, status));
    expect(await result).toEqual(failed('stale_session'));
    expect(client.store.get()).toBe(fresh);
  }
});
it('captures mutable caller scope and token before awaiting', async () => {
  const pending = deferred<Response>();
  const mutable = { ...session, scope: { ...scope } };
  const client = setup(() => pending.promise);
  const sent = client.send(clientId, mutable);
  mutable.scope.userId = uuid(100);
  mutable.scope.coupleId = uuid(101);
  mutable.token = 'changed';
  mutable.credentialGeneration = 99;
  pending.resolve(success());
  expect((await sent).ok).toBe(true);
  expect(client.request.mock.calls[0][0].headers.get('authorization')).toBe('Bearer synthetic-token');
});
it('suppresses failures after logout and successful responses while paused', async () => {
  const pending = deferred<Response>();
  const client = setup(() => pending.promise);
  const sent = client.send(clientId, session);
  client.store.set(logout(client.store.get()));
  pending.reject(new Error('disconnected'));
  expect(await sent).toEqual(failed('stale_session'));
  const secondPending = deferred<Response>();
  const second = setup(() => secondPending.promise);
  const secondSent = second.send(clientId, session);
  second.store.set(stateOf(pause(second.store.get(), scope)));
  secondPending.resolve(success());
  expect(await secondSent).toEqual(failed('inactive'));
  expect(second.store.get().messages[0].status).toBe('queued');
});
it('401 while paused keeps the same session and command intact', async () => {
  const pending = deferred<Response>();
  const client = setup(() => pending.promise);
  const sent = client.send(clientId, session);
  client.store.set(stateOf(pause(client.store.get(), scope)));
  pending.resolve(envelope({}, 401));
  expect(await sent).toEqual(failed('auth_required'));
  expect(client.store.get()).toMatchObject({ phase: 'paused', messages: [{ clientId, body: 'hello', status: 'queued' }] });
});
it.each([false, true])('checks scope after asynchronous response decoding (invalid JSON: %s)', async malformed => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; } }));
  const client = setup(async () => response);
  const sent = client.send(clientId, session);
  await Promise.resolve();
  client.store.set(logout(client.store.get()));
  controller.enqueue(new TextEncoder().encode(malformed ? 'invalid' : JSON.stringify({ ok: true, value: { message, replay: false } })));
  controller.close();
  expect(await sent).toEqual(failed('stale_session'));
  expect(client.store.get().messages).toEqual([]);
});
it('late errors do not roll back a newer attempt or an ACK', async () => {
  const pending = deferred<Response>();
  const client = setup(() => pending.promise);
  const first = client.send(clientId, session);
  client.store.set(stateOf(resume(stateOf(pause(client.store.get(), scope)), scope)));
  client.request.mockResolvedValueOnce(success());
  await client.send(clientId, session);
  pending.resolve(envelope({}, 503));
  await first;
  expect(client.store.get().messages[0]).toMatchObject({ status: 'accepted', attempt: 2 });
});
it('ACK reducer rejects server identity collisions and tombstones stay content-free', async () => {
  const client = setup();
  const first = await client.send(clientId, session);
  expect(first.ok).toBe(true);
  const nextId = uuid(5);
  client.store.set(stateOf(enqueue(client.store.get(), scope, nextId, 'hello')));
  client.request.mockResolvedValueOnce(success({ clientId: nextId }));
  expect(await client.send(nextId, session)).toEqual(failed('invalid_response'));
  const pending = deferred<Response>();
  const deleted = setup(() => pending.promise);
  const sent = deleted.send(clientId, session);
  deleted.store.set(stateOf(deleteConfirmed(deleted.store.get(), scope, clientId, message.id, 2)));
  pending.resolve(success());
  expect((await sent).ok).toBe(true);
  expect(deleted.store.get().messages[0]).toMatchObject({ deleted: true, body: null });
});
it('history validates ascending messages, sends bounded paging, and carries immutable scope', async () => {
  const newer = { ...message, id: uuid(6), clientId: uuid(7), senderId: uuid(8), seq: 2 };
  const client = setup(async () => page([message, newer], 1));
  const result = await client.history(session, { limit: 2, beforeSeq: 3 });
  expect(result).toEqual({ ok: true, value: { scope, credentialGeneration: 1, messages: [message, newer], nextBeforeSeq: 1 } });
  expect(client.store.get().messages[0].status).toBe('queued');
  const request = client.request.mock.calls[0][0];
  expect(request.url).toBe(`https://chat.example.invalid/v1/couples/${scope.coupleId}/chat/messages?membership_epoch=1&limit=2&beforeSeq=3`);
  expect(request.headers.get('idempotency-key')).toBeNull();
  expect(request.method).toBe('GET');
  expect(request.body).toBeNull();
  if (result.ok) {
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.scope)).toBe(true);
    expect(Object.isFrozen(result.value.messages)).toBe(true);
    expect(Object.isFrozen(result.value.messages[0])).toBe(true);
  }
});
it('empty and exact 100-entry terminal history pages are valid', async () => {
  const client = setup(async () => page([]));
  expect(await client.history(session, { limit: 100 })).toEqual({ ok: true, value: { scope, credentialGeneration: 1, messages: [], nextBeforeSeq: null } });
  client.request.mockResolvedValueOnce(page(Array.from({ length: 100 }, (_, i) => ({ ...message,
    id: uuid(100 + i), clientId: uuid(200 + i), seq: i + 1 }))));
  const result = await client.history(session, { limit: 100 });
  expect(result.ok && result.value.messages.length).toBe(100);
});
it.each([{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: 1, beforeSeq: 0 },
  { limit: 1, beforeSeq: Number.MAX_SAFE_INTEGER + 1 }])('rejects invalid history bounds %p', async options => {
  const client = setup();
  expect(await client.history(session, options)).toEqual(failed('invalid_request'));
  expect(client.request).not.toHaveBeenCalled();
});
it.each([
  { messages: null, cursor: null }, { messages: [message, message, message], cursor: null },
  { messages: [null], cursor: null }, { messages: [{ ...message, coupleId: uuid(100) }], cursor: null },
  { messages: [{ ...message, seq: 3 }], cursor: null }, { messages: [message, message], cursor: null },
  { messages: [message, { ...message, seq: 2, clientId: uuid(11) }], cursor: null },
  { messages: [message, { ...message, seq: 2, id: uuid(12) }], cursor: null },
  { messages: [message], cursor: 0 }, { messages: [message], cursor: 1 },
  { messages: [], cursor: 1 }, { messages: [message], cursor: undefined },
  { messages: [message, { ...message, seq: 2, id: uuid(12), clientId: uuid(13) }], cursor: 2 },
])('rejects invalid history shape/order/duplicates/cursor %p', async ({ messages, cursor }) => {
  const client = setup(async () => envelope({ ok: true, value: { messages, nextBeforeSeq: cursor } }));
  expect(await client.history(session, { limit: 2, beforeSeq: 3 })).toEqual(failed('invalid_response'));
});
it('history transport failures preserve records and opaque denial only pauses', async () => {
  const client = setup(async () => envelope({}, 503));
  const before = client.store.get();
  expect(await client.history(session, { limit: 10 })).toEqual(failed('transport_error'));
  expect(client.store.get()).toBe(before);
  client.request.mockResolvedValueOnce(envelope({}, 403));
  expect(await client.history(session, { limit: 10 })).toEqual(failed('access_required'));
  expect(client.store.get()).toMatchObject({ phase: 'paused', messages: [{ clientId, body: 'hello' }] });
});
it('captures paging options before awaiting', async () => {
  const pending = deferred<Response>();
  const client = setup(() => pending.promise);
  const options = { limit: 1, beforeSeq: 2 };
  const result = client.history(session, options);
  options.limit = 0;
  options.beforeSeq = 1;
  pending.resolve(page());
  expect((await result).ok).toBe(true);
});

it('requires nonempty, valid UTF-8 JSON and bounds streamed send responses', async () => {
  for (const response of [new Response(null), new Response(new Uint8Array([0xff])), new Response('')]) {
    const client = setup(async () => response);
    expect(await client.send(clientId, session)).toEqual(failed('invalid_response'));
  }
  const cancelled = jest.fn();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(32000));
      controller.enqueue(new Uint8Array(34000));
    }, cancel: cancelled,
  });
  const client = setup(async () => new Response(stream));
  expect(await client.send(clientId, session)).toEqual(failed('invalid_response'));
  expect(cancelled).toHaveBeenCalledTimes(1);
  expect(client.store.get().messages[0].status).toBe('failed');
});
it('bounds streamed history bytes independently of declared content length', async () => {
  const cancelled = jest.fn();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1)); }, cancel: cancelled,
  });
  const client = setup(async () => new Response(stream, { headers: { 'Content-Length': '2' } }));
  expect(await client.history(session, { limit: 100 })).toEqual(failed('invalid_response'));
  expect(cancelled).toHaveBeenCalledTimes(1);
});
it('reassembles chunked JSON and accepts new-message HTTP 201', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ ok: true, value: { message, replay: false } }));
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, 30));
      controller.enqueue(bytes.slice(30));
      controller.close();
    },
  });
  const client = setup(async () => new Response(stream, { status: 201 }));
  expect((await client.send(clientId, session)).ok).toBe(true);
});

it('requeues interrupted response streams without exposing transport errors', async () => {
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error('private transport failure')); } });
  const client = setup(async () => new Response(stream));
  expect(await client.send(clientId, session)).toEqual(failed('transport_error'));
  expect(client.store.get().messages[0].status).toBe('queued');
});

it('expired credentials preserve pending and accepted messages for a trusted refresh retry', async () => {
  const client = setup();
  await client.send(clientId, session);
  const secondId = uuid(88);
  client.store.set(stateOf(enqueue(client.store.get(), scope, secondId, 'unsent second body')));
  const before = client.store.get().messages.map(({ clientId, body, serverId }) => ({ clientId, body, serverId }));
  client.request.mockResolvedValueOnce(envelope({}, 401));
  expect(await client.send(secondId, session)).toEqual(failed('auth_required'));
  expect(client.store.get().messages.map(({ clientId, body, serverId }) => ({ clientId, body, serverId }))).toEqual(before);
  expect(await client.send(secondId, session)).toEqual(failed('inactive'));
  client.setCredentialGeneration(2);
  client.store.set(stateOf(resume(client.store.get(), scope)));
  const refreshed = { ...session, token: 'fresh-token', credentialGeneration: 2 };
  client.request.mockResolvedValueOnce(success({ id: uuid(89), clientId: secondId, seq: 2, body: 'unsent second body' }));
  expect((await client.send(secondId, refreshed)).ok).toBe(true);
  expect(client.store.get().messages.every(item => item.status === 'accepted')).toBe(true);
  const latest = client.request.mock.calls[2][0];
  expect(latest.headers.get('authorization')).toBe('Bearer fresh-token');
  expect(latest.headers.get('idempotency-key')).toBe(secondId);
  expect((await latest.json()).body).toBe('unsent second body');
});
it.each([200, 401, 403, 409, 429, 503])('late HTTP %s from old credentials cannot settle or pause a new same-scope send', async status => {
  const old = deferred<Response>();
  const fresh = deferred<Response>();
  const client = setup(() => old.promise);
  const oldResult = client.send(clientId, session);
  client.store.set(stateOf(pause(client.store.get(), scope)));
  client.setCredentialGeneration(2);
  client.store.set(stateOf(resume(client.store.get(), scope)));
  client.request.mockImplementationOnce(() => fresh.promise);
  const freshResult = client.send(clientId, { ...session, token: 'fresh-token', credentialGeneration: 2 });
  const duringFreshSend = client.store.get();
  old.resolve(status === 200 ? success() : envelope({}, status));
  expect(await oldResult).toEqual(failed('stale_credentials'));
  expect(client.store.get()).toBe(duringFreshSend);
  expect(client.store.get()).toMatchObject({ phase: 'active', messages: [{ status: 'sending', attempt: 2, clientId, body: 'hello' }] });
  fresh.resolve(success({}, true));
  expect(await freshResult).toEqual({ ok: true, value: { replay: true } });
  expect(client.store.get().messages[0].status).toBe('accepted');
});
it('old credential network failures cannot fail or requeue the refreshed attempt', async () => {
  const old = deferred<Response>();
  const client = setup(() => old.promise);
  const result = client.send(clientId, session);
  client.store.set(stateOf(pause(client.store.get(), scope)));
  client.setCredentialGeneration(2);
  client.store.set(stateOf(resume(client.store.get(), scope)));
  const fresh = client.store.get();
  old.reject(new Error('old connection failure'));
  expect(await result).toEqual(failed('stale_credentials'));
  expect(client.store.get()).toBe(fresh);
});
it.each([200, 401, 403, 429])('late history HTTP %s is suppressed after same-scope credential refresh', async status => {
  const pending = deferred<Response>();
  const client = setup(() => pending.promise);
  const history = client.history(session, { limit: 10 });
  client.setCredentialGeneration(2);
  const fresh = client.store.get();
  pending.resolve(status === 200 ? page() : envelope({}, status));
  expect(await history).toEqual(failed('stale_credentials'));
  expect(client.store.get()).toBe(fresh);
});
it.each(['valid', 'malformed', 'interrupted'])('suppresses %s response decoding after same-scope credential refresh', async mode => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; } }));
  const client = setup(async () => response);
  const sent = client.send(clientId, session);
  await Promise.resolve();
  client.store.set(stateOf(pause(client.store.get(), scope)));
  client.setCredentialGeneration(2);
  client.store.set(stateOf(resume(client.store.get(), scope)));
  const fresh = client.store.get();
  if (mode === 'interrupted') controller.error(new Error('private error'));
  else {
    controller.enqueue(new TextEncoder().encode(mode === 'malformed' ? 'invalid JSON' : JSON.stringify({ ok: true, value: { message, replay: false } })));
    controller.close();
  }
  expect(await sent).toEqual(failed('stale_credentials'));
  expect(client.store.get()).toBe(fresh);
});
it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 2])('rejects invalid or stale credential generation %s before networking', async credentialGeneration => {
  const client = setup();
  expect(await client.send(clientId, { ...session, credentialGeneration })).toEqual(failed('stale_credentials'));
  expect(await client.history({ ...session, credentialGeneration }, { limit: 10 })).toEqual(failed('stale_credentials'));
  expect(client.request).not.toHaveBeenCalled();
});
it.each([401, 403])('history HTTP %s preserves active in-flight sends while pausing the queue', async status => {
  const pending = deferred<Response>();
  const client = setup(() => pending.promise);
  const sending = client.send(clientId, session);
  client.request.mockResolvedValueOnce(envelope({}, status));
  expect(await client.history(session, { limit: 10 })).toEqual(failed(status === 401 ? 'auth_required' : 'access_required'));
  expect(client.store.get()).toMatchObject({ phase: 'paused', messages: [{ clientId, body: 'hello', status: 'queued' }] });
  pending.resolve(success());
  expect(await sending).toEqual(failed('inactive'));
});
it('HTTP 429 is typed, preserves the queued command, and performs no automatic retry', async () => {
  const client = setup(async () => envelope({}, 429));
  expect(await client.send(clientId, session)).toEqual(failed('rate_limited'));
  expect(client.store.get().messages[0]).toMatchObject({ status: 'queued', body: 'hello', clientId, error: null, attempt: 1 });
  await Promise.resolve();
  expect(client.request).toHaveBeenCalledTimes(1);
  const before = client.store.get();
  expect(await client.history(session, { limit: 10 })).toEqual(failed('rate_limited'));
  expect(client.store.get()).toBe(before);
  client.request.mockResolvedValueOnce(success());
  expect((await client.send(clientId, session)).ok).toBe(true);
  expect(client.store.get().messages[0].attempt).toBe(2);
});
it.each(['http://example.invalid', 'http://localhost', 'http://127.0.0.1', 'http://[::1]'])('requires HTTPS by default, including %s', baseUrl => {
  const client = setup();
  expect(() => createChatTransport({ baseUrl, request: client.request, store: client.store,
    getCredentialGeneration: client.getCredentialGeneration })).toThrow('invalid_base_url');
  expect(client.request).not.toHaveBeenCalled();
});
it.each(['http://localhost:1234', 'http://127.0.0.1:1234', 'http://[::1]:1234', 'https://chat.example.invalid'])('allows %s with explicit loopback test opt-in', async baseUrl => {
  const client = setup();
  const transport = createChatTransport({ baseUrl, request: client.request, store: client.store,
    getCredentialGeneration: client.getCredentialGeneration, allowHttpLoopbackForTests: true });
  expect((await transport.send(clientId, session)).ok).toBe(true);
});
it.each(['http://example.invalid', 'http://localhost.evil.invalid', 'http://127.0.0.2', 'http://[::2]',
  'http://user:password@localhost', 'ftp://localhost'])('test opt-in still blocks non-loopback or credentialed URL %s', baseUrl => {
  const client = setup();
  expect(() => createChatTransport({ baseUrl, request: client.request, store: client.store,
    getCredentialGeneration: client.getCredentialGeneration, allowHttpLoopbackForTests: true })).toThrow('invalid_base_url');
});
