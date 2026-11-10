import { createLeaveController } from '../src/auth/leave';
import type { InvitationHostSnapshot } from '../src/auth/invitations-controller';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const context = { state: 'ready' as const, sessionId: 'session', userId: uuid(1), coupleId: uuid(2), membershipEpoch: 1 };
const closed = { state: 'closed', sessionId: 'session', userId: uuid(1), coupleId: uuid(2), membershipEpoch: 1, commandId: uuid(3), replayed: false };
const envelope = (value: unknown, status = 200) => new Response(JSON.stringify({ ok: true, value }), { status });
function fixture() {
  let capture: InvitationHostSnapshot | null = { generation: 1, identity: { sessionId: 'session', userId: 'provider' }, context };
  const host = { capture: () => capture, getCookie: jest.fn(async () => 'synthetic=cookie'), block: jest.fn(),
    finish: jest.fn(), suspend: jest.fn(() => capture && (capture = { ...capture, generation: capture.generation + 1 })) };
  const discovery = jest.fn(async () => envelope(context));
  const operation = jest.fn(async (_r: Request) => envelope(closed));
  const command = jest.fn(() => uuid(3));
  const controller = createLeaveController({ mode: 'synthetic-loopback', baseURL: 'http://127.0.0.1:8787' }, host,
    r => r.url.endsWith('/context') ? discovery() : operation(r), command);
  controller.sync();
  return { controller, api: controller.actions, host, discovery, operation, command, set: (v: InvitationHostSnapshot | null) => { capture = v; } };
}
it('requires explicit scoped confirmation and permits cancel only before sending', async () => {
  const f = fixture(); const listener = jest.fn(); const stop = f.api.subscribe(listener);
  await f.api.confirm(); expect(f.operation).not.toHaveBeenCalled();
  f.api.begin(); f.api.begin(); f.controller.sync(); expect(f.api.getSnapshot().status).toBe('confirming');
  f.api.cancel(); expect(f.api.getSnapshot().status).toBe('idle'); expect(f.command).not.toHaveBeenCalled();
  f.api.begin(); await f.api.confirm(); f.api.cancel();
  expect(f.api.getSnapshot().status).toBe('closed'); expect(f.host.finish).toHaveBeenCalled();
  expect(await f.operation.mock.calls[0][0].json()).toEqual({ commandId: uuid(3), coupleId: uuid(2), membershipEpoch: 1, confirm: true });
  stop(); f.controller.reset(); expect(listener).toHaveBeenCalled();
});
it('unknown ACK scrubs then retries the same immutable command even after pair disappears', async () => {
  const f = fixture(); f.operation.mockRejectedValueOnce(new Error('lost ACK'));
  f.api.begin(); await f.api.confirm(); expect(f.api.getSnapshot().status).toBe('retry');
  expect(f.controller.unresolved()).toBe(true); f.api.cancel(); expect(f.api.getSnapshot().status).toBe('retry');
  f.discovery.mockResolvedValue(envelope({ state: 'no_active_pair', sessionId: 'session', userId: uuid(1) }));
  await f.api.confirm(); expect(f.api.getSnapshot().status).toBe('closed');
  expect(f.command).toHaveBeenCalledTimes(1); expect(f.host.suspend).toHaveBeenCalledTimes(2);
  expect(await f.operation.mock.calls[1][0].json()).toEqual(await f.operation.mock.calls[0][0].json());
});
it('retry after a new pair targets only old receipt, without refreshing into that pair', async () => {
  const f = fixture(); f.operation.mockResolvedValueOnce(envelope({}, 503)); f.api.begin(); await f.api.confirm();
  f.discovery.mockResolvedValue(envelope({ ...context, coupleId: uuid(99), membershipEpoch: 4 }));
  await f.api.confirm(); expect(f.api.getSnapshot().status).toBe('closed');
  expect((await f.operation.mock.calls[1][0].json()).coupleId).toBe(uuid(2));
});
it.each([{ ...context, coupleId: uuid(9) }, { ...context, membershipEpoch: 2 }, { state: 'no_active_pair', sessionId: 'session', userId: uuid(1) }])('rejects stale initial confirmation %p', async changed => {
  const f = fixture(); f.api.begin(); f.discovery.mockResolvedValue(envelope(changed)); await f.api.confirm();
  expect(f.operation).not.toHaveBeenCalled(); expect(f.api.getSnapshot().status).toBe('unavailable');
});
it.each([401, 403])('clears on auth refusal %s', async status => {
  const f = fixture(); f.api.begin(); f.operation.mockResolvedValue(envelope({}, status)); await f.api.confirm();
  expect(f.host.block).toHaveBeenCalledWith('auth_required'); expect(f.api.getSnapshot().status).toBe('idle');
});
it('409 is unavailable, never a closed acknowledgement', async () => {
  const f = fixture(); f.api.begin(); f.operation.mockResolvedValue(envelope({}, 409)); await f.api.confirm();
  expect(f.api.getSnapshot().status).toBe('unavailable');
});
it.each(['state', 'sessionId', 'userId', 'coupleId', 'membershipEpoch', 'commandId', 'replayed'])('rejects forged %s acknowledgement', async key => {
  const f = fixture(); f.api.begin(); f.operation.mockResolvedValue(envelope({ ...closed, [key]: 'wrong' })); await f.api.confirm();
  expect(f.api.getSnapshot().status).toBe('retry'); expect(f.host.finish).not.toHaveBeenCalled();
});
it.each([null, [], {}, { ok: false }, { ok: true, value: null }])('rejects malformed envelope %p', async body => {
  const f = fixture(); f.api.begin(); f.operation.mockResolvedValue(new Response(JSON.stringify(body))); await f.api.confirm();
  expect(f.api.getSnapshot().status).toBe('retry');
});
it('serializes double taps and ignores stale response after reset', async () => {
  const f = fixture(); let resolve!: (r: Response) => void;
  f.operation.mockReturnValue(new Promise(r => { resolve = r; })); f.api.begin(); const work = f.api.confirm();
  for (let n = 0; n < 40; n++) await Promise.resolve();
  await f.api.confirm(); expect(f.operation).toHaveBeenCalledTimes(1); f.controller.reset(); resolve(envelope(closed)); await work;
  expect(f.api.getSnapshot().status).toBe('idle'); expect(f.host.finish).not.toHaveBeenCalled();
});
it('refuses changed identity or generation and absent scope before dispatch', async () => {
  for (const value of [null, { ...fixture().host.capture()!, generation: 88 }]) {
    const f = fixture(); f.api.begin(); f.set(value); await f.api.confirm(); expect(f.operation).not.toHaveBeenCalled();
  }
  const f = fixture(); f.set(null); f.api.begin(); expect(f.api.getSnapshot().available).toBe(false);
});
it('invalid command and unavailable suspension cannot dispatch', async () => {
  const f = fixture(); f.api.begin(); f.command.mockReturnValue('bad'); await f.api.confirm(); expect(f.operation).not.toHaveBeenCalled();
  const g = fixture(); g.api.begin(); g.host.suspend.mockReturnValue(null); await g.api.confirm(); expect(g.operation).not.toHaveBeenCalled();
});
it.each([401, 403, 503])('handles preflight status %s safely', async status => {
  const f = fixture(); f.api.begin(); f.discovery.mockResolvedValue(envelope({}, status)); await f.api.confirm();
  expect(f.operation).not.toHaveBeenCalled(); expect(f.api.getSnapshot().status).toBe(status === 503 ? 'retry' : 'idle');
});
it.each([{ state: 'unmapped', sessionId: 'session' }, { ...context, userId: uuid(66) }])('rejects different user preflight %p', async value => {
  const f = fixture(); f.api.begin(); f.discovery.mockResolvedValue(envelope(value)); await f.api.confirm();
  expect(f.host.block).toHaveBeenCalledWith('auth_required'); expect(f.operation).not.toHaveBeenCalled();
});
it.each([2, 3, 4])('detects cookie rotation at check %s', async check => {
  const f = fixture(); let calls = 0; f.host.getCookie.mockImplementation(async () => ++calls < check ? 'synthetic=cookie' : 'rotated=cookie');
  f.api.begin(); await f.api.confirm(); expect(f.host.block).toHaveBeenCalledWith('auth_required');
  expect(f.api.getSnapshot().status).toBe('idle');
});
it('handles command generator failure without an unhandled rejection', async () => {
  const f = fixture(); f.api.begin(); f.command.mockImplementation(() => { throw new Error('unavailable'); });
  await f.api.confirm(); expect(f.operation).not.toHaveBeenCalled(); expect(f.api.getSnapshot().status).toBe('idle');
});
it.each(['cookie', 'discovery', 'post-cookie', 'body-cookie'])('ignores lifecycle invalidation while awaiting %s', async stage => {
  const f = fixture(); f.api.begin();
  if (stage === 'discovery') f.discovery.mockImplementation(async () => { f.controller.reset(); return envelope(context); });
  else {
    let n = 0; const target = stage === 'cookie' ? 1 : stage === 'post-cookie' ? 2 : 4;
    f.host.getCookie.mockImplementation(async () => { if (++n === target) f.controller.reset(); return 'synthetic=cookie'; });
  }
  await f.api.confirm(); expect(f.api.getSnapshot().status).toBe('idle'); expect(f.host.finish).not.toHaveBeenCalled();
});
