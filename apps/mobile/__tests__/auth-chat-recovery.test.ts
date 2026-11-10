import { createSessionController } from '../src/auth/controller';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const identity = { userId: 'synthetic-provider', sessionId: 'synthetic-session' };
const context = { state: 'ready', sessionId: identity.sessionId, userId: uuid(1), coupleId: uuid(2), membershipEpoch: 1 };
const envelope = (value: unknown, status = 200) => new Response(JSON.stringify({ ok: true, value }), { status });
const page = () => envelope({ messages: [], nextBeforeSeq: null });
function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function settle() { for (let i = 0; i < 80; i++) await Promise.resolve(); }
function fixture() {
  const client = { signIn: jest.fn(async () => identity), signOut: jest.fn(async () => true),
    getCookie: jest.fn(async () => 'synthetic=cookie') };
  let id = 10;
  const ids = jest.fn(() => uuid(id++));
  const discovery = jest.fn(async () => envelope(context));
  const history = jest.fn(async () => page());
  const rows = new Map<string, object>();
  const posts: { client_message_id: string; body: string }[] = [];
  const send = jest.fn(async (input: Request) => {
    const body = await input.clone().json(); posts.push(body);
    const replay = rows.has(body.client_message_id);
    const row = rows.get(body.client_message_id) ?? { id: uuid(100 + rows.size), senderId: uuid(1), coupleId: uuid(2),
      clientId: body.client_message_id, body: body.body, seq: rows.size + 1, version: 1, createdAt: '2026-11-10T00:00:00Z' };
    rows.set(body.client_message_id, row);
    return envelope({ message: row, replay });
  });
  const controller = createSessionController({ mode: 'synthetic-loopback', baseURL: 'http://localhost:8787' }, client,
    request => new URL(request.url).pathname === '/v1/session/context' ? discovery()
      : request.method === 'POST' ? send(request) : history(), ids);
  return { controller, client, ids, discovery, history, send, rows, posts,
    login: () => controller.signIn('synthetic@example.test', 'synthetic') };
}

it.each([503, 'throw'] as const)('preserves draft and pending command through transient discovery %s', async outcome => {
  const f = fixture(); await f.login(); f.controller.setDraft('original');
  if (outcome === 'throw') f.discovery.mockRejectedValueOnce(new Error('network'));
  else f.discovery.mockResolvedValueOnce(envelope({}, outcome));
  await f.controller.send();
  expect(f.controller.getSnapshot()).toMatchObject({ phase: 'signed_in', draft: 'original', outgoing: { body: 'original', status: 'retry' } });
  expect(f.send).not.toHaveBeenCalled();
  f.controller.setDraft('edited');
  await f.controller.send();
  expect(f.posts).toHaveLength(1); expect(f.posts[0].body).toBe('original');
  expect(f.controller.getSnapshot()).toMatchObject({ draft: 'edited', outgoing: { status: 'sent' } });
});
it('lost acknowledgement replays normalized immutable text despite edits, then permits a new identical command', async () => {
  const f = fixture(); await f.login();
  const original = f.send.getMockImplementation()!;
  f.send.mockImplementationOnce(async input => { await original(input); throw new Error('lost response'); });
  f.controller.setDraft('Cafe\u0301\r\nfixture'); await f.controller.send();
  f.controller.setDraft('Café\nfixture'); await f.controller.send();
  expect(f.posts[0]).toEqual(f.posts[1]); expect(f.rows.size).toBe(1); expect(f.ids).toHaveBeenCalledTimes(1);
  expect(f.controller.getSnapshot().draft).toBe('Café\nfixture');
  await f.controller.send();
  expect(f.posts[2].client_message_id).not.toBe(f.posts[0].client_message_id);
  expect(f.rows.size).toBe(2); expect(f.controller.getSnapshot().draft).toBe('');
});
it('ACK stays sent when subsequent history fails and refresh never auto-retries', async () => {
  const f = fixture(); await f.login(); f.controller.setDraft('fixture');
  f.history.mockRejectedValueOnce(new Error('history unavailable'));
  await f.controller.send();
  expect(f.controller.getSnapshot()).toMatchObject({ error: 'transport_error', draft: '', outgoing: { status: 'sent' } });
  await f.controller.refresh(); expect(f.send).toHaveBeenCalledTimes(1);
});
it('superseded discovery leaves explicit retry without generating a command or writing', async () => {
  const f = fixture(); await f.login(); f.controller.setDraft('fixture'); const pending = deferred();
  f.discovery.mockReturnValueOnce(pending.promise);
  const sending = f.controller.send(); await settle(); await f.controller.refresh();
  pending.resolve(envelope(context)); await sending;
  expect(f.ids).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  expect(f.controller.getSnapshot().outgoing?.status).toBe('retry');
  await f.controller.send(); expect(f.rows.size).toBe(1);
});
it.each([401, 403, 'changed', 'invalid', 'unmapped', 'logout', 'dispose'] as const)('drops unresolved command and draft on %s', async reason => {
  const f = fixture(); await f.login(); f.controller.setDraft('fixture');
  f.send.mockRejectedValueOnce(new Error('lost response')); await f.controller.send();
  if (reason === 'logout') await f.controller.signOut();
  else if (reason === 'dispose') f.controller.dispose();
  else {
    f.discovery.mockResolvedValueOnce(typeof reason === 'number' ? envelope({}, reason)
      : envelope(reason === 'changed' ? { ...context, membershipEpoch: 2 }
        : reason === 'unmapped' ? { state: 'unmapped', sessionId: identity.sessionId }
        : { ...context, sessionId: 'other' }));
    await f.controller.refresh();
  }
  expect(f.controller.getSnapshot().draft).toBe(''); expect(f.controller.getSnapshot().outgoing).toBeUndefined();
  expect(f.send).toHaveBeenCalledTimes(1);
});
it('dispose aborts requests, drops late ACK, and allows fresh setup without external logout', async () => {
  const f = fixture(); await f.login(); const pending = deferred();
  f.send.mockReturnValueOnce(pending.promise); f.controller.setDraft('fixture');
  const sending = f.controller.send(); await settle(); f.controller.dispose(); f.controller.dispose();
  expect(f.client.signOut).toHaveBeenCalledTimes(1);
  pending.resolve(envelope({})); await sending;
  expect(f.controller.getSnapshot()).toEqual({ phase: 'signed_out', draft: '', error: null, messages: [] });
  await f.login(); expect(f.controller.getSnapshot().phase).toBe('signed_in');
});
it('ACK never erases an A→B→A draft revision, even during a double tap', async () => {
  const f = fixture(); await f.login(); const pending = deferred();
  const original = f.send.getMockImplementation()!;
  f.send.mockImplementationOnce(async input => { const result = await original(input); await pending.promise; return result; });
  f.controller.setDraft('A'); const sending = f.controller.send(); await settle();
  await f.controller.send(); f.controller.setDraft('B'); f.controller.setDraft('A');
  expect(f.controller.getSnapshot().outgoing?.status).toBe('sending');
  pending.resolve(page()); await sending;
  expect(f.controller.getSnapshot().draft).toBe('A'); expect(f.posts).toHaveLength(1);
});
it('a stale authentication failure after dispose cannot change the replacement lifecycle', async () => {
  const f = fixture();
  let reject!: (error: Error) => void;
  f.client.signOut.mockReturnValueOnce(new Promise((_resolve, no) => { reject = no; }));
  const login = f.login(); await settle(); f.controller.dispose();
  reject(new Error('old cleanup failed')); await login;
  expect(f.controller.getSnapshot().phase).toBe('signed_out');
  await f.login(); expect(f.controller.getSnapshot().phase).toBe('signed_in');
});
it.each(['signIn', 'signOut'] as const)('dispose cancels queued %s before any SDK write', async action => {
  const f = fixture();
  const pending = action === 'signIn' ? f.login() : f.controller.signOut();
  f.controller.dispose(); await pending;
  expect(f.client.signOut).not.toHaveBeenCalled();
  expect(f.client.signIn).not.toHaveBeenCalled();
  expect(f.controller.getSnapshot().phase).toBe('signed_out');
});
it('disposing an old queued login cannot sign out a replacement controller sharing the SDK', async () => {
  const f = fixture();
  const replacement = createSessionController({ mode: 'synthetic-loopback', baseURL: 'http://localhost:8787' },
    f.client, async request => new URL(request.url).pathname === '/v1/session/context' ? envelope(context) : page(), () => uuid(30));
  const oldLogin = f.login(); f.controller.dispose();
  await replacement.signIn('replacement@example.test', 'synthetic'); await oldLogin;
  expect(f.client.signOut).toHaveBeenCalledTimes(1);
  expect(f.client.signIn).toHaveBeenCalledTimes(1);
  expect(replacement.getSnapshot().phase).toBe('signed_in');
});
