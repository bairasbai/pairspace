import { setup, owner, recipient, ready, uuid, token, otherToken, metadata, cookie, envelope, errorResponse,
  issued, accepted, previewed, deferred, settle } from './invitation-fixtures';
import type { SessionContext } from '../src/auth/context';
type Operation = 'read' | 'issue' | 'revoke' | 'preview' | 'accept';
const operations: Operation[] = ['read', 'issue', 'revoke', 'preview', 'accept'];
async function prepare(operation: Operation) {
  const fixture = setup(operation === 'preview' || operation === 'accept' ? recipient : owner);
  await fixture.login();
  if (operation === 'revoke') await fixture.api.readMetadata();
  if (operation === 'preview') fixture.api.setToken(token);
  if (operation === 'accept') await fixture.consent();
  fixture.request.mockClear(); fixture.discovery.mockClear(); fixture.client.getCookie.mockClear();
  const action = { read: fixture.api.readMetadata, issue: fixture.api.issue, revoke: fixture.api.revoke,
    preview: fixture.api.preview, accept: fixture.api.accept }[operation];
  const response = () => operation === 'read' ? envelope({ state: 'current', invitation: metadata })
    : operation === 'issue' ? issued() : operation === 'revoke' ? envelope({ state: 'revoked', revoked: true })
      : operation === 'preview' ? previewed() : accepted();
  return { ...fixture, action, response };
}
const boundaries = ['cookie', 'binding', 'cookie_recheck', 'response', 'response_cookie'] as const;
const races = operations.flatMap(operation => boundaries.map(boundary => [operation, boundary] as const));
it.each(races)('%s logout at %s suppresses late state and keeps no token, consent, metadata or queue', async (operation, boundary) => {
  const f = await prepare(operation); const heldCookie = deferred<string>(); const heldResponse = deferred<Response>();
  let cookieCalls = 0;
  if (boundary.includes('cookie')) f.client.getCookie.mockImplementation(async () => {
    cookieCalls++;
    if (cookieCalls === ({ cookie: 1, cookie_recheck: 2, response_cookie: 3 } as Record<string, number>)[boundary]) return heldCookie.promise;
    return cookie;
  });
  if (boundary === 'binding') f.discovery.mockReturnValueOnce(heldResponse.promise);
  if (boundary === 'response') f.request.mockReturnValueOnce(heldResponse.promise);
  const pending = f.action(); await settle();
  expect(f.api.getSnapshot().busy).toBe(operation);
  const lastRequest = f.request.mock.calls.at(-1)?.[0];
  await f.controller.signOut();
  if (boundary === 'response') expect(lastRequest?.signal.aborted).toBe(true);
  heldCookie.resolve(cookie); heldResponse.resolve(boundary === 'binding' ? envelope(operation === 'preview' || operation === 'accept' ? recipient : owner) : f.response());
  await pending;
  expect(f.controller.getSnapshot()).toEqual({ phase: 'signed_out', error: null, draft: '', messages: [] });
  expect(f.api.getSnapshot()).toMatchObject({ mode: 'unavailable', busy: null, invitation: null, issuedToken: null,
    tokenInput: '', preview: null, consent: false, recovery: 'none' });
  if (!['response', 'response_cookie'].includes(boundary)) expect(f.request).not.toHaveBeenCalled();
});
it.each(races)('%s cancel at %s suppresses late callbacks and aborts in-flight Request', async (operation, boundary) => {
  const f = await prepare(operation); const heldCookie = deferred<string>(); const heldResponse = deferred<Response>();
  let cookieCalls = 0;
  if (boundary.includes('cookie')) f.client.getCookie.mockImplementation(async () => {
    cookieCalls++;
    if (cookieCalls === ({ cookie: 1, cookie_recheck: 2, response_cookie: 3 } as Record<string, number>)[boundary]) return heldCookie.promise;
    return cookie;
  });
  if (boundary === 'binding') f.discovery.mockReturnValueOnce(heldResponse.promise);
  if (boundary === 'response') f.request.mockReturnValueOnce(heldResponse.promise);
  const pending = f.action(); await settle();
  const lastRequest = f.request.mock.calls.at(-1)?.[0]; f.api.cancel();
  const cancelled = f.api.getSnapshot();
  if (boundary === 'response') expect(lastRequest?.signal.aborted).toBe(true);
  heldCookie.resolve(cookie); heldResponse.resolve(boundary === 'binding' ? envelope(operation === 'preview' || operation === 'accept' ? recipient : owner) : f.response());
  await pending; expect(f.api.getSnapshot()).toEqual(cancelled);
  expect(f.api.getSnapshot()).toMatchObject({ busy: null, issuedToken: null, tokenInput: '', preview: null, consent: false });
  if (!['response', 'response_cookie'].includes(boundary)) expect(f.request).not.toHaveBeenCalled();
});
it.each(operations.flatMap(operation => [2, 3].map(boundary => [operation, boundary] as const)))('%s changing official cookie at read %s blocks and clears state', async (operation, boundary) => {
  const f = await prepare(operation); let calls = 0;
  f.client.getCookie.mockImplementation(async () => ++calls === boundary ? 'better-auth.session_token=other' : cookie);
  await f.action(); expect(f.controller.getSnapshot()).toMatchObject({ phase: 'blocked', error: 'auth_required' });
  expect(f.api.getSnapshot()).toMatchObject({ mode: 'unavailable', issuedToken: null, tokenInput: '', consent: false });
  expect(f.request).toHaveBeenCalledTimes(boundary === 2 ? 0 : 1);
});
it.each(operations.flatMap(operation => ['session', 'domain', 'unmapped'].map(change => [operation, change] as const)))('%s changed %s binding cannot mutate', async (operation, change) => {
  const f = await prepare(operation); const context = operation === 'preview' || operation === 'accept' ? recipient : owner;
  f.discovery.mockImplementation(async () => envelope(change === 'unmapped' ? { state: 'unmapped', sessionId: 'session' }
    : { ...context, ...(change === 'session' ? { sessionId: 'other-session' } : { userId: uuid(99) }) }));
  await f.action(); expect(f.request).not.toHaveBeenCalled();
  expect(f.controller.getSnapshot()).toMatchObject({ phase: 'blocked', error: 'auth_required' });
});
it.each(['couple', 'epoch', 'state'])('owner changed %s binding resets old secrets and uses authoritative context', async change => {
  const f = await prepare('revoke'); await f.api.issue(); f.request.mockClear();
  const value: SessionContext = { ...owner, ...(change === 'couple' ? { coupleId: uuid(90) }
    : change === 'epoch' ? { membershipEpoch: 4 } : { state: 'ready' as const }) };
  f.discovery.mockImplementation(async () => envelope(value)); await f.api.revoke();
  expect(f.request.mock.calls.filter(([r]) => r.method === 'DELETE')).toHaveLength(0);
  expect(f.api.getSnapshot()).toMatchObject({ issuedToken: null, invitation: null });
});
it.each(['preview', 'accept'] as const)('first-time %s after independently entering ready refreshes context without invitation POST', async operation => {
  const f = await prepare(operation); f.discovery.mockImplementation(async () => envelope(ready)); await f.action();
  expect(f.request.mock.calls.filter(([r]) => r.url.includes('/pair-invitations/'))).toHaveLength(0);
  expect(f.controller.getSnapshot().phase).toBe('signed_in');
});
it.each([401, 403, 503, 200])('preflight failure %s prevents mutation, treating malformed identity as terminal', async status => {
  const f = await prepare('issue'); f.discovery.mockResolvedValueOnce(status === 200 ? envelope({ state: 'waiting_partner', sessionId: 'wrong' }) : errorResponse('denied', status));
  await f.action(); expect(f.request).not.toHaveBeenCalled();
  if (status === 503) expect(f.api.getSnapshot()).toMatchObject({ error: 'invitation_retry_required', mode: 'owner' });
  else expect(f.controller.getSnapshot().error).toBe(status === 403 ? 'access_required' : 'auth_required');
});
it.each(boundaries)('editing token during preview %s resets consent and old responses cannot replace newer preview', async boundary => {
  const f = await prepare('preview'); const heldCookie = deferred<string>(); const heldResponse = deferred<Response>(); let calls = 0;
  if (boundary.includes('cookie')) f.client.getCookie.mockImplementation(async () => {
    calls++; if (calls === ({ cookie: 1, cookie_recheck: 2, response_cookie: 3 } as Record<string, number>)[boundary]) return heldCookie.promise; return cookie;
  });
  if (boundary === 'binding') f.discovery.mockReturnValueOnce(heldResponse.promise);
  if (boundary === 'response') f.request.mockReturnValueOnce(heldResponse.promise);
  const pending = f.api.preview(); await settle();
  const oldRequest = f.request.mock.calls.at(-1)?.[0]; f.api.setToken(otherToken);
  if (boundary === 'response') expect(oldRequest?.signal.aborted).toBe(true);
  f.client.getCookie.mockResolvedValue(cookie); f.request.mockResolvedValue(previewed());
  await f.api.preview(); f.api.setConsent(true); const latest = f.api.getSnapshot();
  heldCookie.resolve(cookie); heldResponse.resolve(boundary === 'binding' ? envelope(recipient) : errorResponse('unauthenticated', 401));
  await pending; expect(f.api.getSnapshot()).toEqual(latest); expect(latest).toMatchObject({ tokenInput: otherToken, consent: true });
});
it('editing while accept is in flight suppresses its late ACK and clears pending consent, without retrying the old token', async () => {
  const f = await prepare('accept'); const hold = deferred<Response>(); f.request.mockReturnValueOnce(hold.promise);
  const pending = f.api.accept(); await settle(); f.api.setToken(otherToken); hold.resolve(accepted()); await pending;
  expect(f.api.getSnapshot()).toMatchObject({ tokenInput: otherToken, preview: null, consent: false, recovery: 'none' });
  await f.api.accept(); expect(f.request).toHaveBeenCalledTimes(1);
});
it.each([1, 2, 3])('cookie read rejection %s is sanitized and preserves only appropriate uncertainty', async boundary => {
  const f = await prepare('issue'); let calls = 0;
  f.client.getCookie.mockImplementation(async () => { if (++calls === boundary) throw new Error('secret SDK error'); return cookie; });
  await f.api.issue(); expect(f.api.getSnapshot().error).toBe('invitation_retry_required');
  expect(f.api.getSnapshot().issuedToken).toBeNull(); expect(f.api.getSnapshot().recovery).toBe(boundary === 3 ? 'issue_uncertain' : 'none');
});
it('a rejected older cookie read after cancel cannot overwrite a later successful preview', async () => {
  const f = await prepare('preview'); const hold = deferred<string>(); f.client.getCookie.mockReturnValueOnce(hold.promise);
  const pending = f.api.preview(); await settle(); f.api.cancel(); f.api.setToken(otherToken); await f.api.preview(); f.api.setConsent(true);
  hold.reject(new Error('stale')); await pending; expect(f.api.getSnapshot()).toMatchObject({ tokenInput: otherToken, consent: true, error: null });
});
it('parent context refresh/reset clears pending issue token and prevents late restoration', async () => {
  const f = await prepare('issue'); const hold = deferred<Response>(); f.request.mockReturnValueOnce(hold.promise);
  const pending = f.api.issue(); await settle(); await f.controller.refresh(); hold.resolve(issued()); await pending;
  expect(f.api.getSnapshot()).toMatchObject({ mode: 'owner', issuedToken: null, recovery: 'none', invitation: null });
});
it('unknown accept followed by another domain user clears retained token without issuing any retry', async () => {
  const f = await prepare('accept'); f.request.mockResolvedValueOnce(errorResponse()); await f.api.accept(); f.request.mockClear();
  f.discovery.mockImplementation(async () => envelope({ ...ready, userId: uuid(90) })); await f.api.accept();
  expect(f.request).not.toHaveBeenCalled(); expect(f.api.getSnapshot().tokenInput).toBe(''); expect(f.controller.getSnapshot().error).toBe('auth_required');
});
it('unknown accept retry in an unrelated ready pair relies on server rejection, never a fabricated accepted result', async () => {
  const f = await prepare('accept'); f.request.mockResolvedValueOnce(errorResponse()); await f.api.accept();
  f.discovery.mockImplementation(async () => envelope({ ...ready, coupleId: uuid(90) })); f.request.mockResolvedValueOnce(errorResponse('invitation_unavailable', 409));
  await f.api.accept(); expect(f.api.getSnapshot()).toMatchObject({ error: 'invitation_unavailable', consent: false, preview: null, recovery: 'none' });
  expect(f.controller.getSnapshot().phase).toBe('blocked');
});
it('a hung injected request gets an abort signal after the parent request deadline', async () => {
  jest.useFakeTimers();
  try {
    const f = await prepare('issue'); f.request.mockImplementationOnce(input => new Promise((_, reject) =>
      input.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })));
    const pending = f.api.issue(); await settle(); await jest.advanceTimersByTimeAsync(10001); await pending;
    expect(f.api.getSnapshot()).toMatchObject({ recovery: 'issue_uncertain', error: 'invitation_retry_required', busy: null });
  } finally { jest.useRealTimers(); }
});
it.each(['issue', 'revoke', 'accept'] as const)('synchronous cancel during %s recovery notification cannot start the wire mutation', async operation => {
  const f = await prepare(operation);
  const unsubscribe = f.api.subscribe(() => {
    if (f.api.getSnapshot().busy && f.api.getSnapshot().recovery !== 'none') f.api.cancel();
  });
  await f.action(); expect(f.request).not.toHaveBeenCalled();
  expect(f.api.getSnapshot()).toMatchObject({ busy: null, issuedToken: null, tokenInput: '', consent: false }); unsubscribe();
});
it('waiting-space creation cannot discard a preserved uncertain accept command', async () => {
  const f = await prepare('accept'); f.request.mockResolvedValueOnce(errorResponse()); await f.api.accept();
  const calls = f.discovery.mock.calls.length; await f.controller.createWaitingSpace();
  expect(f.discovery).toHaveBeenCalledTimes(calls); expect(f.api.getSnapshot().recovery).toBe('accept_uncertain');
});
