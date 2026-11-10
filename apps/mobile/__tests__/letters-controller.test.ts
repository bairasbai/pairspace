import { createLettersController } from '../src/auth/letters';
import type { InvitationHostSnapshot } from '../src/auth/invitations-controller';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const context = { state: 'ready' as const, sessionId: 'session', userId: uuid(1), coupleId: uuid(2), membershipEpoch: 1 };
const letter = { id: uuid(9), senderId: uuid(1), recipientId: uuid(4), coupleId: uuid(2), clientId: uuid(3), membershipEpoch: 1,
  body: 'Hello', createdAt: '2026-11-10T00:00:00.000Z' };
const envelope = (value: unknown, status = 200) => new Response(JSON.stringify({ ok: true, value }), { status });
const ack = () => envelope({ letter, replay: false }, 201);
function fixture() {
  let capture: InvitationHostSnapshot | null = { generation: 1, identity: { sessionId: 'session', userId: 'provider' }, context };
  const host = { capture: () => capture, getCookie: jest.fn(async () => 'synthetic=cookie'), block: jest.fn(), refresh: jest.fn(async () => {}) };
  const discovery = jest.fn(async () => envelope(context));
  const operation = jest.fn(async (_r: Request) => ack());
  const command = jest.fn(() => uuid(3));
  const controller = createLettersController({ mode: 'synthetic-loopback', baseURL: 'http://127.0.0.1:8787' }, host,
    r => r.url.endsWith('/context') ? discovery() : operation(r), command);
  controller.sync(); controller.actions.setDraft('Hello');
  return { controller, api: controller.actions, host, discovery, operation, command, set: (v: InvitationHostSnapshot | null) => { capture = v; } };
}
it('does no implicit care requests, ignores unavailable and unsubscribes', async () => {
  const f = fixture(); const listener = jest.fn(); const stop = f.api.subscribe(listener);
  f.controller.sync(); expect(listener).not.toHaveBeenCalled(); expect(f.operation).not.toHaveBeenCalled();
  f.controller.reset(); stop(); f.controller.reset(); await f.api.send(); await f.api.list();
  expect(listener).toHaveBeenCalledTimes(1); expect(f.operation).not.toHaveBeenCalled();
  f.set(null); f.controller.sync(); expect(f.api.getSnapshot().available).toBe(false);
});
it('retains command after unknown ACK, serializes taps and creates new command only after confirmed result', async () => {
  const f = fixture(); let resolve!: (r: Response) => void;
  f.operation.mockReturnValueOnce(new Promise(r => { resolve = r; }));
  const work = f.api.send(); for (let i = 0; i < 30; i++) await Promise.resolve();
  expect(f.api.getSnapshot().status).toBe('sending'); await f.api.send(); await f.api.list();
  expect(f.operation).toHaveBeenCalledTimes(1); resolve(envelope({}, 503)); await work;
  expect(f.api.getSnapshot().status).toBe('retry'); await f.api.send();
  expect(f.api.getSnapshot()).toMatchObject({ status: 'sent', busy: false, opened: null });
  expect(f.command).toHaveBeenCalledTimes(1);
  expect(f.operation.mock.calls[0][0].headers.get('Idempotency-Key')).toBe(uuid(3));
  expect(await f.operation.mock.calls[1][0].json()).toEqual({ client_letter_id: uuid(3), membership_epoch: 1, body: 'Hello' });
  f.command.mockReturnValue(uuid(5)); f.operation.mockResolvedValueOnce(envelope({ letter: { ...letter, clientId: uuid(5) }, replay: false }));
  f.api.setDraft('Hello'); await f.api.send(); expect(f.command).toHaveBeenCalledTimes(2); expect(f.api.getSnapshot().status).toBe('sent');
});
it('lists metadata and explicitly opens body, with no read receipts', async () => {
  const f = fixture(); const { body: _body, ...incoming } = { ...letter, senderId: uuid(4), recipientId: uuid(1) };
  f.operation.mockResolvedValueOnce(envelope({ letters: [] })); await f.api.list();
  expect(f.api.getSnapshot()).toMatchObject({ letters: [], checked: true });
  f.operation.mockResolvedValueOnce(envelope({ letters: [incoming] })); await f.api.list();
  expect(f.api.getSnapshot().letters).toEqual([incoming]); expect(f.api.getSnapshot().opened).toBeNull();
  f.operation.mockResolvedValueOnce(envelope({ letter: { ...incoming, body: 'Hello' } })); await f.api.open(incoming.id);
  expect(f.api.getSnapshot().opened?.body).toBe('Hello'); f.api.close(); expect(f.api.getSnapshot().opened).toBeNull();
  expect(f.operation.mock.calls[2][0].url).toContain('/letters/' + incoming.id + '?membership_epoch=1');
});
it.each([401, 403, 409])('blocks and clears pending on status %s', async status => {
  const f = fixture(); f.operation.mockResolvedValue(envelope({}, status)); await f.api.send();
  expect(f.host.block).toHaveBeenCalledWith('access_required'); expect(f.api.getSnapshot().available).toBe(false);
});
it.each(['senderId', 'recipientId', 'coupleId', 'clientId', 'membershipEpoch', 'body', 'createdAt', 'id'])('rejects malformed or wrong-scope %s ACK', async field => {
  const f = fixture(); f.operation.mockResolvedValue(envelope({ letter: { ...letter, [field]: 'wrong' }, replay: true }));
  await f.api.send(); expect(f.api.getSnapshot()).toMatchObject({ status: 'retry', error: true });
});
it.each([null, [], {}, { ok: false }, { ok: true, value: {} }, { ok: true, value: { letter } }, { ok: true, value: { letter: null, replay: true } }])('rejects invalid envelope %p', async body => {
  const f = fixture(); f.operation.mockResolvedValue(new Response(JSON.stringify(body))); await f.api.send();
  expect(f.api.getSnapshot().status).toBe('retry');
});
it('rejects response stream and invalid command failures without success', async () => {
  const f = fixture(); f.operation.mockResolvedValueOnce(new Response('bad')); await f.api.send(); expect(f.api.getSnapshot().status).toBe('retry');
  f.controller.reset(); f.controller.sync(); f.api.setDraft('Hello'); f.command.mockReturnValue('bad'); await f.api.send(); expect(f.api.getSnapshot().status).toBe('invalid');
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
  expect(f.api.getSnapshot()).toMatchObject({ available: false, opened: null, status: 'idle' });
});
it.each([2, 3, 4])('blocks external cookie replacement at check %s', async at => {
  const f = fixture(); let n = 0; f.host.getCookie.mockImplementation(async () => ++n >= at ? 'changed' : 'synthetic=cookie');
  await f.api.send(); expect(f.host.block).toHaveBeenCalledWith('auth_required'); expect(f.api.getSnapshot().available).toBe(false);
  expect(f.operation).toHaveBeenCalledTimes(at === 2 ? 0 : 1);
});
it('a read does not discard unknown-ACK command', async () => {
  const f = fixture(); f.operation.mockResolvedValueOnce(envelope({}, 503)); await f.api.send();
  f.operation.mockResolvedValueOnce(envelope({ letters: [] })); await f.api.list(); await f.api.send();
  expect(f.command).toHaveBeenCalledTimes(1); expect(f.api.getSnapshot().status).toBe('sent');
});
it('shows disabled server feature explicitly on list, not as delivery or transient success', async () => {
  const f = fixture(); f.operation.mockResolvedValue(envelope({}, 404)); await f.api.list();
  expect(f.api.getSnapshot()).toMatchObject({ status: 'unavailable', busy: false });
});
it('draft is private and normalization/revision survives lost ACK and edits', async () => {
  const f = fixture(); f.api.setDraft('e\u0301\r\nHi'); expect(f.operation).not.toHaveBeenCalled();
  f.operation.mockRejectedValueOnce(new Error('lost ack'));
  await f.api.send(); f.api.setDraft('New draft');
  f.operation.mockResolvedValueOnce(envelope({ letter: { ...letter, body: 'é\nHi' }, replay: true }));
  await f.api.send();
  expect(await f.operation.mock.calls[0][0].json()).toEqual(await f.operation.mock.calls[1][0].json());
  expect(f.api.getSnapshot()).toMatchObject({ status: 'sent', draft: 'New draft' });
});
it.each(['', '\u0000', 'a'.repeat(8001), '\uD800'])('rejects invalid draft before requests', async draft => {
  const f = fixture(); f.api.setDraft(draft); await f.api.send();
  expect(f.api.getSnapshot().status).toBe('invalid'); expect(f.operation).not.toHaveBeenCalled();
});
it('blocks draft writes when unavailable, bounds input and ignores unlisted opens', async () => {
  const f = fixture(); f.api.setDraft('a'.repeat(20000)); expect(f.api.getSnapshot().draft).toHaveLength(16000);
  await f.api.open('bad'); await f.api.open(uuid(9)); expect(f.operation).not.toHaveBeenCalled();
  f.controller.reset(); f.api.setDraft('private'); expect(f.api.getSnapshot().draft).toBe('');
});
const incoming = { ...letter, body: undefined, senderId: uuid(4), recipientId: uuid(1) };
it.each([null, {}, [letter], [{ ...incoming, body: 'private' }], Array(31).fill(incoming)])('rejects malformed/oversize/non-private lists %p', async letters => {
  const f = fixture(); f.operation.mockResolvedValueOnce(envelope({ letters })); await f.api.list();
  expect(f.api.getSnapshot()).toMatchObject({ error: true, letters: [], checked: false });
});
it('rejects duplicates and validates explicit body ownership/id/text', async () => {
  const f = fixture(); const { body: _body, ...meta } = incoming;
  f.operation.mockResolvedValueOnce(envelope({ letters: [meta, meta] })); await f.api.list(); expect(f.api.getSnapshot().error).toBe(true);
  f.operation.mockResolvedValueOnce(envelope({ letters: [meta] })); await f.api.list();
  for (const bad of [null, letter, meta, { ...incoming, id: uuid(88), body: 'Hi' }, { ...incoming, body: '' }, { ...incoming, body: 'e\u0301' }]) {
    f.operation.mockResolvedValueOnce(envelope({ letter: bad })); await f.api.open(meta.id);
    expect(f.api.getSnapshot()).toMatchObject({ error: true, opened: null });
  }
});
it('close cancels a pending open and a late body cannot reappear', async () => {
  const f = fixture(); const { body: _body, ...meta } = incoming;
  f.operation.mockResolvedValueOnce(envelope({ letters: [meta] })); await f.api.list();
  let release!: (r: Response) => void; f.operation.mockReturnValueOnce(new Promise(r => { release = r; }));
  const work = f.api.open(meta.id); for (let i = 0; i < 30; i++) await Promise.resolve();
  f.api.close(); expect(f.api.getSnapshot().busy).toBe(false);
  release(envelope({ letter: { ...meta, body: 'Private' } })); await work;
  expect(f.api.getSnapshot().opened).toBeNull();
});
it('closing during send preserves acknowledgement and unknown-ACK recovery', async () => {
  const f = fixture(); let release!: (r: Response) => void;
  f.operation.mockReturnValueOnce(new Promise(r => { release = r; }));
  const work = f.api.send(); for (let i = 0; i < 30; i++) await Promise.resolve();
  f.api.close(); release(envelope({}, 503)); await work; await f.api.send();
  expect(f.command).toHaveBeenCalledTimes(1); expect(f.api.getSnapshot().status).toBe('sent');
});

it.each(['send', 'list'] as const)('404 on %s cannot hide unknown-ACK retry or substitute a newer draft', async action => {
  const f = fixture(); f.operation.mockRejectedValueOnce(new Error('lost ack')); await f.api.send();
  f.operation.mockResolvedValueOnce(envelope({}, 404)); await f.api[action]();
  expect(f.api.getSnapshot()).toMatchObject({ status: 'retry', error: true });
  f.api.setDraft('New separate draft'); await f.api.send();
  expect(f.command).toHaveBeenCalledTimes(1);
  expect(await f.operation.mock.calls[2][0].json()).toEqual({ client_letter_id: uuid(3), membership_epoch: 1, body: 'Hello' });
  expect(f.api.getSnapshot()).toMatchObject({ status: 'sent', draft: 'New separate draft' });
});
