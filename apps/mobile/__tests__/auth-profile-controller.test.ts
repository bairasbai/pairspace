import { createSessionController } from './legacy-chat-window.fixture';
import type { SyntheticConfig } from '../src/auth/config';
import type { AuthIdentity } from '../src/auth/official-client';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const config: SyntheticConfig = { mode: 'synthetic-loopback', baseURL: 'http://127.0.0.1:8787' };
const identity: AuthIdentity = { userId: 'provider-account-a', sessionId: 'verified-session-a' };
const unmapped = { state: 'unmapped', sessionId: identity.sessionId };
const noPair = { state: 'no_active_pair', sessionId: identity.sessionId, userId: uuid(1) };
const ready = { ...noPair, state: 'ready', coupleId: uuid(2), membershipEpoch: 1 };
const message = { id: uuid(4), coupleId: uuid(2), senderId: uuid(1), clientId: uuid(3),
  seq: 1, body: 'Synthetic verified history', version: 1, createdAt: '2026-11-10T00:00:00.000Z' };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const ackValue = { sessionId: identity.sessionId, userId: uuid(1), created: true };
const ack = (patch: Record<string, unknown> = {}, status = 200) => json({ ok: true, value: { ...ackValue, ...patch } }, status);
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { for (let i = 0; i < 60; i++) await Promise.resolve(); }
function setup(initialContext: unknown = unmapped, inputConfig = config) {
  let context = initialContext;
  let afterProfile: (() => void) | undefined;
  const client = {
    signIn: jest.fn<Promise<AuthIdentity | null>, [string, string]>().mockResolvedValue(identity),
    signOut: jest.fn<Promise<boolean>, []>().mockResolvedValue(true),
    getCookie: jest.fn<Promise<string>, []>().mockResolvedValue('better-auth.session_token=synthetic-a'),
  };
  const discovery = jest.fn(async (_input: Request) => json({ ok: true, value: context }));
  const profile = jest.fn(async (_input: Request) => ack());
  const chat = jest.fn(async (_input: Request) => json({ ok: true, value: { messages: [message], nextBeforeSeq: null } }));
  const request = jest.fn((input: Request) => {
    const path = new URL(input.url).pathname;
    if (path === '/v1/session/context') return discovery(input);
    if (path !== '/v1/profile') return chat(input);
    return profile(input).then(response => {
      if (response.ok) { afterProfile?.(); afterProfile = undefined; }
      return response;
    });
  });
  const controller = createSessionController(inputConfig, client, request, () => uuid(3));
  const login = () => controller.signIn('fixture@example.test', 'synthetic-password');
  return { controller, client, discovery, profile, chat, request, login,
    setContext(next: unknown) { context = next; },
    setPostContext(next: unknown) { afterProfile = () => { context = next; }; },
  };
}
afterEach(() => jest.useRealTimers());

it('never provisions automatically on login, discovery, refresh, draft edits, or send', async () => {
  const { controller, discovery, profile, chat, login } = setup();
  await login();
  expect(controller.getSnapshot()).toEqual({ phase: 'blocked', error: 'context_unmapped', draft: '', messages: [] });
  controller.setDraft('must not survive');
  await controller.send();
  await controller.refresh();
  expect(discovery).toHaveBeenCalled();
  expect(profile).not.toHaveBeenCalled();
  expect(chat).not.toHaveBeenCalled();
  expect(controller.getSnapshot().draft).toBe('');
});
it('ignores profile creation before login and while authentication is busy', async () => {
  const pending = deferred<AuthIdentity | null>();
  const { controller, client, profile, login } = setup();
  await controller.createProfile();
  client.signIn.mockReturnValueOnce(pending.promise);
  const signingIn = login();
  await settle();
  await controller.createProfile();
  expect(profile).not.toHaveBeenCalled();
  pending.resolve(identity);
  await signingIn;
});
it.each([ready, noPair, null, { ...unmapped, sessionId: 'other-session' }])('does not provision outside an unmapped or retryable profile state %p', async context => {
  const { controller, profile, login } = setup(context);
  await login();
  const before = controller.getSnapshot();
  await controller.createProfile();
  expect(profile).not.toHaveBeenCalled();
  expect(controller.getSnapshot()).toBe(before);
});
it.each([[true, 200], [false, 200], [true, 201], [false, 201]] as const)('explicit creation sends only empty JSON and accepts created=%s HTTP%s before rediscovery', async (created, status) => {
  const { controller, client, discovery, profile, chat, login, setPostContext } = setup();
  await login();
  const count = discovery.mock.calls.length;
  profile.mockResolvedValueOnce(ack({ created }, status));
  setPostContext(noPair);
  const creating = controller.createProfile();
  expect(controller.getSnapshot()).toEqual({ phase: 'busy', error: null, draft: '', messages: [] });
  await creating;
  expect(profile).toHaveBeenCalledTimes(1);
  const input = profile.mock.calls[0][0];
  expect(input.url).toBe(`${config.baseURL}/v1/profile`);
  expect(input.method).toBe('POST');
  expect(input.headers.get('content-type')).toBe('application/json');
  expect(input.headers.get('cookie')).toBe('better-auth.session_token=synthetic-a');
  expect(input.headers.get('origin')).toBe(config.baseURL);
  expect(input.headers.has('authorization')).toBe(false);
  expect(input.credentials).toBe('omit');
  expect(input.redirect).toBe('error');
  expect(input.cache).toBe('no-store');
  expect(await input.json()).toEqual({});
  expect(discovery).toHaveBeenCalledTimes(count + 2);
  expect(discovery.mock.invocationCallOrder[count]).toBeLessThan(profile.mock.invocationCallOrder[0]);
  expect(profile.mock.invocationCallOrder[0]).toBeLessThan(discovery.mock.invocationCallOrder[count + 1]);
  expect(client.signIn).toHaveBeenCalledTimes(1);
  expect(controller.getSnapshot()).toEqual({ phase: 'blocked', error: 'context_no_active_pair', draft: '', messages: [] });
  expect(chat).not.toHaveBeenCalled();
  await controller.createProfile();
  expect(profile).toHaveBeenCalledTimes(1);
});
it('loads chat only after successful creation and an independently verified ready context', async () => {
  const { controller, profile, chat, login, setPostContext } = setup();
  await login();
  setPostContext(ready);
  await controller.createProfile();
  expect(profile).toHaveBeenCalledTimes(1);
  expect(controller.getSnapshot()).toEqual({ history: { status: 'ready', nextBeforeSeq: null, nextAfterSeq: null, boundedWindow: true, windowReset: true }, phase: 'signed_in', currentUserId: uuid(1), error: null, draft: '', messages: [message] });
  expect(chat).toHaveBeenCalledTimes(1);
  await controller.createProfile();
  expect(profile).toHaveBeenCalledTimes(1);
});
it('does not treat successful creation as evidence of mapping or pair membership', async () => {
  const { controller, profile, chat, login } = setup();
  await login();
  await controller.createProfile();
  expect(profile).toHaveBeenCalledTimes(1);
  expect(controller.getSnapshot()).toEqual({ phase: 'blocked', error: 'context_unmapped', draft: '', messages: [] });
  expect(chat).not.toHaveBeenCalled();
});
it.each(['cookie', 'request'] as const)('coalesces creation taps while awaiting %s', async stage => {
  const cookie = deferred<string>();
  const response = deferred<Response>();
  const { controller, client, profile, login, setPostContext } = setup();
  await login();
  if (stage === 'cookie') client.getCookie.mockReturnValueOnce(cookie.promise);
  else profile.mockReturnValueOnce(response.promise);
  const first = controller.createProfile();
  await settle();
  await controller.createProfile();
  await controller.createProfile();
  expect(profile).toHaveBeenCalledTimes(stage === 'cookie' ? 0 : 1);
  setPostContext(noPair);
  if (stage === 'cookie') cookie.resolve('better-auth.session_token=synthetic-a');
  else response.resolve(ack());
  await first;
  expect(profile).toHaveBeenCalledTimes(1);
  expect(controller.getSnapshot().error).toBe('context_no_active_pair');
});
it.each([500, 503, 'lost-ack', 'malformed-ack', 'cookie-error'] as const)('permits explicit idempotent retry after %s without automatic replay', async failure => {
  const { controller, client, profile, login, setPostContext } = setup();
  await login();
  if (failure === 'cookie-error') client.getCookie.mockRejectedValueOnce(new Error('private cookie failure'));
  else if (failure === 'lost-ack') profile.mockRejectedValueOnce(new Error('reply lost after server commit'));
  else if (failure === 'malformed-ack') profile.mockResolvedValueOnce(new Response('invalid private ACK'));
  else profile.mockResolvedValueOnce(json({ private: 'server detail' }, failure));
  await controller.createProfile();
  expect(controller.getSnapshot()).toEqual({ phase: 'blocked', error: 'profile_retry_required', draft: '', messages: [] });
  expect(profile).toHaveBeenCalledTimes(failure === 'cookie-error' ? 0 : 1);
  client.getCookie.mockResolvedValue('better-auth.session_token=refreshed-a');
  profile.mockResolvedValueOnce(ack({ created: false }));
  setPostContext(noPair);
  await controller.createProfile();
  expect(profile).toHaveBeenCalledTimes(failure === 'cookie-error' ? 1 : 2);
  for (const [input] of profile.mock.calls) expect(await input.json()).toEqual({});
  expect(profile.mock.calls.at(-1)![0].headers.get('cookie')).toBe('better-auth.session_token=refreshed-a');
  expect(controller.getSnapshot().error).toBe('context_no_active_pair');
});
it.each([400, 401, 403, 404, 409])('profile HTTP %s permanently blocks this attempt and clears retained identity', async status => {
  const { controller, discovery, profile, login } = setup();
  await login();
  profile.mockResolvedValueOnce(json({ private: 'server detail' }, status));
  await controller.createProfile();
  const error = status === 401 ? 'auth_required' : status === 403 ? 'access_required' : 'profile_unavailable';
  expect(controller.getSnapshot()).toEqual({ phase: 'blocked', error, draft: '', messages: [] });
  const discoveries = discovery.mock.calls.length;
  await controller.createProfile();
  await controller.refresh();
  expect(profile).toHaveBeenCalledTimes(1);
  expect(discovery).toHaveBeenCalledTimes(discoveries);
});
it.each(['', 'a=b\r\nInjected: value', 'a=b\u0000', 'x'.repeat(8193)])('rejects invalid profile cookie %# without transmitting it', async cookie => {
  const { controller, client, profile, login } = setup();
  await login();
  client.getCookie.mockResolvedValueOnce(cookie);
  await controller.createProfile();
  expect(controller.getSnapshot()).toEqual({ phase: 'blocked', error: 'auth_required', draft: '', messages: [] });
  expect(profile).not.toHaveBeenCalled();
  await controller.createProfile();
  expect(profile).not.toHaveBeenCalled();
});
it.each([null, [], {}, { ok: false, error: 'private detail' }, { ok: true }, { ok: true, value: [] },
  { ok: true, value: { ...ackValue, sessionId: 'foreign-session' } },
  { ok: true, value: { ...ackValue, sessionId: '' } },
  { ok: true, value: { ...ackValue, userId: '' } },
  { ok: true, value: { ...ackValue, userId: 'not-a-uuid' } },
  { ok: true, value: { ...ackValue, userId: 42 } },
  { ok: true, value: { ...ackValue, created: 'true' } },
  { ok: true, value: { ...ackValue, created: null } },
])('does not trust malformed or foreign-session ACK %p', async value => {
  const { controller, discovery, profile, chat, login } = setup();
  await login();
  const discoveries = discovery.mock.calls.length;
  profile.mockResolvedValueOnce(json(value));
  await controller.createProfile();
  expect(controller.getSnapshot()).toEqual({ phase: 'blocked', error: 'profile_retry_required', draft: '', messages: [] });
  expect(discovery).toHaveBeenCalledTimes(discoveries + 1);
  expect(chat).not.toHaveBeenCalled();
});
it('rejects oversized profile ACKs without exposing their content', async () => {
  const { controller, profile, login } = setup();
  await login();
  profile.mockResolvedValueOnce(json({ ok: true, value: ackValue, private: 'x'.repeat(4096) }));
  await controller.createProfile();
  expect(controller.getSnapshot()).toEqual({ phase: 'blocked', error: 'profile_retry_required', draft: '', messages: [] });
});
it.each(['resolve', 'reject'] as const)('ignores a cancelled profile cookie %s after logout and a fresh login', async outcome => {
  const pending = deferred<string>();
  const { controller, client, profile, login, setContext } = setup();
  await login();
  client.getCookie.mockReturnValueOnce(pending.promise);
  const creating = controller.createProfile();
  await settle();
  await controller.signOut();
  client.signIn.mockResolvedValueOnce({ userId: 'provider-account-b', sessionId: 'verified-session-b' });
  setContext({ ...noPair, sessionId: 'verified-session-b', userId: uuid(11) });
  await login();
  const fresh = controller.getSnapshot();
  if (outcome === 'resolve') pending.resolve('better-auth.session_token=old-a');
  else pending.reject(new Error('old cookie failure'));
  await creating;
  expect(controller.getSnapshot()).toBe(fresh);
  expect(profile).not.toHaveBeenCalled();
});
it.each(['success', 'denial', 'failure', 'malformed'] as const)('ignores late profile request %s after logout without waiting for the write', async outcome => {
  const pending = deferred<Response>();
  const { controller, client, discovery, profile, login, setContext } = setup();
  await login();
  profile.mockReturnValueOnce(pending.promise);
  const creating = controller.createProfile();
  await settle();
  expect(profile).toHaveBeenCalledTimes(1);
  const input = profile.mock.calls[0][0];
  await controller.signOut();
  expect(input.signal.aborted).toBe(true);
  expect(client.signOut).toHaveBeenCalledTimes(2);
  expect(controller.getSnapshot().phase).toBe('signed_out');
  setContext(noPair);
  await login();
  const fresh = controller.getSnapshot();
  const discoveries = discovery.mock.calls.length;
  if (outcome === 'failure') pending.reject(new Error('late lost ACK'));
  else pending.resolve(outcome === 'success' ? ack() : outcome === 'denial' ? json({}, 401) : json({ broken: true }));
  await creating;
  expect(controller.getSnapshot()).toBe(fresh);
  expect(discovery).toHaveBeenCalledTimes(discoveries);
});
it('ignores a cancelled profile ACK that finishes decoding after another account logs in', async () => {
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { body = controller; } }));
  const { controller, client, discovery, profile, login, setContext } = setup();
  await login();
  profile.mockResolvedValueOnce(response);
  const creating = controller.createProfile();
  await settle();
  await controller.signOut();
  client.signIn.mockResolvedValueOnce({ userId: 'provider-b', sessionId: 'verified-session-b' });
  setContext({ ...noPair, userId: uuid(11), sessionId: 'verified-session-b' });
  await login();
  const fresh = controller.getSnapshot();
  const discoveries = discovery.mock.calls.length;
  body.enqueue(new TextEncoder().encode(JSON.stringify({ ok: true, value: ackValue })));
  body.close();
  await creating;
  expect(controller.getSnapshot()).toBe(fresh);
  expect(discovery).toHaveBeenCalledTimes(discoveries);
});
it('an old profile completion cannot unlock or replace another account provisioning attempt', async () => {
  const old = deferred<Response>();
  const next = deferred<Response>();
  const { controller, client, profile, login, setContext } = setup();
  await login();
  profile.mockReturnValueOnce(old.promise);
  const first = controller.createProfile();
  await settle();
  await controller.signOut();
  client.signIn.mockResolvedValueOnce({ userId: 'provider-b', sessionId: 'verified-session-b' });
  setContext({ ...unmapped, sessionId: 'verified-session-b' });
  await login();
  profile.mockReturnValueOnce(next.promise);
  const second = controller.createProfile();
  await settle();
  old.resolve(ack());
  await first;
  expect(controller.getSnapshot().phase).toBe('busy');
  await controller.createProfile();
  expect(profile).toHaveBeenCalledTimes(2);
  setContext({ ...noPair, sessionId: 'verified-session-b', userId: uuid(11) });
  next.resolve(ack({ sessionId: 'verified-session-b', userId: uuid(11) }));
  await second;
  expect(controller.getSnapshot().error).toBe('context_no_active_pair');
});
it('aborts a timed-out creation request and permits an explicit safe retry', async () => {
  jest.useFakeTimers();
  const { controller, profile, login } = setup();
  await login();
  profile.mockImplementationOnce(input => new Promise((_resolve, reject) => {
    input.signal.addEventListener('abort', () => reject(new Error('synthetic timeout')), { once: true });
  }));
  const creating = controller.createProfile();
  await settle();
  expect(jest.getTimerCount()).toBe(1);
  await jest.advanceTimersByTimeAsync(10000);
  await creating;
  expect(controller.getSnapshot()).toEqual({ phase: 'blocked', error: 'profile_retry_required', draft: '', messages: [] });
  expect(jest.getTimerCount()).toBe(0);
});
it('uses the construction origin for profile writes despite later mutation of caller-owned config', async () => {
  const mutable = { mode: 'synthetic-loopback' as const, baseURL: 'http://127.0.0.1:8899' };
  const { controller, profile, login, setPostContext } = setup(unmapped, mutable);
  await login();
  mutable.baseURL = 'http://untrusted.example.invalid';
  setPostContext(noPair);
  await controller.createProfile();
  const input = profile.mock.calls[0][0];
  expect(input.url).toBe('http://127.0.0.1:8899/v1/profile');
  expect(input.headers.get('origin')).toBe('http://127.0.0.1:8899');
  expect(controller.getSnapshot().error).toBe('context_no_active_pair');
});
it.each([ready, noPair])('refreshes already provisioned preflight state %p without another write', async context => {
  const { controller, profile, login, setContext } = setup();
  await login();
  setContext(context);
  await controller.createProfile();
  expect(profile).not.toHaveBeenCalled();
  expect(controller.getSnapshot().phase).toBe(context.state === 'ready' ? 'signed_in' : 'blocked');
  expect(controller.getSnapshot().error).toBe(context.state === 'ready' ? null : 'context_no_active_pair');
});
it('recognizes a committed profile after a lost ACK through preflight instead of writing again', async () => {
  const { controller, profile, login, setContext } = setup();
  await login();
  profile.mockImplementationOnce(async () => {
    setContext(noPair);
    throw new Error('response lost after server commit');
  });
  await controller.createProfile();
  expect(controller.getSnapshot().error).toBe('profile_retry_required');
  await controller.createProfile();
  expect(profile).toHaveBeenCalledTimes(1);
  expect(controller.getSnapshot().error).toBe('context_no_active_pair');
});
it.each([401, 403, 'different-session', 'invalid-schema'] as const)('prevents POST when cookie preflight returns %s', async failure => {
  const { controller, client, discovery, profile, login } = setup();
  await login();
  client.getCookie.mockResolvedValue('better-auth.session_token=replaced-session');
  discovery.mockResolvedValueOnce(typeof failure === 'number' ? json({}, failure)
    : json({ ok: true, value: failure === 'different-session' ? { ...unmapped, sessionId: 'session-b' } : null }));
  await controller.createProfile();
  expect(controller.getSnapshot()).toEqual({ phase: 'blocked', error: failure === 403 ? 'access_required' : 'auth_required', draft: '', messages: [] });
  expect(profile).not.toHaveBeenCalled();
  const calls = discovery.mock.calls.length;
  await controller.createProfile();
  await controller.refresh();
  expect(discovery).toHaveBeenCalledTimes(calls);
});
it.each([503, 'network'] as const)('a failed preflight %s is safely retryable without an initial POST', async failure => {
  const { controller, discovery, profile, login, setPostContext } = setup();
  await login();
  if (failure === 'network') discovery.mockRejectedValueOnce(new Error('private preflight detail'));
  else discovery.mockResolvedValueOnce(json({}, failure));
  await controller.createProfile();
  expect(controller.getSnapshot().error).toBe('profile_retry_required');
  expect(profile).not.toHaveBeenCalled();
  setPostContext(noPair);
  await controller.createProfile();
  expect(profile).toHaveBeenCalledTimes(1);
  expect(controller.getSnapshot().error).toBe('context_no_active_pair');
});
it('uses the exact preflight cookie for POST even if official storage rotates before preflight completes', async () => {
  const pending = deferred<Response>();
  const { controller, client, discovery, profile, login, setPostContext } = setup();
  await login();
  discovery.mockReturnValueOnce(pending.promise);
  const creating = controller.createProfile();
  await settle();
  const input = discovery.mock.calls.at(-1)![0];
  client.getCookie.mockResolvedValue('better-auth.session_token=rotated-a');
  setPostContext(noPair);
  pending.resolve(json({ ok: true, value: unmapped }));
  await creating;
  expect(profile.mock.calls[0][0].headers.get('cookie')).toBe(input.headers.get('cookie'));
  expect(profile.mock.calls[0][0].headers.get('cookie')).toBe('better-auth.session_token=synthetic-a');
  expect(discovery.mock.calls.at(-1)![0].headers.get('cookie')).toBe('better-auth.session_token=rotated-a');
});
it.each(['success', 'rejection'] as const)('cancels an in-progress preflight %s before it can start a write', async outcome => {
  const pending = deferred<Response>();
  const { controller, discovery, profile, login } = setup();
  await login();
  discovery.mockReturnValueOnce(pending.promise);
  const creating = controller.createProfile();
  await settle();
  const input = discovery.mock.calls.at(-1)![0];
  await controller.signOut();
  expect(input.signal.aborted).toBe(true);
  if (outcome === 'success') pending.resolve(json({ ok: true, value: unmapped }));
  else pending.reject(new Error('cancelled preflight'));
  await creating;
  expect(profile).not.toHaveBeenCalled();
  expect(controller.getSnapshot()).toEqual({ phase: 'signed_out', error: null, draft: '', messages: [] });
});
it('does not derive chat scope from the profile ACK domain userId', async () => {
  const { controller, profile, chat, login, setPostContext } = setup();
  await login();
  profile.mockResolvedValueOnce(ack({ userId: uuid(99) }));
  setPostContext(ready);
  await controller.createProfile();
  expect(controller.getSnapshot()).toMatchObject({ phase: 'signed_in', currentUserId: uuid(1), messages: [message] });
  expect(chat.mock.calls[0][0].url).toContain(`/couples/${ready.coupleId}/`);
  expect(await profile.mock.calls[0][0].json()).toEqual({});
  expect(JSON.stringify(controller.getSnapshot())).not.toContain(uuid(99));
});
it('a denied rediscovery after a successful POST blocks access instead of asserting membership', async () => {
  const { controller, discovery, profile, chat, login } = setup();
  await login();
  discovery.mockResolvedValueOnce(json({ ok: true, value: unmapped })).mockResolvedValueOnce(json({}, 401));
  await controller.createProfile();
  expect(profile).toHaveBeenCalledTimes(1);
  expect(controller.getSnapshot()).toEqual({ phase: 'blocked', error: 'auth_required', draft: '', messages: [] });
  expect(chat).not.toHaveBeenCalled();
});
