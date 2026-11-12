import { createSessionController } from './legacy-chat-window.fixture';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const context = { state: 'ready', sessionId: 'session', userId: uuid(1), coupleId: uuid(2), membershipEpoch: 1 };
const envelope = (value: unknown, status = 200) => new Response(JSON.stringify({ ok: true, value }), { status });
function fixture() {
  const client = { signIn: jest.fn(async () => ({ userId: 'provider', sessionId: 'session' })), signOut: jest.fn(async () => true), getCookie: jest.fn(async () => 'synthetic=cookie') };
  const discovery = jest.fn(async () => envelope(context));
  const operation = jest.fn(async (_r: Request) => envelope({ ...context, state: 'closed', commandId: uuid(3), replayed: false }));
  const request = jest.fn(async (r: Request) => r.url.endsWith('/context') ? discovery() : r.url.endsWith('/leave') ? operation(r)
    : envelope({ messages: [], nextBeforeSeq: null }));
  const controller = createSessionController({ mode: 'synthetic-loopback', baseURL: 'http://127.0.0.1:8787' }, client, request, () => uuid(3));
  return { controller, client, discovery, operation, request, login: () => controller.signIn('synthetic@example.test', 'synthetic-password') };
}
it('scrubs all volatile content on submit, disables operations during unknown outcome, keeps credentials', async () => {
  const f = fixture(); await f.login(); const c = f.controller;
  c.setDraft('Synthetic chat draft'); c.letters.setDraft('Synthetic letter draft'); c.letters.setReleaseAt('2026-12-01T10:00:00Z');
  c.leave.begin(); f.operation.mockRejectedValueOnce(new Error('lost ACK')); await c.leave.confirm();
  expect(c.getSnapshot()).toMatchObject({ phase: 'blocked', draft: '', messages: [], error: 'leave_pending' });
  expect(c.letters.getSnapshot()).toMatchObject({ draft: '', letters: [], opened: null, available: false });
  expect(c.care.getSnapshot()).toMatchObject({ incoming: null, available: false });
  expect(c.invitations.getSnapshot()).toMatchObject({ mode: 'unavailable', tokenInput: '', issuedToken: null });
  expect(c.leave.getSnapshot().status).toBe('retry');
  const calls = f.request.mock.calls.length;
  await c.refresh(); await c.send(); await c.letters.send(); await c.care.send(); await c.createWaitingSpace();
  expect(f.request).toHaveBeenCalledTimes(calls); expect(f.client.signOut).toHaveBeenCalledTimes(1);
  f.discovery.mockImplementation(async () => envelope({ state: 'no_active_pair', sessionId: 'session', userId: uuid(1) }));
  await c.leave.confirm(); expect(c.leave.getSnapshot().status).toBe('closed'); expect(c.getSnapshot().error).toBe('leave_finished');
  expect(f.client.signOut).toHaveBeenCalledTimes(1);
  await c.refresh(); expect(c.getSnapshot().error).toBe('context_no_active_pair');
  expect(c.leave.getSnapshot().available).toBe(false);
});
it('signout scrubs unknown command and late acknowledgement cannot restore state', async () => {
  const f = fixture(); await f.login(); let resolve!: (value: Response) => void;
  f.operation.mockReturnValue(new Promise(r => { resolve = r; })); f.controller.leave.begin(); const work = f.controller.leave.confirm();
  for (let n = 0; n < 70; n++) await Promise.resolve();
  await f.controller.signOut(); resolve(envelope({ ...context, state: 'closed', commandId: uuid(3), replayed: false })); await work;
  expect(f.controller.getSnapshot().phase).toBe('signed_out'); expect(f.controller.leave.getSnapshot().status).toBe('idle');
});
it('a refresh before confirmation invalidates the frozen confirmation', async () => {
  const f = fixture(); await f.login(); f.controller.leave.begin(); await f.controller.refresh(); await f.controller.leave.confirm();
  expect(f.operation).not.toHaveBeenCalled(); expect(f.controller.leave.getSnapshot().status).toBe('idle');
});
