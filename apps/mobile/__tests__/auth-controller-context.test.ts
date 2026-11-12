import { createSessionController } from './legacy-chat-window.fixture';
import type { SyntheticConfig } from '../src/auth/config';
import type { AuthIdentity } from '../src/auth/official-client';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const config: SyntheticConfig = { mode: 'synthetic-loopback', baseURL: 'http://127.0.0.1:8787' };
const identity: AuthIdentity = { userId: 'provider-account', sessionId: 'verified-session' };
const ready = { state: 'ready', sessionId: identity.sessionId,
  userId: uuid(1), coupleId: uuid(2), membershipEpoch: 1 };
type Ready = typeof ready;
const envelope = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const contextResponse = (value: unknown = ready) => envelope({ ok: true, value });
const row = (context: Ready = ready) => ({ id: uuid(4), coupleId: context.coupleId,
  senderId: context.userId, clientId: uuid(30), seq: 1, body: `History ${context.coupleId}:${context.membershipEpoch}`,
  version: 1, createdAt: '2026-11-10T00:00:00.000Z' });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { for (let i = 0; i < 60; i++) await Promise.resolve(); }
function setup() {
  let current = ready;
  const client = {
    signIn: jest.fn<Promise<AuthIdentity | null>, [string, string]>().mockResolvedValue(identity),
    signOut: jest.fn<Promise<boolean>, []>().mockResolvedValue(true),
    getCookie: jest.fn<Promise<string>, []>().mockResolvedValue('better-auth.session_token=synthetic-cookie'),
  };
  const discovery = jest.fn(async (_input: Request) => contextResponse(current));
  const chat = jest.fn(async (input: Request) => {
    if (input.method === 'POST') {
      const body = await input.clone().json();
      return envelope({ ok: true, value: { message: { ...row(current), id: uuid(90), seq: 90, body: body.body, clientId: body.client_message_id }, replay: false } });
    }
    return envelope({ ok: true, value: { messages: [row(current)], nextBeforeSeq: null } });
  });
  const commandId = jest.fn(() => uuid(3));
  const controller = createSessionController(config, client, input =>
    new URL(input.url).pathname === '/v1/session/context' ? discovery(input) : chat(input), commandId);
  const login = () => controller.signIn('fixture@example.test', 'synthetic-password');
  return { controller, client, discovery, chat, commandId, login, setContext(next: Ready) { current = next; } };
}

it('discovers domain membership from a bodyless cookie-authenticated request after verified sign-in', async () => {
  const { controller, client, discovery, chat, login } = setup();
  await login();
  expect(controller.getSnapshot()).toMatchObject({ phase: 'signed_in', error: null, messages: [row()] });
  expect(discovery).toHaveBeenCalled();
  const input = discovery.mock.calls[0][0];
  expect(input.url).toBe(`${config.baseURL}/v1/session/context`);
  expect(input.method).toBe('GET');
  expect(input.body).toBeNull();
  expect(input.headers.get('cookie')).toBe('better-auth.session_token=synthetic-cookie');
  expect(input.headers.get('origin')).toBe(config.baseURL);
  expect(input.headers.has('authorization')).toBe(false);
  expect(input.credentials).toBe('omit');
  expect(input.redirect).toBe('error');
  expect(input.cache).toBe('no-store');
  expect(client.signIn.mock.invocationCallOrder[0]).toBeLessThan(discovery.mock.invocationCallOrder[0]);
  expect(discovery.mock.invocationCallOrder[0]).toBeLessThan(chat.mock.invocationCallOrder[0]);
  expect(chat.mock.calls[0][0].url).toContain(`/couples/${ready.coupleId}/`);
  expect(ready.userId).not.toBe(identity.userId);
});
it('keeps discovery on the original exact origin when caller-owned configuration is mutated after construction', async () => {
  const originalOrigin = 'http://127.0.0.1:8877';
  const mutableConfig = { mode: 'synthetic-loopback' as const, baseURL: originalOrigin };
  const client = {
    signIn: jest.fn(async () => identity), signOut: jest.fn(async () => true),
    getCookie: jest.fn(async () => 'better-auth.session_token=synthetic-cookie'),
  };
  const request = jest.fn(async (input: Request) => new URL(input.url).pathname === '/v1/session/context'
    ? contextResponse() : envelope({ ok: true, value: { messages: [row()], nextBeforeSeq: null } }));
  const controller = createSessionController(mutableConfig, client, request, () => uuid(3));
  mutableConfig.baseURL = 'http://127.0.0.1:9999';
  await controller.signIn('fixture@example.test', 'synthetic-password');
  expect(controller.getSnapshot().phase).toBe('signed_in');
  mutableConfig.baseURL = 'http://untrusted.example.invalid';
  await controller.refresh();
  expect(controller.getSnapshot()).toMatchObject({ phase: 'signed_in', error: null, messages: [row()] });
  const inputs = request.mock.calls.map(([input]) => input);
  const discoveries = inputs.filter(input => new URL(input.url).pathname === '/v1/session/context');
  expect(discoveries).toHaveLength(2);
  for (const input of discoveries) expect(input.url).toBe(`${originalOrigin}/v1/session/context`);
  for (const input of inputs) {
    expect(new URL(input.url).origin).toBe(originalOrigin);
    expect(input.headers.get('origin')).toBe(originalOrigin);
    expect(input.headers.get('cookie')).toBe('better-auth.session_token=synthetic-cookie');
  }
});
it.each([
  [{ state: 'unmapped', sessionId: identity.sessionId }, 'context_unmapped'],
  [{ state: 'no_active_pair', sessionId: identity.sessionId, userId: uuid(1) }, 'context_no_active_pair'],
] as const)('blocks explicit unavailable context %p without reading chat', async (context, error) => {
  const { controller, discovery, chat, commandId, login } = setup();
  discovery.mockImplementation(async () => contextResponse(context));
  await login();
  expect(controller.getSnapshot()).toEqual({ phase: 'blocked', error, draft: '', messages: [] });
  controller.setDraft('must not send');
  await controller.send();
  await controller.refresh();
  expect(chat).not.toHaveBeenCalled();
  expect(commandId).not.toHaveBeenCalled();
});
it.each([401, 403, 500, 503])('blocks initial discovery HTTP %s without exposing response details', async status => {
  const { controller, discovery, chat, login } = setup();
  discovery.mockResolvedValueOnce(envelope({ private: 'hidden server detail' }, status));
  await login();
  const error = status === 401 ? 'auth_required' : status === 403 ? 'access_required' : 'transport_error';
  expect(controller.getSnapshot()).toEqual({ phase: 'blocked', error, draft: '', messages: [] });
  expect(chat).not.toHaveBeenCalled();
});
it.each([null, [], {}, { state: 'unknown', sessionId: identity.sessionId }, { ...ready, state: 'unknown' },
  { ...ready, sessionId: 'other-session' }, { ...ready, sessionId: '' }, { ...ready, sessionId: 1 },
  { ...ready, userId: '' }, { ...ready, userId: 'not-a-uuid' }, { ...ready, coupleId: null },
  { ...ready, coupleId: 'not-a-uuid' }, { ...ready, membershipEpoch: 0 }, { ...ready, membershipEpoch: 1.5 },
  { ...ready, membershipEpoch: Number.MAX_SAFE_INTEGER + 1 }, { ...ready, membershipEpoch: '1' },
  { state: 'no_active_pair', sessionId: identity.sessionId },
  { state: 'unmapped', sessionId: 'foreign-session' },
])('rejects malformed or session-unbound discovered context %p', async context => {
  const { controller, discovery, chat, login } = setup();
  discovery.mockResolvedValueOnce(contextResponse(context));
  await login();
  expect(controller.getSnapshot()).toEqual({ phase: 'blocked', error: 'invalid_context', draft: '', messages: [] });
  expect(chat).not.toHaveBeenCalled();
});
it.each([null, [], {}, { ok: false, error: 'private detail' }, { ok: true }, { ok: true, value: [] }])('rejects malformed discovery envelopes %p', async payload => {
  const { controller, discovery, chat, login } = setup();
  discovery.mockResolvedValueOnce(envelope(payload));
  await login();
  expect(controller.getSnapshot()).toEqual({ phase: 'blocked', error: 'invalid_context', draft: '', messages: [] });
  expect(chat).not.toHaveBeenCalled();
});
it.each(['bad-json', 'network-error'] as const)('safely blocks discovery %s', async failure => {
  const { controller, discovery, chat, login } = setup();
  if (failure === 'bad-json') discovery.mockResolvedValueOnce(new Response('private malformed body'));
  else discovery.mockRejectedValueOnce(new Error('private network detail'));
  await login();
  expect(controller.getSnapshot()).toEqual({ phase: 'blocked', error: failure === 'bad-json' ? 'invalid_context' : 'transport_error', draft: '', messages: [] });
  expect(chat).not.toHaveBeenCalled();
});
it('rejects discovery responses exceeding the bounded context payload size', async () => {
  const { controller, discovery, chat, login } = setup();
  discovery.mockResolvedValueOnce(envelope({ ok: true, value: ready, private: 'x'.repeat(4096) }));
  await login();
  expect(controller.getSnapshot()).toEqual({ phase: 'blocked', error: 'invalid_context', draft: '', messages: [] });
  expect(chat).not.toHaveBeenCalled();
});
it.each(['refresh', 'send'] as const)('rediscovers before %s and blocks revoked membership without issuing chat requests', async operation => {
  const { controller, discovery, chat, commandId, login } = setup();
  await login();
  controller.setDraft('private old draft');
  discovery.mockResolvedValueOnce(contextResponse({ state: 'no_active_pair', sessionId: identity.sessionId, userId: uuid(1) }));
  await controller[operation]();
  expect(controller.getSnapshot()).toEqual({ phase: 'blocked', error: 'context_no_active_pair', draft: '', messages: [] });
  expect(chat).toHaveBeenCalledTimes(1);
  expect(commandId).not.toHaveBeenCalled();
});
it.each(['refresh', 'send'] as const)('preserves drafts on discovery network failure during %s but never sends using cached membership', async operation => {
  const { controller, discovery, chat, login } = setup();
  await login();
  controller.setDraft('private draft');
  discovery.mockRejectedValueOnce(new Error('server unavailable'));
  await controller[operation]();
  expect(controller.getSnapshot()).toMatchObject({ phase: 'signed_in', error: 'transport_error', draft: 'private draft', messages: [row()] });
  expect(chat).toHaveBeenCalledTimes(1);
});
it.each([
  { ...ready, membershipEpoch: 2 },
  { ...ready, coupleId: uuid(12) },
  { ...ready, userId: uuid(11) },
])('a discovered scope change %p clears old private state and never sends the old draft', async changed => {
  for (const operation of ['refresh', 'send'] as const) {
    const { controller, chat, commandId, login, setContext } = setup();
    await login();
    controller.setDraft('old scope draft');
    setContext(changed);
    await controller[operation]();
    expect(controller.getSnapshot()).toMatchObject({ phase: 'signed_in', draft: '' });
    expect(controller.getSnapshot().messages).not.toContainEqual(row());
    expect(chat.mock.calls.every(([input]) => input.method === 'GET')).toBe(true);
    expect(commandId).not.toHaveBeenCalled();
    controller.setDraft('new scope draft');
    await controller.send();
    const post = chat.mock.calls.find(([input]) => input.method === 'POST')?.[0];
    expect(post).toBeDefined();
    expect(post?.url).toContain(`/couples/${changed.coupleId}/`);
    expect(await post?.json()).toMatchObject({ membership_epoch: changed.membershipEpoch, body: 'new scope draft' });
  }
});
it.each(['success', 'denial', 'rejection'] as const)('ignores late discovery %s after logout and another login', async outcome => {
  for (const operation of ['refresh', 'send'] as const) {
    const pending = deferred<Response>();
    const { controller, discovery, chat, login, setContext } = setup();
    await login();
    controller.setDraft('old private draft');
    discovery.mockReturnValueOnce(pending.promise);
    const old = controller[operation]();
    await settle();
    const input = discovery.mock.calls.at(-1)![0];
    await controller.signOut();
    expect(input.signal.aborted).toBe(true);
    setContext({ ...ready, coupleId: uuid(12), userId: uuid(11) });
    await login();
    controller.setDraft('fresh private draft');
    const fresh = controller.getSnapshot();
    if (outcome === 'rejection') pending.reject(new Error('old error'));
    else pending.resolve(outcome === 'denial' ? envelope({}, 401) : contextResponse());
    await old;
    expect(controller.getSnapshot()).toBe(fresh);
    expect(chat).toHaveBeenCalledTimes(2);
  }
});
it('logout is not held behind initial discovery and its late result cannot reopen the session', async () => {
  const pending = deferred<Response>();
  const { controller, client, discovery, chat, login } = setup();
  discovery.mockReturnValueOnce(pending.promise);
  const signingIn = login();
  await settle();
  const signingOut = controller.signOut();
  await settle();
  expect(client.signOut).toHaveBeenCalledTimes(2);
  expect(controller.getSnapshot().phase).toBe('signed_out');
  pending.resolve(contextResponse());
  await Promise.all([signingIn, signingOut]);
  expect(controller.getSnapshot()).toEqual({ phase: 'signed_out', error: null, draft: '', messages: [] });
  expect(chat).not.toHaveBeenCalled();
});
it('an older discovery cannot restore an old scope after a newer refresh changed membership', async () => {
  const pending = deferred<Response>();
  const { controller, discovery, chat, login, setContext } = setup();
  await login();
  discovery.mockReturnValueOnce(pending.promise);
  const old = controller.refresh();
  await settle();
  const changed = { ...ready, coupleId: uuid(12), membershipEpoch: 2 };
  setContext(changed);
  await controller.refresh();
  const fresh = controller.getSnapshot();
  pending.resolve(contextResponse());
  await old;
  expect(controller.getSnapshot()).toBe(fresh);
  expect(chat.mock.calls.at(-1)![0].url).toContain(`/couples/${changed.coupleId}/`);
});
it.each(['stale-change', 'stale-error'] as const)('ignores %s from an older discovery after a newer same-scope refresh', async outcome => {
  const pending = deferred<Response>();
  const { controller, discovery, login } = setup();
  await login();
  discovery.mockReturnValueOnce(pending.promise);
  const old = controller.refresh();
  await settle();
  await controller.refresh();
  const fresh = controller.getSnapshot();
  pending.resolve(outcome === 'stale-change' ? contextResponse({ ...ready, coupleId: uuid(12) }) : envelope({}, 503));
  await old;
  expect(controller.getSnapshot()).toBe(fresh);
});
it.each([401, 403])('honors late same-session discovery denial %s even after a newer refresh succeeds', async status => {
  const pending = deferred<Response>();
  const { controller, discovery, login } = setup();
  await login();
  discovery.mockReturnValueOnce(pending.promise);
  const old = controller.refresh();
  await settle();
  await controller.refresh();
  pending.resolve(envelope({}, status));
  await old;
  expect(controller.getSnapshot()).toEqual({ phase: 'blocked', error: status === 401 ? 'auth_required' : 'access_required', draft: '', messages: [] });
});
it.each(['', 'a=b\r\nInjected: value', 'a=b\u0000', 'a=b\u007f', 'x'.repeat(8193)])('blocks invalid discovery cookie %# before any network request', async cookie => {
  const { controller, client, discovery, chat, login } = setup();
  client.getCookie.mockResolvedValueOnce(cookie);
  await login();
  expect(controller.getSnapshot()).toEqual({ phase: 'blocked', error: 'auth_required', draft: '', messages: [] });
  expect(discovery).not.toHaveBeenCalled();
  expect(chat).not.toHaveBeenCalled();
});
it('accepts the discovery cookie-size boundary without dropping cookie pairs', async () => {
  const { controller, client, discovery, login } = setup();
  const cookie = `a=b; c=${'x'.repeat(8185)}`;
  expect(cookie).toHaveLength(8192);
  client.getCookie.mockResolvedValue(cookie);
  await login();
  expect(controller.getSnapshot().phase).toBe('signed_in');
  expect(discovery.mock.calls[0][0].headers.get('cookie')).toBe(cookie);
});
it('rejects a missing verified session identifier even when discovery returns the same empty identifier', async () => {
  const { controller, client, discovery, chat, login } = setup();
  client.signIn.mockResolvedValueOnce({ ...identity, sessionId: '' });
  discovery.mockResolvedValueOnce(contextResponse({ ...ready, sessionId: '' }));
  await login();
  expect(controller.getSnapshot()).toEqual({ phase: 'blocked', error: 'invalid_context', draft: '', messages: [] });
  expect(chat).not.toHaveBeenCalled();
});
it('a send superseded during discovery releases its lock without writing stale work', async () => {
  const pending = deferred<Response>();
  const { controller, discovery, chat, commandId, login } = setup();
  await login();
  controller.setDraft('synthetic draft');
  discovery.mockReturnValueOnce(pending.promise);
  const sending = controller.send();
  await settle();
  await controller.refresh();
  pending.resolve(contextResponse());
  await sending;
  expect(commandId).not.toHaveBeenCalled();
  expect(chat.mock.calls.every(([input]) => input.method === 'GET')).toBe(true);
  await controller.send();
  expect(commandId).toHaveBeenCalledTimes(1);
  expect(controller.getSnapshot()).toMatchObject({ phase: 'signed_in', draft: '', error: null });
});
it('membership changes discard old queued command identities even when the new draft has the same text', async () => {
  const { controller, chat, commandId, login, setContext } = setup();
  await login();
  commandId.mockReturnValueOnce(uuid(3)).mockReturnValueOnce(uuid(33));
  controller.setDraft('same synthetic text');
  chat.mockResolvedValueOnce(envelope({}, 503));
  await controller.send();
  setContext({ ...ready, membershipEpoch: 2 });
  await controller.send();
  expect(controller.getSnapshot()).toMatchObject({ phase: 'signed_in', draft: '', messages: [] });
  controller.setDraft('same synthetic text');
  await controller.send();
  const posts = chat.mock.calls.map(([input]) => input).filter(input => input.method === 'POST');
  expect(posts.map(input => input.headers.get('idempotency-key'))).toEqual([uuid(3), uuid(33)]);
  expect(await posts[0].json()).toMatchObject({ membership_epoch: 1 });
  expect(await posts[1].json()).toMatchObject({ membership_epoch: 2 });
  expect(commandId).toHaveBeenCalledTimes(2);
});
it.each(['refresh', 'send'] as const)('a late old-scope %s response cannot repopulate state after a discovered membership change', async operation => {
  const pending = deferred<Response>();
  const { controller, chat, login, setContext } = setup();
  await login();
  controller.setDraft('old draft');
  chat.mockReturnValueOnce(pending.promise);
  const old = controller[operation]();
  await settle();
  const oldInput = chat.mock.calls.at(-1)![0];
  setContext({ ...ready, coupleId: uuid(12), membershipEpoch: 2 });
  await controller.refresh();
  expect(oldInput.signal.aborted).toBe(true);
  controller.setDraft('new draft');
  const fresh = controller.getSnapshot();
  pending.resolve(operation === 'send'
    ? envelope({ ok: true, value: { message: { ...row(), body: 'old draft' }, replay: false } })
    : envelope({ ok: true, value: { messages: [row()], nextBeforeSeq: null } }));
  await old;
  expect(controller.getSnapshot()).toBe(fresh);
  expect(controller.getSnapshot().messages[0].coupleId).toBe(uuid(12));
});
