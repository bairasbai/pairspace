import { createChatVisibility } from '../src/auth/chat-visibility';
import type { TransportSession } from '../src/chat/transport';
const id = (n: number) => `abcdef00-0000-4000-8000-${String(n).padStart(12, '0')}`;
const session: TransportSession = { scope: { userId: id(1), coupleId: id(2), membershipEpoch: 1, sessionId: 's' }, token: 'cookie', credentialGeneration: 1 };
const message = { id: id(3), coupleId: id(2), senderId: id(1), clientId: id(4), seq: 1, version: 1, body: 'text', createdAt: '2026-11-12T00:00:00.000Z' };
function setup() {
  let captured: { generation: number; session: TransportSession } | null = { generation: 1, session };
  let revision = 0;
  const host = { capture: () => captured, find: jest.fn(() => message),
    credential: jest.fn(async (): Promise<{ credential: TransportSession } | null> => ({ credential: session })),
    cookie: jest.fn(async (): Promise<string | null> => 'cookie'), denied: jest.fn(), revision: () => revision,
    acceptDeleted: jest.fn(async () => true) };
  const request = jest.fn(async (req: Request): Promise<Response> => {
    const url = new URL(req.url), readId = url.searchParams.get('read_id');
    const headers = { 'X-Chat-Visibility-Revision': String(revision) };
    if (req.method === 'PUT') {
      const body = await req.json();
      return Response.json({ ok: true, value: { commandId: body.command_id, replay: false,
        visibility: { messageId: id(3), hidden: body.hidden, version: body.expected_visibility_version + 1 } } }, { headers });
    }
    const value = url.pathname.endsWith('/visibility')
      ? { visibility: { messageId: id(3), hidden: false, version: 0 }, readId }
      : { messages: [], readId, hasOlder: false, hasNewer: false, olderCursor: null, newerCursor: null };
    return Response.json({ ok: true, value }, { headers });
  });
  let serial = 10;
  const controller = createChatVisibility('https://example.test', host, request, () => id(++serial), () => id(++serial));
  const deny = (status: number, error: string) => request.mockImplementationOnce(async req => Response.json({ ok: false, error,
    ...(req.method === 'GET' ? { readId: new URL(req.url).searchParams.get('read_id') } : {}) },
  { status, headers: { 'X-Chat-Visibility-Revision': String(revision) } }));
  const history = (deleted = false) => request.mockImplementationOnce(async req => Response.json({ ok: true, value: {
    messages: [{ id: message.id, coupleId: message.coupleId, senderId: message.senderId, clientId: message.clientId,
      seq: 1, version: deleted ? 2 : 1, createdAt: message.createdAt, replyToId: null,
      deletedAt: deleted ? '2026-11-13T00:00:00.000Z' : null, visibilityVersion: 1 }],
    readId: new URL(req.url).searchParams.get('read_id'), hasOlder: false, hasNewer: false, olderCursor: null, newerCursor: null,
  } }, { headers: { 'X-Chat-Visibility-Revision': String(revision) } }));
  return { controller, host, request, deny, history, setScope: (value: typeof captured) => { captured = value; },
    setRevision: (value: number) => { revision = value; } };
}
describe('visibility coordinator guarded states', () => {
  test('subscribe/reset, no scope and unavailable navigation are no-ops', async () => {
    const h = setup(), listener = jest.fn(), off = h.controller.subscribe(listener);
    await h.controller.retry(); await h.controller.confirm('bad'); h.controller.beginRestore('absent');
    await h.controller.loadOlder(); await h.controller.loadNewer(); expect(h.request).not.toHaveBeenCalled();
    h.setScope(null); await h.controller.beginHide(id(3)); await h.controller.loadLatest();
    expect(h.request).not.toHaveBeenCalled(); h.controller.reset(); expect(listener).toHaveBeenCalledTimes(1);
    off(); h.controller.invalidateHistory(); expect(listener).toHaveBeenCalledTimes(1);
  });
  test('no credentials and stale account before network never request', async () => {
    const h = setup(); h.host.credential.mockResolvedValueOnce(null); await h.controller.beginHide(id(3));
    h.host.credential.mockResolvedValueOnce(null); await h.controller.loadLatest(); expect(h.request).not.toHaveBeenCalled();
    h.host.credential.mockImplementationOnce(async () => { h.setScope(null); return { credential: session }; });
    await h.controller.beginHide(id(3)); expect(h.request).not.toHaveBeenCalled();
  });
  test('read denials, local errors, cookie changes and exceptions', async () => {
    for (const load of [false, true]) {
      const h = setup(), action = () => load ? h.controller.loadLatest() : h.controller.beginHide(id(3));
      h.deny(403, 'unavailable'); await action(); expect(h.host.denied).toHaveBeenCalledWith('access_required');
      h.deny(409, 'message_unavailable'); await action(); expect(h.controller.getSnapshot().status).toBe('error');
      h.host.cookie.mockResolvedValueOnce('other'); await action(); expect(h.host.denied).toHaveBeenCalledWith('auth_required');
      h.host.credential.mockRejectedValueOnce(Error('cookie unavailable')); await action();
      expect(h.controller.getSnapshot().error).toBe('transport_error');
    }
  });
  test('pending unknown can retry, guards cannot retarget or cancel it', async () => {
    const h = setup(); await h.controller.beginHide(id(3)); const token = h.controller.getSnapshot().confirmation!.token;
    await h.controller.confirm('wrong'); expect(h.controller.getSnapshot().status).toBe('confirming');
    h.host.credential.mockResolvedValueOnce(null); await h.controller.confirm(token);
    expect(h.controller.getSnapshot()).toMatchObject({ status: 'unknown', pendingId: id(3) });
    const calls = h.request.mock.calls.length; await h.controller.beginHide(id(3)); h.controller.beginRestore(id(3)); h.controller.cancel();
    expect(h.request).toHaveBeenCalledTimes(calls); expect(h.controller.getSnapshot().pendingId).toBe(id(3));
    h.deny(409, 'version_conflict'); await h.controller.retry();
    expect(h.controller.getSnapshot()).toMatchObject({ status: 'error', error: 'version_conflict', pendingId: undefined });
    await h.controller.beginHide(id(3)); h.controller.cancel(); expect(h.controller.getSnapshot().confirmation).toBeUndefined();
  });
  test('write auth/cookie failures, unknown transport, bad revision and success', async () => {
    const h = setup(); await h.controller.beginHide(id(3));
    h.deny(401, 'unauthenticated'); await h.controller.confirm(h.controller.getSnapshot().confirmation!.token);
    expect(h.host.denied).toHaveBeenCalledWith('auth_required');
    h.host.cookie.mockResolvedValueOnce('other'); await h.controller.retry(); expect(h.host.denied).toHaveBeenCalledTimes(2);
    h.request.mockRejectedValueOnce(Error('offline')); await h.controller.retry(); expect(h.controller.getSnapshot().status).toBe('unknown');
    h.host.credential.mockRejectedValueOnce(Error('credentials')); await h.controller.retry(); expect(h.controller.getSnapshot().error).toBe('transport_error');
    h.request.mockImplementationOnce(async req => { const body = await req.json(); return Response.json({ ok: true, value: {
      commandId: body.command_id, replay: true, visibility: { messageId: id(3), hidden: true, version: 1 } } },
    { headers: { 'X-Chat-Visibility-Revision': '9' } }); });
    await h.controller.retry(); expect(h.controller.getSnapshot().error).toBe('visibility_changed');
    await h.controller.retry(); expect(h.controller.getSnapshot()).toMatchObject({ status: 'saved', pendingId: undefined });
  });
  test('restore takes metadata version and terminal acceptance failure suppresses history', async () => {
    const h = setup(); h.history(true); h.host.acceptDeleted.mockResolvedValueOnce(false); await h.controller.loadLatest();
    expect(h.controller.getSnapshot().history).toBeUndefined();
    h.history(); await h.controller.loadLatest(); h.controller.beginRestore(id(3));
    expect(h.controller.getSnapshot().confirmation).toMatchObject({ hidden: false, version: 1 });
    await h.controller.confirm(h.controller.getSnapshot().confirmation!.token); expect(h.controller.getSnapshot().status).toBe('saved');
  });
  test('obsolete reads, post-cookie reset and stale write completion never publish', async () => {
    const h = setup(); let resolve!: (value: Response) => void;
    h.request.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const old = h.controller.loadLatest(); await Promise.resolve(); await Promise.resolve();
    h.controller.reset(); resolve(Response.json({ ok: false, error: 'message_unavailable', readId: id(11) },
      { status: 409, headers: { 'X-Chat-Visibility-Revision': '0' } })); await old;
    expect(h.controller.getSnapshot()).toEqual({ status: 'idle' });
    h.host.cookie.mockImplementationOnce(async () => { h.controller.reset(); return 'cookie'; });
    await h.controller.beginHide(id(3)); expect(h.controller.getSnapshot()).toEqual({ status: 'idle' });
    await h.controller.beginHide(id(3)); h.host.credential.mockImplementationOnce(async () => {
      h.setScope({ generation: 2, session }); return { credential: session };
    });
    await h.controller.confirm(h.controller.getSnapshot().confirmation!.token);
    expect(h.controller.getSnapshot().status).toBe('sending');
  });
});
