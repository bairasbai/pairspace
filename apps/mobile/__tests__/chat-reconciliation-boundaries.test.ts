import { createChatReconciliation } from '../src/auth/chat-reconciliation';
import { displayMessage } from '../src/chat/reply-view';
import type { TransportSession } from '../src/chat/transport';
const id = (n: number) => `abcdef00-0000-4000-8000-${String(n).padStart(12, '0')}`;
const session: TransportSession = { scope: { userId: id(1), coupleId: id(2), membershipEpoch: 1, sessionId: 's' }, token: 'cookie', credentialGeneration: 1 };
const message = { id: id(4), coupleId: id(2), senderId: id(1), clientId: id(5), seq: 1, body: 'text', version: 1,
  createdAt: '2026-11-12T00:00:00.000Z', replyToId: null, deletedAt: null };
const value = () => ({ readId: id(3), messages: [message], unavailableIds: [], detail: null, replyTarget: null, latestVisible: { id: id(4), seq: 1 } });
function setup() {
  type Host = Parameters<typeof createChatReconciliation>[1];
  let captured: ReturnType<Host['capture']> = { generation: 1, session };
  const host = {
    capture: () => captured,
    selection: jest.fn<ReturnType<Host['selection']>, Parameters<Host['selection']>>(() => ({ messages: [displayMessage(message)] })),
    credential: jest.fn<ReturnType<Host['credential']>, Parameters<Host['credential']>>(async () => ({ credential: session, changed: false })),
    cookie: jest.fn(async () => 'cookie'), denied: jest.fn<ReturnType<Host['denied']>, Parameters<Host['denied']>>(),
    accept: jest.fn<ReturnType<Host['accept']>, Parameters<Host['accept']>>(async () => true),
    unavailable: jest.fn<ReturnType<Host['unavailable']>, Parameters<Host['unavailable']>>(),
  } satisfies Host;
  const request = jest.fn(async (_input: Request, _valid?: () => boolean): Promise<Response> => Response.json({ ok: true, value: value() }));
  const controller = createChatReconciliation('https://example.test', host, request, () => id(3));
  const error = (status: number, error: string) => request.mockResolvedValueOnce(Response.json({ ok: false, error, readId: id(3) }, { status }));
  return { host, request, controller, error, setCapture: (v: typeof captured) => { captured = v; } };
}
describe('reconciliation coordinator boundaries', () => {
  test('no capture, absent credentials and changed context cannot start or publish rows', async () => {
    const h = setup(); h.setCapture(null); await h.controller.check(); expect(h.request).not.toHaveBeenCalled();
    h.setCapture({ generation: 1, session }); h.host.credential.mockResolvedValueOnce(null); await h.controller.check();
    expect(h.controller.getSnapshot()).toMatchObject({ status: 'error', error: 'transport_error' });
    h.host.credential.mockResolvedValueOnce({ credential: session, changed: true }); await h.controller.check(); expect(h.request).not.toHaveBeenCalled();
    h.host.credential.mockImplementationOnce(async () => { h.controller.invalidate(); return { credential: session, changed: false }; });
    await h.controller.check(); expect(h.controller.getSnapshot().status).toBe('idle'); expect(h.host.accept).not.toHaveBeenCalled();
  });
  test('network, malformed body and rejected accept surface safe retry errors', async () => {
    const h = setup(); h.request.mockRejectedValueOnce(Error('offline')); await h.controller.check();
    expect(h.controller.getSnapshot().error).toBe('transport_error');
    h.request.mockResolvedValueOnce(new Response('bad')); await h.controller.check(); expect(h.controller.getSnapshot().error).toBe('invalid_response');
    h.host.cookie.mockRejectedValueOnce(Error('cookie')); await h.controller.check(); expect(h.controller.getSnapshot().error).toBe('transport_error');
    h.host.accept.mockResolvedValueOnce(false); await h.controller.check(); expect(h.controller.getSnapshot().error).toBe('invalid_response');
    expect(h.host.unavailable).not.toHaveBeenCalled();
  });
  test('401/403 remain effective after navigation, old account denials are ignored', async () => {
    const h = setup();
    for (const status of [401, 403]) {
      h.request.mockImplementationOnce(async () => { h.controller.invalidate(); return Response.json({ ok: false, error: 'unavailable', readId: id(3) }, { status }); });
      await h.controller.check(); expect(h.host.denied).toHaveBeenLastCalledWith(status === 401 ? 'auth_required' : 'access_required');
    }
    h.host.denied.mockClear(); h.request.mockImplementationOnce(async () => {
      h.setCapture({ generation: 2, session }); return Response.json({ ok: false, error: 'unavailable', readId: id(3) }, { status: 403 });
    });
    await h.controller.check(); expect(h.host.denied).not.toHaveBeenCalled();
  });
  test('cookie and late validity are checked after reads and every mutation callback', async () => {
    const h = setup(); h.host.cookie.mockResolvedValueOnce('other'); await h.controller.check(); expect(h.host.denied).toHaveBeenCalledWith('auth_required');
    h.host.cookie.mockImplementationOnce(async () => { h.controller.invalidate(); return 'cookie'; }); await h.controller.check(); expect(h.host.accept).not.toHaveBeenCalled();
    h.host.accept.mockImplementationOnce(async () => { h.controller.invalidate(); return true; }); await h.controller.check(); expect(h.host.unavailable).not.toHaveBeenCalled();
    h.host.unavailable.mockImplementationOnce(() => { h.controller.invalidate(); }); await h.controller.check(); expect(h.controller.getSnapshot().status).toBe('idle');
  });
  test('visibility errors and subscription cleanup preserve no obsolete banner', async () => {
    const h = setup(), listener = jest.fn(), unsubscribe = h.controller.subscribe(listener);
    h.error(409, 'visibility_changed'); await h.controller.check(); expect(h.controller.getSnapshot().error).toBe('visibility_changed');
    h.controller.visibilityChanged(); expect(h.controller.getSnapshot()).toEqual({ status: 'error', error: 'visibility_changed', hasNewMessages: false });
    expect(listener).toHaveBeenCalled(); unsubscribe(); const count = listener.mock.calls.length;
    h.controller.reset(); expect(listener).toHaveBeenCalledTimes(count); expect(h.controller.getSnapshot()).toEqual({ status: 'idle', hasNewMessages: false });
  });
  test('foreground transitions coalesce active work and reset removes previous lifecycle state', async () => {
    const h = setup(); await h.controller.appStateChanged('active'); await h.controller.appStateChanged('active'); expect(h.request).not.toHaveBeenCalled();
    await h.controller.appStateChanged('background');
    let finish!: (r: Response) => void;
    h.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = h.controller.appStateChanged('active'), second = h.controller.check();
    expect(first).toBe(second); await Promise.resolve(); await Promise.resolve();
    finish(Response.json({ ok: true, value: value() })); await first; expect(h.request).toHaveBeenCalledTimes(1);
    await h.controller.appStateChanged('inactive'); await h.controller.appStateChanged('active'); expect(h.request).toHaveBeenCalledTimes(2);
    await h.controller.appStateChanged('background'); h.controller.reset(); await h.controller.appStateChanged('active'); expect(h.request).toHaveBeenCalledTimes(2);
  });
  test('held digest acceptance resolves after navigation or reset without publication', async () => {
    for (const reset of [false, true]) {
      const h = setup(); let release!: (accepted: boolean) => void;
      let entered!: () => void; const waiting = new Promise<void>(resolve => { entered = resolve; });
      h.host.accept.mockImplementationOnce(() => { entered(); return new Promise(resolve => { release = resolve; }); });
      const work = h.controller.check(); await waiting;
      const valid = h.host.accept.mock.calls[0][3]; expect(valid()).toBe(true);
      if (reset) h.controller.reset(); else h.controller.invalidate();
      expect(valid()).toBe(false); release(true); await work;
      expect(h.host.unavailable).not.toHaveBeenCalled();
      expect(h.controller.getSnapshot()).toEqual({ status: 'idle', hasNewMessages: false });
    }
  });
  test('roles deduplicate acceptance and report unavailable target without inventing tombstone', async () => {
    const h = setup(); h.host.selection.mockReturnValue({ messages: [], detail: displayMessage(message), replyTarget: displayMessage(message) });
    h.request.mockResolvedValueOnce(Response.json({ ok: true, value: { ...value(), messages: [], detail: { id: id(4), message: null }, replyTarget: { id: id(4), message: null }, latestVisible: null } }));
    await h.controller.check(); expect(h.host.accept).toHaveBeenCalledWith([], 'cookie', undefined, expect.any(Function));
    expect(h.host.unavailable).toHaveBeenCalledWith([id(4), id(4)], id(4)); expect(h.controller.getSnapshot().hasNewMessages).toBe(false);
    h.request.mockResolvedValueOnce(Response.json({ ok: true, value: { ...value(), messages: [], detail: { id: id(4), message }, replyTarget: { id: id(4), message } } }));
    await h.controller.check(); expect(h.host.accept).toHaveBeenLastCalledWith([displayMessage(message)], 'cookie', undefined, expect.any(Function));
    expect(h.controller.getSnapshot().hasNewMessages).toBe(true);
  });
});
