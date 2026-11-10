import { createCareController } from '../src/auth/care';
import type { InvitationHostSnapshot } from '../src/auth/invitations-controller';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const context = { state: 'ready' as const, sessionId: 'session', userId: uuid(1), coupleId: uuid(2), membershipEpoch: 1 };
const signal = { id: uuid(9), senderId: uuid(1), recipientId: uuid(4), coupleId: uuid(2), clientId: uuid(3), membershipEpoch: 1,
  kind: 'thinking_of_you', createdAt: '2026-11-10T00:00:00.000Z' };
const envelope = (value: unknown, status = 200) => new Response(JSON.stringify({ ok: true, value }), { status });
const ack = () => envelope({ signal, replay: false }, 201);
function fixture() {
  let capture: InvitationHostSnapshot | null = { generation: 1, identity: { sessionId: 'session', userId: 'provider' }, context };
  const host = { capture: () => capture, getCookie: jest.fn(async () => 'synthetic=cookie'), block: jest.fn(), refresh: jest.fn(async () => {}) };
  const discovery = jest.fn(async () => envelope(context));
  const operation = jest.fn(async (_r: Request) => ack());
  const command = jest.fn(() => uuid(3));
  const controller = createCareController({ mode: 'synthetic-loopback', baseURL: 'http://127.0.0.1:8787' }, host,
    r => r.url.endsWith('/context') ? discovery() : operation(r), command);
  controller.sync();
  return { controller, api: controller.actions, host, discovery, operation, command, set: (v: InvitationHostSnapshot | null) => { capture = v; } };
}
it('does no implicit care requests, ignores unavailable and unsubscribes', async () => {
  const f = fixture(); const listener = jest.fn(); const stop = f.api.subscribe(listener);
  f.controller.sync(); expect(listener).not.toHaveBeenCalled(); expect(f.operation).not.toHaveBeenCalled();
  f.controller.reset(); stop(); f.controller.reset(); await f.api.send(); await f.api.read();
  expect(listener).toHaveBeenCalledTimes(1); expect(f.operation).not.toHaveBeenCalled();
  f.set(null); f.controller.sync(); expect(f.api.getSnapshot().available).toBe(false);
});
it('retains command after unknown ACK, serializes taps and creates new command only after confirmed result', async () => {
  const f = fixture(); let resolve!: (r: Response) => void;
  f.operation.mockReturnValueOnce(new Promise(r => { resolve = r; }));
  const work = f.api.send(); for (let i = 0; i < 30; i++) await Promise.resolve();
  expect(f.api.getSnapshot().status).toBe('sending'); await f.api.send(); await f.api.read();
  expect(f.operation).toHaveBeenCalledTimes(1); resolve(envelope({}, 503)); await work;
  expect(f.api.getSnapshot().status).toBe('retry'); await f.api.send();
  expect(f.api.getSnapshot()).toMatchObject({ status: 'sent', busy: false, incoming: null });
  expect(f.command).toHaveBeenCalledTimes(1);
  expect(f.operation.mock.calls[0][0].headers.get('Idempotency-Key')).toBe(uuid(3));
  expect(await f.operation.mock.calls[1][0].json()).toEqual({ client_signal_id: uuid(3), membership_epoch: 1 });
  f.command.mockReturnValue(uuid(5)); f.operation.mockResolvedValueOnce(envelope({ signal: { ...signal, clientId: uuid(5) }, replay: false }));
  await f.api.send(); expect(f.command).toHaveBeenCalledTimes(2); expect(f.api.getSnapshot().status).toBe('sent');
});
it('reads only explicit partner signals, not own signals, and accepts null', async () => {
  const f = fixture(); f.operation.mockResolvedValueOnce(envelope({ signal: null })); await f.api.read();
  expect(f.api.getSnapshot()).toMatchObject({ incoming: null, checked: true });
  const incoming = { ...signal, senderId: uuid(4), recipientId: uuid(1) };
  f.operation.mockResolvedValueOnce(envelope({ signal: incoming })); await f.api.read();
  expect(f.api.getSnapshot().incoming).toEqual(incoming);
  await f.api.read(); expect(f.api.getSnapshot().error).toBe(true);
  expect(f.operation.mock.calls[0][0].url).toContain('?membership_epoch=1');
});
it.each([401, 403, 409])('blocks and clears pending on status %s', async status => {
  const f = fixture(); f.operation.mockResolvedValue(envelope({}, status)); await f.api.send();
  expect(f.host.block).toHaveBeenCalledWith('access_required'); expect(f.api.getSnapshot().available).toBe(false);
});
it('cooldown is explicit, not an ACK, and does not retain a rejected command', async () => {
  const f = fixture(); f.operation.mockResolvedValueOnce(envelope({}, 429)); await f.api.send();
  expect(f.api.getSnapshot().status).toBe('cooldown'); await f.api.send(); expect(f.command).toHaveBeenCalledTimes(2);
});
it.each(['senderId', 'recipientId', 'coupleId', 'clientId', 'membershipEpoch', 'kind', 'createdAt', 'id'])('rejects malformed or wrong-scope %s ACK', async field => {
  const f = fixture(); f.operation.mockResolvedValue(envelope({ signal: { ...signal, [field]: 'wrong' }, replay: true }));
  await f.api.send(); expect(f.api.getSnapshot()).toMatchObject({ status: 'retry', error: true });
});
it.each([null, [], {}, { ok: false }, { ok: true, value: {} }, { ok: true, value: { signal } }, { ok: true, value: { signal: null, replay: true } }])('rejects invalid envelope %p', async body => {
  const f = fixture(); f.operation.mockResolvedValue(new Response(JSON.stringify(body))); await f.api.send();
  expect(f.api.getSnapshot().status).toBe('retry');
});
it('rejects response stream and invalid command failures without success', async () => {
  const f = fixture(); f.operation.mockResolvedValueOnce(new Response('bad')); await f.api.send(); expect(f.api.getSnapshot().status).toBe('retry');
  f.controller.reset(); f.controller.sync(); f.command.mockReturnValue('bad'); await f.api.send(); expect(f.api.getSnapshot().status).toBe('retry');
});
it.each([401, 403, 500])('preflight denies/fails %s without mutation', async status => {
  const f = fixture(); f.discovery.mockResolvedValue(envelope({}, status)); await f.api.send();
  expect(f.operation).not.toHaveBeenCalled(); expect(f.api.getSnapshot().status).toBe(status === 500 ? 'retry' : 'idle');
});
it('refreshes on pair/epoch change and never replays old command into new context', async () => {
  const f = fixture(); f.discovery.mockResolvedValue(envelope({ ...context, membershipEpoch: 2 })); await f.api.send();
  expect(f.host.refresh).toHaveBeenCalled(); expect(f.operation).not.toHaveBeenCalled(); expect(f.api.getSnapshot().available).toBe(false);
});
it.each(['cookie', 'discovery', 'operation'])('drops late %s after scope invalidation', async point => {
  const f = fixture(); let release!: () => void; const wait = new Promise<void>(r => { release = r; });
  if (point === 'cookie') f.host.getCookie.mockImplementationOnce(async () => { await wait; return 'cookie'; });
  if (point === 'discovery') f.discovery.mockImplementationOnce(async () => { await wait; return envelope(context); });
  if (point === 'operation') f.operation.mockImplementationOnce(async () => { await wait; return ack(); });
  const work = f.api.send(); for (let i = 0; i < 30; i++) await Promise.resolve();
  f.set(null); f.controller.reset(); release(); await work;
  expect(f.api.getSnapshot()).toMatchObject({ available: false, incoming: null, status: 'idle' });
});
it.each([2, 3, 4])('blocks external cookie replacement at check %s', async at => {
  const f = fixture(); let n = 0; f.host.getCookie.mockImplementation(async () => ++n >= at ? 'changed' : 'synthetic=cookie');
  await f.api.send(); expect(f.host.block).toHaveBeenCalledWith('auth_required'); expect(f.api.getSnapshot().available).toBe(false);
  expect(f.operation).toHaveBeenCalledTimes(at === 2 ? 0 : 1);
});
it('a read does not discard unknown-ACK command', async () => {
  const f = fixture(); f.operation.mockResolvedValueOnce(envelope({}, 503)); await f.api.send();
  f.operation.mockResolvedValueOnce(envelope({ signal: null })); await f.api.read(); await f.api.send();
  expect(f.command).toHaveBeenCalledTimes(1); expect(f.api.getSnapshot().status).toBe('sent');
});
it('shows disabled server feature explicitly, not as delivery or transient success', async () => {
  const f = fixture(); f.operation.mockResolvedValue(envelope({}, 404)); await f.api.send();
  expect(f.api.getSnapshot()).toMatchObject({ status: 'unavailable', busy: false });
});
