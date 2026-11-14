import { createSessionController } from './legacy-chat-window.fixture';
import { defaultAuthConfig, syntheticStoragePrefix, validateSyntheticConfig, type SyntheticConfig } from '../src/auth/config';
import type { AuthIdentity } from '../src/auth/official-client';
import { createChatTransport, type ChatMessage, type TransportSession } from '../src/chat/transport';
import { createQueue } from '../src/chat/queue';
import type { QueueState } from '../src/chat/types';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const config: SyntheticConfig = {
  mode: 'synthetic-loopback', baseURL: 'http://127.0.0.1:8787',
};
const identity: AuthIdentity = { userId: 'auth-a', sessionId: 'synthetic-session' };
const readyContext = { state: 'ready', sessionId: identity.sessionId,
  userId: uuid(1), coupleId: uuid(2), membershipEpoch: 1 };
const message: ChatMessage = {
  coupleId: uuid(2), id: uuid(40), senderId: uuid(1), clientId: uuid(30),
  seq: 1, body: 'Synthetic history A', version: 1, createdAt: '2026-11-10T00:00:00.000Z',
};
const messageB: ChatMessage = { ...message, id: uuid(14), coupleId: uuid(12), senderId: uuid(11), body: 'Synthetic history B' };
const envelope = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const page = (messages: readonly ChatMessage[] = [message]) => envelope({ ok: true, value: { messages, nextBeforeSeq: null } });
const ack = (body: string, clientId = uuid(3)) => envelope({ ok: true, value: { message: { ...message, id: uuid(4 + Number(clientId.slice(-2))), seq: 2 + Number(clientId.slice(-2)), body, clientId }, replay: false } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { for (let i = 0; i < 60; i++) await Promise.resolve(); }
function setup(handler: (request: Request) => Promise<Response> = async () => page()) {
  const client = {
    signIn: jest.fn<Promise<AuthIdentity | null>, [string, string]>().mockResolvedValue(identity),
    signOut: jest.fn<Promise<boolean>, []>().mockResolvedValue(true),
    getCookie: jest.fn<Promise<string>, []>().mockResolvedValue('better-auth.session_token=synthetic-cookie'),
  };
  const request = jest.fn(handler);
  const discovery = jest.fn(async (_input: Request) => envelope({ ok: true, value: readyContext }));
  const commandId = jest.fn(() => uuid(3));
  const controller = createSessionController(config, client, input =>
    new URL(input.url).pathname === '/v1/session/context' ? discovery(input) : request(input), commandId);
  const login = () => controller.signIn('fixture@example.test', 'synthetic-password');
  return { controller, client, request, discovery, commandId, login };
}
afterEach(() => jest.useRealTimers());

it('defaults to disabled auth and accepts only explicit exact HTTP loopback origins', () => {
  expect(defaultAuthConfig).toBeNull();
  for (const baseURL of ['http://localhost', 'http://127.0.0.1:3000', 'http://[::1]:8080']) {
    expect(() => validateSyntheticConfig({ ...config, baseURL })).not.toThrow();
  }
  expect(() => validateSyntheticConfig({ ...config, mode: 'production' as SyntheticConfig['mode'] })).toThrow('invalid_synthetic_config');
});
it('isolates persistent SDK storage by the complete validated origin without lossy namespace collisions', () => {
  const prefix = syntheticStoragePrefix(config);
  expect(prefix).toMatch(/^pairspace-synthetic-v1-[0-9a-f]+$/);
  const encoded = prefix.replace('pairspace-synthetic-v1-', '');
  expect(encoded.match(/.{4}/g)?.map(unit => String.fromCharCode(Number.parseInt(unit, 16))).join('')).toBe(config.baseURL);
  expect(syntheticStoragePrefix({ ...config, baseURL: 'http://127.0.0.1:8788' })).not.toBe(prefix);
  expect(syntheticStoragePrefix({ ...config, baseURL: 'http://localhost:8787' })).not.toBe(prefix);
});
it.each(['https://localhost', 'http://example.invalid', 'http://127.0.0.1.evil.test', 'file:///tmp/test',
  'http://localhost/', 'http://localhost/path', 'http://localhost?test=1', 'http://localhost#test',
  'http://name@localhost', 'http://:password@localhost', 'not a URL'])('rejects unsafe auth origin %s', baseURL => {
  expect(() => validateSyntheticConfig({ ...config, baseURL })).toThrow();
});
it('starts with no private state and ignores session-only actions while signed out', async () => {
  const { controller, client, request, commandId } = setup();
  expect(controller.getSnapshot()).toEqual({ phase: 'signed_out', error: null, draft: '', messages: [] });
  controller.setDraft('must not survive');
  await controller.send();
  await controller.refresh();
  expect(controller.getSnapshot().draft).toBe('');
  expect(client.getCookie).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
  expect(commandId).not.toHaveBeenCalled();
});
it('cleans old credentials, discovers the verified identity context, and sends cookie/origin without bearer auth', async () => {
  const { controller, client, request, login } = setup();
  const listener = jest.fn();
  const unsubscribe = controller.subscribe(listener);
  const result = login();
  expect(controller.getSnapshot()).toEqual({ phase: 'busy', error: null, draft: '', messages: [] });
  await result;
  expect(client.signOut).toHaveBeenCalledTimes(1);
  expect(client.signIn).toHaveBeenCalledWith('fixture@example.test', 'synthetic-password');
  expect(client.signOut.mock.invocationCallOrder[0]).toBeLessThan(client.signIn.mock.invocationCallOrder[0]);
  expect(controller.getSnapshot()).toEqual({ history: { status: 'ready', nextBeforeSeq: null, nextAfterSeq: null, boundedWindow: true, windowReset: true }, phase: 'signed_in', currentUserId: uuid(1), error: null, draft: '', messages: [message] });
  const input = request.mock.calls[0][0];
  expect(new URL(input.url).pathname).toBe(`/v1/couples/${uuid(2)}/chat/reply-window`);
  expect(new URL(input.url).searchParams.get('membership_epoch')).toBe('1');
  expect(new URL(input.url).searchParams.get('direction')).toBe('latest');
  expect(new URL(input.url).searchParams.get('read_id')).toMatch(/^[0-9a-f-]{36}$/);
  expect(input.method).toBe('GET');
  expect(input.headers.get('cookie')).toBe('better-auth.session_token=synthetic-cookie');
  expect(input.headers.get('origin')).toBe(config.baseURL);
  expect(input.headers.has('authorization')).toBe(false);
  expect(input.credentials).toBe('omit');
  expect(input.redirect).toBe('error');
  expect(input.cache).toBe('no-store');
  expect(listener).toHaveBeenCalledTimes(3);
  unsubscribe();
  controller.setDraft('new draft');
  expect(listener).toHaveBeenCalledTimes(3);
});
it('clears an unsuccessful sign-in and allows a fresh attempt', async () => {
  const { controller, client, request, login } = setup();
  client.signIn.mockResolvedValueOnce(null);
  await login();
  expect(client.signOut).toHaveBeenCalledTimes(2);
  expect(request).not.toHaveBeenCalled();
  expect(controller.getSnapshot()).toEqual({ phase: 'signed_out', error: 'login_failed', draft: '', messages: [] });
  await login();
  expect(controller.getSnapshot().phase).toBe('signed_in');
});
it.each(['initial-cleanup', 'login-throws', 'failed-login-cleanup'] as const)('blocks safely after %s', async failure => {
  const { controller, client, request, login } = setup();
  if (failure === 'initial-cleanup') client.signOut.mockResolvedValueOnce(false);
  if (failure === 'login-throws') client.signIn.mockRejectedValueOnce(new Error('secret SDK detail'));
  if (failure === 'failed-login-cleanup') {
    client.signIn.mockResolvedValueOnce(null);
    client.signOut.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  }
  await login();
  expect(controller.getSnapshot()).toEqual({ phase: 'blocked', error: 'auth_failed', draft: '', messages: [] });
  expect(request).not.toHaveBeenCalled();
  await login();
  expect(client.signIn).toHaveBeenCalledTimes(failure === 'initial-cleanup' ? 0 : 1);
});
it('coalesces login taps while authentication is busy or already signed in', async () => {
  const waiting = deferred<AuthIdentity | null>();
  const { controller, client, login } = setup();
  client.signIn.mockReturnValueOnce(waiting.promise);
  const first = login();
  const second = login();
  await settle();
  controller.setDraft('ignored while busy');
  await controller.send();
  waiting.resolve(identity);
  await Promise.all([first, second]);
  await login();
  expect(client.signIn).toHaveBeenCalledTimes(1);
  expect(controller.getSnapshot().draft).toBe('');
});
it('cancels login before cleanup completes without starting authentication', async () => {
  const cleanup = deferred<boolean>();
  const { controller, client, request, login } = setup();
  client.signOut.mockReturnValueOnce(cleanup.promise);
  const signingIn = login();
  await settle();
  const signingOut = controller.signOut();
  cleanup.resolve(true);
  await Promise.all([signingIn, signingOut]);
  expect(client.signIn).not.toHaveBeenCalled();
  expect(client.signOut).toHaveBeenCalledTimes(2);
  expect(request).not.toHaveBeenCalled();
  expect(controller.getSnapshot().phase).toBe('signed_out');
});
it('serializes logout after a cancelled login and never hydrates its late identity', async () => {
  const authentication = deferred<AuthIdentity | null>();
  const { controller, client, request, login } = setup();
  client.signIn.mockReturnValueOnce(authentication.promise);
  const signingIn = login();
  await settle();
  const signingOut = controller.signOut();
  expect(controller.getSnapshot().phase).toBe('busy');
  expect(client.signOut).toHaveBeenCalledTimes(1);
  authentication.resolve(identity);
  await Promise.all([signingIn, signingOut]);
  expect(client.signOut).toHaveBeenCalledTimes(2);
  expect(client.getCookie).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
  expect(controller.getSnapshot()).toEqual({ phase: 'signed_out', error: null, draft: '', messages: [] });
});
it('does not let an unfinished initial history request block logout cleanup', async () => {
  const pending = deferred<Response>();
  const { controller, client, request, login } = setup(() => pending.promise);
  const signingIn = login();
  await settle();
  expect(request).toHaveBeenCalledTimes(1);
  const signingOut = controller.signOut();
  await settle();
  expect(client.signOut).toHaveBeenCalledTimes(2);
  expect(controller.getSnapshot().phase).toBe('signed_out');
  expect(request.mock.calls[0][0].signal.aborted).toBe(true);
  pending.resolve(page());
  await Promise.all([signingIn, signingOut]);
  expect(controller.getSnapshot().messages).toEqual([]);
});
it.each([false, 'throw'] as const)('scrubs state when logout fails (%s), blocks login and permits cleanup retry', async result => {
  const { controller, client, login } = setup();
  await login();
  controller.setDraft('private draft');
  if (result === false) client.signOut.mockResolvedValueOnce(false);
  else client.signOut.mockRejectedValueOnce(new Error('secret storage detail'));
  await controller.signOut();
  expect(controller.getSnapshot()).toEqual({ phase: 'blocked', error: 'auth_failed', draft: '', messages: [] });
  controller.setDraft('ignored');
  await controller.send();
  await login();
  expect(client.signIn).toHaveBeenCalledTimes(1);
  await controller.signOut();
  expect(controller.getSnapshot().phase).toBe('signed_out');
  await login();
  expect(controller.getSnapshot()).toMatchObject({ phase: 'signed_in', currentUserId: uuid(1), draft: '', error: null });
});
it.each([true, false])('only the latest logout may finish the session transition (cleanup succeeds: %s)', async succeeds => {
  const firstCleanup = deferred<boolean>();
  const secondCleanup = deferred<boolean>();
  const { controller, client, login } = setup();
  await login();
  client.signOut.mockReturnValueOnce(firstCleanup.promise).mockReturnValueOnce(secondCleanup.promise);
  const first = controller.signOut();
  await settle();
  const second = controller.signOut();
  firstCleanup.resolve(true);
  await first;
  await settle();
  expect(controller.getSnapshot()).toEqual({ phase: 'busy', error: null, draft: '', messages: [] });
  const ignoredLogin = login();
  expect(client.signIn).toHaveBeenCalledTimes(1);
  expect(client.signOut).toHaveBeenCalledTimes(3);
  secondCleanup.resolve(succeeds);
  await Promise.all([second, ignoredLogin]);
  expect(controller.getSnapshot()).toEqual({ phase: succeeds ? 'signed_out' : 'blocked', error: succeeds ? null : 'auth_failed', draft: '', messages: [] });
  expect(client.signIn).toHaveBeenCalledTimes(1);
});
it('isolates history, drafts and request scope between accounts and relogins', async () => {
  const { controller, client, request, discovery, login } = setup();
  await login();
  controller.setDraft('private A draft');
  const signingOut = controller.signOut();
  expect(controller.getSnapshot()).toEqual({ phase: 'busy', error: null, draft: '', messages: [] });
  await signingOut;
  client.signIn.mockResolvedValueOnce({ userId: 'auth-b', sessionId: identity.sessionId });
  client.getCookie.mockResolvedValue('better-auth.session_token=synthetic-cookie-b');
  discovery.mockImplementation(async () => envelope({ ok: true, value: {
    ...readyContext, userId: uuid(11), coupleId: uuid(12), membershipEpoch: 2,
  } }));
  request.mockResolvedValueOnce(page([messageB]));
  await login();
  expect(controller.getSnapshot()).toEqual({ history: { status: 'ready', nextBeforeSeq: null, nextAfterSeq: null, boundedWindow: true, windowReset: true }, phase: 'signed_in', currentUserId: uuid(11), error: null, draft: '', messages: [messageB] });
  const input = request.mock.calls[1][0];
  expect(new URL(input.url).pathname).toBe(`/v1/couples/${uuid(12)}/chat/reply-window`);
  expect(new URL(input.url).searchParams.get('membership_epoch')).toBe('2');
  expect(input.headers.get('cookie')).toContain('synthetic-cookie-b');
});
it.each(['refresh', 'send'] as const)('preserves private draft on transient getCookie failure during %s and rechecks before retry', async operation => {
  const { controller, client, request, login } = setup();
  await login();
  controller.setDraft('private draft');
  client.getCookie.mockRejectedValueOnce(new Error('cookie secret'));
  await controller[operation]();
  expect(request).toHaveBeenCalledTimes(1);
  expect(controller.getSnapshot()).toMatchObject({ phase: 'signed_in', currentUserId: uuid(1), error: 'transport_error', draft: 'private draft', messages: [message] });
  await controller.refresh();
  expect(request).toHaveBeenCalledTimes(2);
  await controller.signOut();
  await login();
  expect(controller.getSnapshot().error).toBeNull();
});
it.each(['refresh', 'send'] as const)('blocks and purges private state if the official cookie disappears during %s', async operation => {
  const { controller, client, request, login } = setup();
  await login();
  controller.setDraft('private draft');
  client.getCookie.mockResolvedValueOnce('');
  await controller[operation]();
  expect(controller.getSnapshot()).toEqual({ phase: 'blocked', error: 'auth_required', draft: '', messages: [] });
  expect(request).toHaveBeenCalledTimes(1);
});
it.each(['refresh', 'send'] as const)('discards a delayed cookie result after logout during %s', async operation => {
  const cookie = deferred<string>();
  const { controller, client, request, login } = setup();
  await login();
  controller.setDraft('old draft');
  client.getCookie.mockReturnValueOnce(cookie.promise);
  const pending = controller[operation]();
  await controller.signOut();
  await login();
  const fresh = controller.getSnapshot();
  cookie.resolve('better-auth.session_token=old-cookie');
  await pending;
  expect(request).toHaveBeenCalledTimes(2);
  expect(controller.getSnapshot()).toBe(fresh);
});
it.each(['refresh', 'send'] as const)('ignores a delayed cookie rejection after logout during %s', async operation => {
  const cookie = deferred<string>();
  const { controller, client, login } = setup();
  await login();
  controller.setDraft('old draft');
  client.getCookie.mockReturnValueOnce(cookie.promise);
  const pending = controller[operation]();
  await controller.signOut();
  cookie.reject(new Error('private cookie error'));
  await pending;
  expect(controller.getSnapshot()).toEqual({ phase: 'signed_out', error: null, draft: '', messages: [] });
});
it.each([401, 403])('denial %s on history or send purges state and blocks further requests', async status => {
  for (const operation of ['refresh', 'send'] as const) {
    const { controller, request, login } = setup();
    await login();
    controller.setDraft('private draft');
    request.mockImplementationOnce(async input => envelope({ ok: false, error: 'unavailable', ...(input.method === 'GET' ? { readId: new URL(input.url).searchParams.get('read_id') } : {}) }, status));
    await controller[operation]();
    expect(controller.getSnapshot()).toEqual({ phase: 'blocked', error: status === 401 ? 'auth_required' : 'access_required', draft: '', messages: [] });
    await controller.refresh();
    await controller.send();
    await login();
    expect(request).toHaveBeenCalledTimes(2);
    await controller.signOut();
    await login();
    expect(controller.getSnapshot().phase).toBe('signed_in');
  }
});
it.each([200, 401, 403, 503, 'reject'] as const)('late %s history/send outcomes cannot overwrite another login', async outcome => {
  for (const operation of ['refresh', 'send'] as const) {
    const pending = deferred<Response>();
    const { controller, request, login } = setup();
    await login();
    controller.setDraft('old draft');
    request.mockReturnValueOnce(pending.promise);
    const running = controller[operation]();
    await settle();
    const staleRequest = request.mock.calls[1][0];
    await controller.signOut();
    expect(staleRequest.signal.aborted).toBe(true);
    await login();
    controller.setDraft('fresh draft');
    const fresh = controller.getSnapshot();
    if (outcome === 'reject') pending.reject(new Error('late private error'));
    else pending.resolve(outcome === 200 ? (operation === 'send' ? ack('old draft') : page()) : envelope({}, outcome));
    await running;
    expect(controller.getSnapshot()).toBe(fresh);
    expect(request).toHaveBeenCalledTimes(3);
  }
});
it.each([['', 'empty_text'], [' \n\t', 'empty_text'], ['bad\u0000text', 'invalid_text'],
  ['\uD800', 'invalid_text'], ['x'.repeat(8001), 'text_too_long']])('rejects invalid draft %# before POST', async (draft, error) => {
  const { controller, request, login } = setup();
  await login();
  controller.setDraft(draft);
  await controller.send();
  expect(controller.getSnapshot()).toMatchObject({ phase: 'signed_in', currentUserId: uuid(1), error, draft });
  expect(request).toHaveBeenCalledTimes(1);
});
it('rejects an invalid command id and recovers from a command generator exception', async () => {
  const { controller, request, commandId, login } = setup();
  await login();
  controller.setDraft('hello');
  commandId.mockReturnValueOnce('');
  await controller.send();
  expect(controller.getSnapshot().error).toBe('invalid_id');
  commandId.mockImplementationOnce(() => { throw new Error('private generator detail'); });
  await controller.send();
  expect(controller.getSnapshot().error).toBe('transport_error');
  expect(request).toHaveBeenCalledTimes(1);
});
it('normalizes submitted text, sends one command on repeat taps, and preserves a newer draft', async () => {
  const pending = deferred<Response>();
  const { controller, request, commandId, login } = setup();
  await login();
  controller.setDraft('cafe\u0301\r\nhello');
  request.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(page([{ ...message, body: 'café\nhello' }]));
  const sending = controller.send();
  await controller.send();
  await settle();
  expect(commandId).toHaveBeenCalledTimes(1);
  const input = request.mock.calls[1][0];
  expect(input.method).toBe('POST');
  expect(input.headers.get('cookie')).toBe('better-auth.session_token=synthetic-cookie');
  expect(input.headers.get('origin')).toBe(config.baseURL);
  expect(input.headers.has('authorization')).toBe(false);
  expect(input.headers.get('idempotency-key')).toBe(uuid(3));
  expect(await input.json()).toEqual({ membership_epoch: 1, client_message_id: uuid(3), body: 'café\nhello' });
  controller.setDraft('new draft while sending');
  pending.resolve(ack('café\nhello'));
  await sending;
  expect(controller.getSnapshot()).toMatchObject({ draft: 'new draft while sending', error: null, messages: [message], outgoing: { body: 'cafe\u0301\r\nhello', status: 'sent' } });
  expect(request).toHaveBeenCalledTimes(2);
});
it('clears an unchanged draft only after ACK and leaves history unchanged until explicit navigation', async () => {
  const { controller, request, login } = setup();
  await login();
  controller.setDraft('hello');
  request.mockResolvedValueOnce(ack('hello')).mockResolvedValueOnce(page([{ ...message, body: 'hello' }]));
  await controller.send();
  expect(controller.getSnapshot()).toEqual({ history: { status: 'ready', nextBeforeSeq: null, nextAfterSeq: null, boundedWindow: true, windowReset: true }, phase: 'signed_in', currentUserId: uuid(1), error: null, draft: '', messages: [message], outgoing: { body: 'hello', status: 'sent' } });
});
it.each([400, 429, 503, 'lost-ack'] as const)('retries %s using the same command and body without duplicating a committed message', async failure => {
  const { controller, request, commandId, login } = setup();
  await login();
  controller.setDraft('hello');
  if (failure === 'lost-ack') request.mockRejectedValueOnce(new Error('connection lost after commit'));
  else request.mockResolvedValueOnce(envelope({}, failure));
  await controller.send();
  expect(controller.getSnapshot().draft).toBe('hello');
  request.mockResolvedValueOnce(ack('hello')).mockResolvedValueOnce(page([{ ...message, body: 'hello' }]));
  await controller.send();
  expect(commandId).toHaveBeenCalledTimes(1);
  const first = request.mock.calls[1][0];
  const retried = request.mock.calls[2][0];
  expect(first.headers.get('idempotency-key')).toBe(retried.headers.get('idempotency-key'));
  expect(await first.json()).toEqual(await retried.json());
  expect(controller.getSnapshot()).toMatchObject({ phase: 'signed_in', currentUserId: uuid(1), draft: '', error: null });
});
it('resolves the original command before sending an edited draft with a fresh ID', async () => {
  const { controller, request, commandId, login } = setup();
  await login();
  controller.setDraft('old draft');
  request.mockResolvedValueOnce(envelope({}, 503));
  await controller.send();
  controller.setDraft('new draft');
  request.mockResolvedValueOnce(ack('old draft'));
  await controller.send();
  expect(commandId).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[2][0].headers.get('idempotency-key')).toBe(uuid(3));
  expect(controller.getSnapshot().draft).toBe('new draft');
  commandId.mockReturnValueOnce(uuid(33));
  request.mockResolvedValueOnce(envelope({ ok: true, value: { message: { ...message,
    id: uuid(44), seq: 2, body: 'new draft', clientId: uuid(33) }, replay: false } }));
  await controller.send();
  expect(commandId).toHaveBeenCalledTimes(2);
  expect(controller.getSnapshot().draft).toBe('');
});
it('remembers the original lost-ACK command after another failed draft and edit back', async () => {
  const { controller, request, commandId, login } = setup();
  await login();
  commandId.mockReturnValueOnce(uuid(3)).mockReturnValueOnce(uuid(33)).mockReturnValueOnce(uuid(44));
  controller.setDraft('draft A');
  request.mockRejectedValueOnce(new Error('connection lost after A committed'));
  await controller.send();
  controller.setDraft('draft B');
  request.mockResolvedValueOnce(envelope({}, 400));
  await controller.send();
  controller.setDraft('draft A');
  request.mockResolvedValueOnce(ack('draft A')).mockResolvedValueOnce(page([{ ...message, body: 'draft A' }]));
  await controller.send();
  const inputs = request.mock.calls.slice(1, 4).map(([input]) => input);
  expect(inputs.map(input => input.headers.get('idempotency-key'))).toEqual([uuid(3), uuid(3), uuid(3)]);
  const bodies = await Promise.all(inputs.map(input => input.json()));
  expect(bodies.map(body => body.body)).toEqual(['draft A', 'draft A', 'draft A']);
  expect(bodies[2]).toEqual(bodies[0]);
  expect(commandId).toHaveBeenCalledTimes(1);
  expect(controller.getSnapshot()).toMatchObject({ phase: 'signed_in', currentUserId: uuid(1), error: null, draft: 'draft A', messages: [message], outgoing: { body: 'draft A', status: 'sent' } });
});
it('an old send completion cannot release the new session sending lock', async () => {
  const old = deferred<Response>();
  const fresh = deferred<Response>();
  const { controller, request, commandId, login } = setup();
  await login();
  controller.setDraft('old draft');
  request.mockReturnValueOnce(old.promise);
  const oldSend = controller.send();
  await settle();
  await controller.signOut();
  await login();
  controller.setDraft('fresh draft');
  commandId.mockReturnValueOnce(uuid(33));
  request.mockReturnValueOnce(fresh.promise);
  const newSend = controller.send();
  await settle();
  old.resolve(ack('old draft'));
  await oldSend;
  await controller.send();
  expect(commandId).toHaveBeenCalledTimes(2);
  expect(request).toHaveBeenCalledTimes(4);
  fresh.resolve(ack('fresh draft', uuid(33)));
  await newSend;
  expect(controller.getSnapshot().draft).toBe('');
});
it.each([[400, 'rejected'], [429, 'rate_limited'], [503, 'transport_error']] as const)('retains the draft and history after send HTTP %s', async (status, error) => {
  const { controller, request, login } = setup();
  await login();
  controller.setDraft('hello');
  request.mockResolvedValueOnce(envelope({ private: 'server detail' }, status));
  await controller.send();
  expect(controller.getSnapshot()).toEqual({ history: { status: 'ready', nextBeforeSeq: null, nextAfterSeq: null, boundedWindow: true, windowReset: true }, phase: 'signed_in', currentUserId: uuid(1), error, draft: 'hello', messages: [message], outgoingPending: true, outgoing: { body: 'hello', status: 'retry' } });
  expect(request).toHaveBeenCalledTimes(2);
});
it('reports invalid history responses without replacing the last verified history', async () => {
  const { controller, request, login } = setup();
  await login();
  request.mockResolvedValueOnce(page([messageB]));
  await controller.refresh();
  expect(controller.getSnapshot()).toMatchObject({ error: 'invalid_response', messages: [message] });
});
it.each(['old-page', 'old-error', 'old-cookie-error'] as const)('does not let %s replace a newer refresh in the same session', async outcome => {
  const pending = deferred<Response>();
  const cookie = deferred<string>();
  const { controller, client, request, login } = setup();
  await login();
  if (outcome === 'old-cookie-error') client.getCookie.mockReturnValueOnce(cookie.promise);
  else request.mockReturnValueOnce(pending.promise);
  const old = controller.refresh();
  await settle();
  const newer = { ...message, id: uuid(98), clientId: uuid(99), seq: 2, body: 'Newer verified history' };
  request.mockResolvedValueOnce(page([newer]));
  await controller.refresh();
  const fresh = controller.getSnapshot();
  if (outcome === 'old-cookie-error') cookie.reject(new Error('late cookie failure'));
  else pending.resolve(outcome === 'old-page' ? page() : envelope({}, 503));
  await old;
  expect(controller.getSnapshot()).toBe(fresh);
  expect(controller.getSnapshot()).toMatchObject({ messages: [newer], error: null });
});
it.each([401, 403])('still honors a late same-session %s denial rather than leaving a paused queue looking active', async status => {
  const pending = deferred<Response>();
  const { controller, request, login } = setup();
  await login();
  request.mockReturnValueOnce(pending.promise);
  const old = controller.refresh();
  await settle();
  await controller.refresh();
  pending.resolve(envelope({ ok: false, error: 'unavailable', readId: new URL(request.mock.calls[1][0].url).searchParams.get('read_id') }, status));
  await old;
  expect(controller.getSnapshot()).toEqual({ phase: 'blocked', error: status === 401 ? 'auth_required' : 'access_required', draft: '', messages: [] });
});
it('aborts timed-out requests, reports the opaque failure, and removes timers', async () => {
  jest.useFakeTimers();
  const { controller, request, login } = setup();
  await login();
  expect(jest.getTimerCount()).toBe(0);
  request.mockImplementationOnce(input => new Promise((_resolve, reject) => {
    input.signal.addEventListener('abort', () => reject(new Error('synthetic abort')), { once: true });
  }));
  const refreshing = controller.refresh();
  await settle();
  expect(jest.getTimerCount()).toBe(1);
  await jest.advanceTimersByTimeAsync(10000);
  await refreshing;
  expect(controller.getSnapshot()).toMatchObject({ phase: 'signed_in', currentUserId: uuid(1), error: 'transport_error' });
  expect(jest.getTimerCount()).toBe(0);
});

function cookieTransport(cookieOrigin: string | undefined = config.baseURL) {
  const scope = { userId: uuid(1), coupleId: uuid(2), membershipEpoch: 1, sessionId: 'session-a' };
  let state: QueueState = createQueue(scope);
  const request = jest.fn(async () => page());
  const transport = createChatTransport({ baseUrl: config.baseURL, allowHttpLoopbackForTests: true,
    cookieOrigin, getCredentialGeneration: () => 1, request,
    store: { get: () => state, set(next) { state = next; } },
  });
  const session: TransportSession = { scope, token: 'better-auth.session_token=fixture', credentialGeneration: 1, credentialKind: 'cookie' };
  return { transport, session, request };
}
it.each(['', 'cookie\r\nInjected: value', 'cookie\u0000value', 'cookie\u007fvalue', 'x'.repeat(16385)])('rejects invalid cookie material %# before making a request', async token => {
  const { transport, session, request } = cookieTransport();
  expect(await transport.history({ ...session, token }, { limit: 1 })).toEqual({ ok: false, error: 'invalid_token' });
  expect(request).not.toHaveBeenCalled();
});
it('permits the documented cookie-size boundary and multiple official cookie pairs', async () => {
  const { transport, session, request } = cookieTransport();
  for (const token of ['a=b; c=d', `a=${'x'.repeat(16382)}`]) {
    expect((await transport.history({ ...session, token }, { limit: 1 })).ok).toBe(true);
  }
  expect(request).toHaveBeenCalledTimes(2);
});
it.each(['', 'http://localhost\r\nHeader: value'])('rejects invalid configured cookie origin %j', cookieOrigin => {
  expect(() => cookieTransport(cookieOrigin)).toThrow('invalid_cookie_origin');
});
it('requires an explicit origin for cookie mode and refuses non-loopback HTTP', async () => {
  const { session } = cookieTransport();
  const request = jest.fn(async () => page());
  const options = { store: { get: () => createQueue(session.scope), set: jest.fn() }, request, getCredentialGeneration: () => 1 };
  const transport = createChatTransport({ ...options, baseUrl: 'https://example.invalid' });
  expect(await transport.history(session, { limit: 1 })).toEqual({ ok: false, error: 'invalid_token' });
  expect(request).not.toHaveBeenCalled();
  expect(() => createChatTransport({ ...options, baseUrl: 'http://example.invalid', allowHttpLoopbackForTests: true })).toThrow('invalid_base_url');
  expect(() => createChatTransport({ ...options, baseUrl: config.baseURL })).toThrow('invalid_base_url');
});
