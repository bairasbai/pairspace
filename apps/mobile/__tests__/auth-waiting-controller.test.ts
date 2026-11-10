import { createSessionController } from '../src/auth/controller';
import type { SyntheticConfig } from '../src/auth/config';
import type { AuthIdentity } from '../src/auth/official-client';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const config: SyntheticConfig = { mode: 'synthetic-loopback', baseURL: 'http://127.0.0.1:8787' };
const identity: AuthIdentity = { userId: 'provider-account-a', sessionId: 'verified-session-a' };
const unmapped = { state: 'unmapped', sessionId: identity.sessionId };
const noPair = { state: 'no_active_pair', sessionId: identity.sessionId, userId: uuid(1) };
const waiting = { ...noPair, state: 'waiting_partner', coupleId: uuid(2), membershipEpoch: 1 };
const ready = { ...waiting, state: 'ready' };
const cookie = 'better-auth.session_token=synthetic-a';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const contextResponse = (value: unknown) => json({ ok: true, value });
const ackValue = { sessionId: identity.sessionId, userId: uuid(1), coupleId: uuid(2), membershipEpoch: 1, created: true };
const ack = (patch: Record<string, unknown> = {}, status = 201) => json({ ok: true, value: { ...ackValue, ...patch } }, status);
const blocked = (error: string) => ({ phase: 'blocked', error, draft: '', messages: [] });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function streamed() {
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { body = controller; } }));
  return { response,
    finish(value: unknown) { body.enqueue(new TextEncoder().encode(JSON.stringify(value))); body.close(); },
    fail() { body.error(new Error('synthetic body failure')); },
  };
}
async function settle() { for (let i = 0; i < 60; i++) await Promise.resolve(); }
function setup(initialContext: unknown = noPair, inputConfig = config) {
  let context = initialContext;
  const client = {
    signIn: jest.fn<Promise<AuthIdentity | null>, [string, string]>().mockResolvedValue(identity),
    signOut: jest.fn<Promise<boolean>, []>().mockResolvedValue(true),
    getCookie: jest.fn<Promise<string>, []>().mockResolvedValue(cookie),
  };
  const discovery = jest.fn(async (_input: Request) => contextResponse(context));
  const create = jest.fn(async (_input: Request) => ack());
  const profile = jest.fn(async (_input: Request) => json({ ok: true, value: {
    sessionId: identity.sessionId, userId: uuid(1), created: true,
  } }));
  const chat = jest.fn(async (_input: Request) => json({ ok: true, value: { messages: [], nextBeforeSeq: null } }));
  const request = jest.fn((input: Request) => {
    switch (new URL(input.url).pathname) {
      case '/v1/session/context': return discovery(input);
      case '/v1/spaces/waiting': return create(input);
      case '/v1/profile': return profile(input);
      default: return chat(input);
    }
  });
  const commandId = jest.fn(() => uuid(3));
  const controller = createSessionController(inputConfig, client, request, commandId);
  return { controller, client, discovery, create, profile, chat, request, commandId,
    login: () => controller.signIn('fixture@example.test', 'synthetic-password'),
    setContext(next: unknown) { context = next; },
    commit(next: unknown = waiting, response = ack()) {
      create.mockImplementationOnce(async () => { context = next; return response; });
    },
  };
}
type Fixture = ReturnType<typeof setup>;
const stages = ['cookie', 'preflight', 'preflight-body', 'post', 'body', 'rediscovery', 'rediscovery-body'] as const;
type Stage = typeof stages[number];
function hold(f: Fixture, stage: Stage) {
  const pendingCookie = deferred<string>();
  const pendingResponse = deferred<Response>();
  const stream = stage.endsWith('body') ? streamed() : null;
  if (stage === 'cookie') f.client.getCookie.mockReturnValueOnce(pendingCookie.promise);
  else if (stage === 'preflight') f.discovery.mockReturnValueOnce(pendingResponse.promise);
  else if (stage === 'preflight-body') f.discovery.mockResolvedValueOnce(stream!.response);
  else if (stage === 'post') f.create.mockReturnValueOnce(pendingResponse.promise);
  else if (stage === 'body') f.create.mockResolvedValueOnce(stream!.response);
  else {
    f.discovery.mockResolvedValueOnce(contextResponse(noPair));
    f.discovery.mockReturnValueOnce(stage === 'rediscovery' ? pendingResponse.promise : Promise.resolve(stream!.response));
  }
  return (outcome: 'success' | 'failure' | 'denial' = 'success') => {
    if (stage === 'cookie') {
      if (outcome === 'failure') pendingCookie.reject(new Error('old cookie failure'));
      else pendingCookie.resolve(cookie);
    } else if (stream) {
      if (outcome === 'failure') stream.fail();
      else stream.finish(outcome === 'denial' ? {} : {
        ok: true, value: stage === 'body' ? ackValue : stage === 'preflight-body' ? noPair : waiting,
      });
    } else if (outcome === 'failure') pendingResponse.reject(new Error('old network failure'));
    else pendingResponse.resolve(outcome === 'denial' ? json({}, 401)
      : stage === 'post' ? ack() : contextResponse(stage === 'preflight' ? noPair : waiting));
  };
}
afterEach(() => jest.useRealTimers());

it('never creates a waiting space implicitly on login, refresh, draft editing, send, or profile action', async () => {
  const f = setup();
  await f.login();
  expect(f.controller.getSnapshot()).toEqual(blocked('context_no_active_pair'));
  f.controller.setDraft('must not send');
  await f.controller.send();
  await f.controller.refresh();
  await f.controller.createProfile();
  expect(f.discovery).toHaveBeenCalledTimes(2);
  expect(f.create).not.toHaveBeenCalled();
  expect(f.profile).not.toHaveBeenCalled();
  expect(f.chat).not.toHaveBeenCalled();
  expect(f.commandId).not.toHaveBeenCalled();
  expect(f.controller.getSnapshot().draft).toBe('');
});
it('ignores creation before login and while verified authentication is still pending', async () => {
  const f = setup();
  const pending = deferred<AuthIdentity | null>();
  await f.controller.createWaitingSpace();
  f.client.signIn.mockReturnValueOnce(pending.promise);
  const loggingIn = f.login();
  await settle();
  await f.controller.createWaitingSpace();
  expect(f.create).not.toHaveBeenCalled();
  pending.resolve(identity);
  await loggingIn;
  expect(f.create).not.toHaveBeenCalled();
});
it.each([unmapped, waiting, ready, null, { ...noPair, sessionId: 'foreign-session' }])(
  'ignores explicit creation outside an eligible no-pair or retry state %p', async context => {
    const f = setup(context);
    await f.login();
    const before = f.controller.getSnapshot();
    await f.controller.createWaitingSpace();
    expect(f.controller.getSnapshot()).toBe(before);
    expect(f.create).not.toHaveBeenCalled();
  },
);
it.each([[true, 201], [false, 200], [true, 200], [false, 201]] as const)(
  'explicit creation uses an empty body and verified cookie, created=%s HTTP%s', async (created, status) => {
    const f = setup();
    await f.login();
    f.commit(waiting, ack({ created }, status));
    const creating = f.controller.createWaitingSpace();
    expect(f.controller.getSnapshot()).toEqual({ phase: 'busy', error: null, draft: '', messages: [] });
    await creating;
    expect(f.create).toHaveBeenCalledTimes(1);
    const input = f.create.mock.calls[0][0];
    expect(input.url).toBe(`${config.baseURL}/v1/spaces/waiting`);
    expect(input.method).toBe('POST');
    expect(input.headers.get('content-type')).toBe('application/json');
    expect(input.headers.get('cookie')).toBe(cookie);
    expect(input.headers.get('origin')).toBe(config.baseURL);
    expect(input.headers.has('authorization')).toBe(false);
    expect(input.credentials).toBe('omit');
    expect(input.redirect).toBe('error');
    expect(input.cache).toBe('no-store');
    expect(await input.json()).toEqual({});
    expect(f.discovery).toHaveBeenCalledTimes(3);
    expect(f.discovery.mock.invocationCallOrder[1]).toBeLessThan(f.create.mock.invocationCallOrder[0]);
    expect(f.create.mock.invocationCallOrder[0]).toBeLessThan(f.discovery.mock.invocationCallOrder[2]);
    expect(f.controller.getSnapshot()).toEqual(blocked('context_waiting_partner'));
    expect(f.chat).not.toHaveBeenCalled();
    expect(f.client.signIn).toHaveBeenCalledTimes(1);
  },
);
it.each([unmapped, noPair, waiting, ready])('uses authoritative rediscovery rather than ACK claims: %p', async context => {
  const f = setup();
  await f.login();
  f.commit(context, ack({ userId: uuid(91), coupleId: uuid(92), membershipEpoch: 9 }));
  await f.controller.createWaitingSpace();
  expect(f.controller.getSnapshot()).toEqual(context.state === 'ready'
    ? { phase: 'signed_in', error: null, draft: '', messages: [] } : blocked(`context_${context.state}`));
  expect(f.chat).toHaveBeenCalledTimes(context.state === 'ready' ? 1 : 0);
  if (context.state === 'ready') expect(f.chat.mock.calls[0][0].url).toContain(`/couples/${ready.coupleId}/`);
});
it.each(stages)('coalesces repeated creation taps and other entry actions while awaiting %s', async stage => {
  const f = setup();
  await f.login();
  const release = hold(f, stage);
  const first = f.controller.createWaitingSpace();
  await settle();
  expect(f.controller.getSnapshot().phase).toBe('busy');
  await f.controller.createWaitingSpace();
  await f.controller.createWaitingSpace();
  await f.controller.createProfile();
  await f.login();
  f.controller.setDraft('ignored busy draft');
  await f.controller.send();
  expect(f.create).toHaveBeenCalledTimes(['cookie', 'preflight', 'preflight-body'].includes(stage) ? 0 : 1);
  if (['cookie', 'preflight', 'preflight-body'].includes(stage)) f.commit();
  else f.setContext(waiting);
  release();
  await first;
  expect(f.create).toHaveBeenCalledTimes(1);
  expect(f.client.signIn).toHaveBeenCalledTimes(1);
  expect(f.profile).not.toHaveBeenCalled();
  expect(f.chat).not.toHaveBeenCalled();
  expect(f.controller.getSnapshot()).toEqual(blocked('context_waiting_partner'));
});
it.each([500, 503, 'network', 'malformed', 'cookie'] as const)(
  'allows manual idempotent retry after %s without automatic POST replay', async failure => {
    const f = setup();
    await f.login();
    if (failure === 'cookie') f.client.getCookie.mockRejectedValueOnce(new Error('private cookie detail'));
    else if (failure === 'network') f.create.mockRejectedValueOnce(new Error('response lost'));
    else f.create.mockResolvedValueOnce(failure === 'malformed' ? new Response('private invalid JSON') : json({}, failure));
    await f.controller.createWaitingSpace();
    expect(f.controller.getSnapshot()).toEqual(blocked('waiting_retry_required'));
    expect(f.create).toHaveBeenCalledTimes(failure === 'cookie' ? 0 : 1);
    f.client.getCookie.mockResolvedValue('better-auth.session_token=refreshed-a');
    f.commit(waiting, ack({ created: false }, 200));
    await f.controller.createWaitingSpace();
    expect(f.create).toHaveBeenCalledTimes(failure === 'cookie' ? 1 : 2);
    expect(f.create.mock.calls.at(-1)![0].headers.get('cookie')).toBe('better-auth.session_token=refreshed-a');
    for (const [input] of f.create.mock.calls) expect(await input.json()).toEqual({});
    expect(f.controller.getSnapshot()).toEqual(blocked('context_waiting_partner'));
  },
);
it('recovers a committed waiting space after a lost ACK using preflight without a second POST', async () => {
  const f = setup();
  await f.login();
  f.create.mockImplementationOnce(async () => { f.setContext(waiting); throw new Error('reply lost after commit'); });
  await f.controller.createWaitingSpace();
  expect(f.controller.getSnapshot()).toEqual(blocked('waiting_retry_required'));
  await f.controller.createWaitingSpace();
  expect(f.create).toHaveBeenCalledTimes(1);
  expect(f.controller.getSnapshot()).toEqual(blocked('context_waiting_partner'));
  expect(f.chat).not.toHaveBeenCalled();
});
it.each([400, 401, 403, 404, 409])('HTTP %s clears retained identity and blocks subsequent creation/refresh', async status => {
  const f = setup();
  await f.login();
  f.create.mockResolvedValueOnce(json({ private: 'hidden response detail' }, status));
  await f.controller.createWaitingSpace();
  const error = status === 401 ? 'auth_required' : status === 403 ? 'access_required' : 'waiting_unavailable';
  expect(f.controller.getSnapshot()).toEqual(blocked(error));
  const count = f.discovery.mock.calls.length;
  await f.controller.createWaitingSpace();
  await f.controller.createProfile();
  await f.controller.refresh();
  expect(f.create).toHaveBeenCalledTimes(1);
  expect(f.discovery).toHaveBeenCalledTimes(count);
  expect(f.profile).not.toHaveBeenCalled();
});
it.each([waiting, ready, unmapped])('preflight %p skips POST and retains the appropriate next action', async context => {
  const f = setup();
  await f.login();
  f.setContext(context);
  await f.controller.createWaitingSpace();
  expect(f.create).not.toHaveBeenCalled();
  expect(f.controller.getSnapshot()).toEqual(context.state === 'ready'
    ? { phase: 'signed_in', error: null, draft: '', messages: [] } : blocked(`context_${context.state}`));
  if (context.state === 'unmapped') {
    f.profile.mockImplementationOnce(async () => { f.setContext(noPair); return json({ ok: true, value: ackValue }); });
    await f.controller.createProfile();
    expect(f.profile).toHaveBeenCalledTimes(1);
    expect(f.controller.getSnapshot()).toEqual(blocked('context_no_active_pair'));
  }
});
it.each([401, 403, 'foreign-session', 'invalid-context'] as const)('preflight %s cannot start a POST', async failure => {
  const f = setup();
  await f.login();
  f.client.getCookie.mockResolvedValue('better-auth.session_token=replaced-account');
  f.discovery.mockResolvedValueOnce(typeof failure === 'number' ? json({}, failure)
    : contextResponse(failure === 'foreign-session' ? { ...noPair, sessionId: 'verified-session-b' } : null));
  await f.controller.createWaitingSpace();
  expect(f.controller.getSnapshot()).toEqual(blocked(failure === 403 ? 'access_required' : 'auth_required'));
  const count = f.discovery.mock.calls.length;
  await f.controller.createWaitingSpace();
  await f.controller.refresh();
  expect(f.discovery).toHaveBeenCalledTimes(count);
  expect(f.create).not.toHaveBeenCalled();
});
it.each([noPair, waiting, ready])('refuses a changed domain account under the same provider session: %p', async context => {
  const f = setup();
  await f.login();
  f.setContext({ ...context, userId: uuid(11) });
  await f.controller.createWaitingSpace();
  expect(f.create).not.toHaveBeenCalled();
  expect(f.controller.getSnapshot()).toEqual(blocked('auth_required'));
});
it('retains the original domain-user binding through a retryable failure', async () => {
  const f = setup();
  await f.login();
  f.create.mockResolvedValueOnce(json({}, 503));
  await f.controller.createWaitingSpace();
  expect(f.controller.getSnapshot()).toEqual(blocked('waiting_retry_required'));
  f.setContext({ ...noPair, userId: uuid(11) });
  await f.controller.createWaitingSpace();
  expect(f.create).toHaveBeenCalledTimes(1);
  expect(f.controller.getSnapshot()).toEqual(blocked('auth_required'));
});
it.each([401, 403, 503, 'malformed', 'network'] as const)(
  'never treats a successful write ACK as authority after rediscovery %s', async failure => {
    const f = setup();
    await f.login();
    f.discovery.mockResolvedValueOnce(contextResponse(noPair));
    if (failure === 'network') f.discovery.mockRejectedValueOnce(new Error('rediscovery failed'));
    else f.discovery.mockResolvedValueOnce(failure === 'malformed' ? contextResponse(null) : json({}, failure));
    await f.controller.createWaitingSpace();
    const error = failure === 401 ? 'auth_required' : failure === 403 ? 'access_required'
      : failure === 'malformed' ? 'invalid_context' : 'transport_error';
    expect(f.controller.getSnapshot()).toEqual(blocked(error));
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.chat).not.toHaveBeenCalled();
    await f.controller.createWaitingSpace();
    expect(f.create).toHaveBeenCalledTimes(1);
  },
);
it.each([503, 'network'] as const)('preflight failure %s is explicitly retryable without an initial write', async failure => {
  const f = setup();
  await f.login();
  if (failure === 'network') f.discovery.mockRejectedValueOnce(new Error('private network detail'));
  else f.discovery.mockResolvedValueOnce(json({}, failure));
  await f.controller.createWaitingSpace();
  expect(f.controller.getSnapshot()).toEqual(blocked('waiting_retry_required'));
  expect(f.create).not.toHaveBeenCalled();
  f.commit();
  await f.controller.createWaitingSpace();
  expect(f.create).toHaveBeenCalledTimes(1);
  expect(f.controller.getSnapshot()).toEqual(blocked('context_waiting_partner'));
});
it('binds POST to the exact preflight cookie even when official storage rotates before its result', async () => {
  const f = setup();
  await f.login();
  const pending = deferred<Response>();
  f.discovery.mockReturnValueOnce(pending.promise);
  const creating = f.controller.createWaitingSpace();
  await settle();
  const preflight = f.discovery.mock.calls.at(-1)![0];
  f.client.getCookie.mockResolvedValue('better-auth.session_token=rotated-a');
  f.commit();
  pending.resolve(contextResponse(noPair));
  await creating;
  expect(f.create.mock.calls[0][0].headers.get('cookie')).toBe(preflight.headers.get('cookie'));
  expect(f.create.mock.calls[0][0].headers.get('cookie')).toBe(cookie);
  expect(f.discovery.mock.calls.at(-1)![0].headers.get('cookie')).toBe('better-auth.session_token=rotated-a');
});
it.each(['', 'a=b\r\nInjected: value', 'a=b\u0000', 'a=b\u007f', 'x'.repeat(8193)])(
  'rejects invalid official cookie %# before preflight or mutation', async invalid => {
    const f = setup();
    await f.login();
    f.client.getCookie.mockResolvedValueOnce(invalid);
    await f.controller.createWaitingSpace();
    expect(f.controller.getSnapshot()).toEqual(blocked('auth_required'));
    expect(f.discovery).toHaveBeenCalledTimes(1);
    expect(f.create).not.toHaveBeenCalled();
  },
);
it.each(stages)('logout at %s supersedes every late outcome without delaying account replacement', async stage => {
  for (const outcome of ['success', 'failure', 'denial'] as const) {
    const f = setup();
    await f.login();
    const release = hold(f, stage);
    const creating = f.controller.createWaitingSpace();
    await settle();
    const oldRequest = f.request.mock.calls.at(-1)![0];
    await f.controller.signOut();
    expect(f.controller.getSnapshot()).toEqual({ phase: 'signed_out', error: null, draft: '', messages: [] });
    expect(f.client.signOut).toHaveBeenCalledTimes(2);
    if (['preflight', 'post', 'rediscovery'].includes(stage)) expect(oldRequest.signal.aborted).toBe(true);
    f.client.signIn.mockResolvedValueOnce({ userId: 'provider-account-b', sessionId: 'verified-session-b' });
    f.setContext({ ...ready, sessionId: 'verified-session-b', userId: uuid(11), coupleId: uuid(12) });
    await f.login();
    f.controller.setDraft('new account private draft');
    const fresh = f.controller.getSnapshot();
    const requests = f.request.mock.calls.length;
    release(outcome);
    await creating;
    expect(f.controller.getSnapshot()).toBe(fresh);
    expect(f.request).toHaveBeenCalledTimes(requests);
    expect(f.create).toHaveBeenCalledTimes(['cookie', 'preflight', 'preflight-body'].includes(stage) ? 0 : 1);
  }
});
it('an old creation result cannot release the busy guard on a newer account creation', async () => {
  const f = setup();
  await f.login();
  const old = deferred<Response>();
  f.create.mockReturnValueOnce(old.promise);
  const first = f.controller.createWaitingSpace();
  await settle();
  await f.controller.signOut();
  f.client.signIn.mockResolvedValueOnce({ userId: 'provider-account-b', sessionId: 'verified-session-b' });
  f.setContext({ ...noPair, sessionId: 'verified-session-b', userId: uuid(11) });
  await f.login();
  const next = deferred<Response>();
  f.create.mockReturnValueOnce(next.promise);
  const second = f.controller.createWaitingSpace();
  await settle();
  old.resolve(ack());
  await first;
  expect(f.controller.getSnapshot().phase).toBe('busy');
  await f.controller.createWaitingSpace();
  expect(f.create).toHaveBeenCalledTimes(2);
  f.setContext({ ...waiting, sessionId: 'verified-session-b', userId: uuid(11), coupleId: uuid(12) });
  next.resolve(ack({ sessionId: 'verified-session-b', userId: uuid(11), coupleId: uuid(12) }));
  await second;
  expect(f.controller.getSnapshot()).toEqual(blocked('context_waiting_partner'));
});
it('a newer authoritative refresh cancels an in-flight creation result without claiming rollback', async () => {
  const f = setup();
  await f.login();
  const pending = deferred<Response>();
  f.create.mockReturnValueOnce(pending.promise);
  const creating = f.controller.createWaitingSpace();
  await settle();
  const input = f.create.mock.calls[0][0];
  f.setContext(waiting);
  await f.controller.refresh();
  expect(input.signal.aborted).toBe(true);
  const fresh = f.controller.getSnapshot();
  pending.resolve(ack());
  await creating;
  expect(f.controller.getSnapshot()).toBe(fresh);
  expect(f.controller.getSnapshot()).toEqual(blocked('context_waiting_partner'));
  expect(f.create).toHaveBeenCalledTimes(1);
});
it.each(['post', 'body'] as const)('bounded %s timeout remains retryable and does not imply server rollback', async stage => {
  jest.useFakeTimers();
  const f = setup();
  await f.login();
  if (stage === 'post') f.create.mockImplementationOnce(input => new Promise((_resolve, reject) => {
    input.signal.addEventListener('abort', () => reject(new Error('synthetic timeout')), { once: true });
  }));
  else f.create.mockResolvedValueOnce(streamed().response);
  const creating = f.controller.createWaitingSpace();
  await settle();
  expect(jest.getTimerCount()).toBe(1);
  await jest.advanceTimersByTimeAsync(10000);
  await creating;
  expect(f.controller.getSnapshot()).toEqual(blocked('waiting_retry_required'));
  expect(jest.getTimerCount()).toBe(0);
  f.setContext(waiting);
  await f.controller.createWaitingSpace();
  expect(f.create).toHaveBeenCalledTimes(1);
  expect(f.controller.getSnapshot()).toEqual(blocked('context_waiting_partner'));
});
it('never grants chat access for waiting membership, but can rediscover an independently active pair', async () => {
  const f = setup(waiting);
  await f.login();
  expect(f.controller.getSnapshot()).toEqual(blocked('context_waiting_partner'));
  f.controller.setDraft('no waiting chat');
  await f.controller.send();
  await f.controller.createWaitingSpace();
  await f.controller.createProfile();
  await f.controller.refresh();
  expect(f.chat).not.toHaveBeenCalled();
  expect(f.commandId).not.toHaveBeenCalled();
  expect(f.create).not.toHaveBeenCalled();
  expect(f.profile).not.toHaveBeenCalled();
  f.setContext(ready);
  await f.controller.refresh();
  expect(f.controller.getSnapshot()).toEqual({ phase: 'signed_in', error: null, draft: '', messages: [] });
  expect(f.chat).toHaveBeenCalledTimes(1);
  expect(f.chat.mock.calls[0][0].method).toBe('GET');
});
it.each(['refresh', 'send'] as const)('a ready-to-waiting transition during %s clears old draft and prevents chat', async operation => {
  const f = setup(ready);
  await f.login();
  f.controller.setDraft('old active-pair private draft');
  f.setContext(waiting);
  await f.controller[operation]();
  expect(f.controller.getSnapshot()).toEqual(blocked('context_waiting_partner'));
  expect(f.chat).toHaveBeenCalledTimes(1);
  expect(f.commandId).not.toHaveBeenCalled();
});
it('keeps waiting mutation on the construction origin after caller-owned config changes', async () => {
  const mutable = { mode: 'synthetic-loopback' as const, baseURL: 'http://127.0.0.1:8899' };
  const f = setup(noPair, mutable);
  await f.login();
  mutable.baseURL = 'http://untrusted.example.invalid';
  f.commit();
  await f.controller.createWaitingSpace();
  for (const [input] of f.request.mock.calls) {
    expect(new URL(input.url).origin).toBe('http://127.0.0.1:8899');
    expect(input.headers.get('origin')).toBe('http://127.0.0.1:8899');
  }
  expect(f.controller.getSnapshot()).toEqual(blocked('context_waiting_partner'));
});
