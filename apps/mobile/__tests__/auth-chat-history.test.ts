import { createSessionController } from '../src/auth/controller';
import { mergeHistory } from '../src/chat/history';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const identity = { userId: 'synthetic', sessionId: 'session' };
const context = { state: 'ready', sessionId: 'session', userId: uuid(1), coupleId: uuid(2), membershipEpoch: 1 };
const row = (n: number) => ({ id: uuid(n + 1000), coupleId: uuid(2), senderId: uuid(1), clientId: uuid(n + 2000),
  seq: n * 3, body: `Synthetic ${n}`, version: 1, createdAt: '2026-11-10T00:00:00Z' });
const envelope = (value: unknown, status = 200) => new Response(JSON.stringify({ ok: true, value }), { status });
const page = (start = 201, count = 50, more = true) => envelope({
  messages: Array.from({ length: count }, (_, i) => row(start + i)), nextBeforeSeq: more ? start * 3 : null,
});
const settle = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>(yes => { resolve = yes; });
  return { resolve, promise };
}
function fixture() {
  const client = { signIn: jest.fn(async () => identity), signOut: jest.fn(async () => true), getCookie: jest.fn(async () => 'test=cookie') };
  const discovery = jest.fn(async () => envelope(context));
  const history = jest.fn(async (_request: Request) => page());
  const post = jest.fn(async () => envelope({}, 503));
  const controller = createSessionController({ mode: 'synthetic-loopback', baseURL: 'http://localhost:8787' }, client,
    request => new URL(request.url).pathname === '/v1/session/context' ? discovery() : request.method === 'POST' ? post() : history(request), () => uuid(9));
  return { controller, client, history, discovery, post, login: () => controller.signIn('synthetic@example.test', 'test') };
}
it('pages noncontiguous sequence numbers in order with fresh context and stops at the cap', async () => {
  const f = fixture(); await f.login(); f.controller.setDraft('kept');
  for (const start of [151, 101, 51]) { f.history.mockResolvedValueOnce(page(start)); await f.controller.loadOlder(); }
  expect(f.controller.getSnapshot().messages).toEqual(Array.from({ length: 200 }, (_, i) => row(i + 51)));
  expect(f.controller.getSnapshot().draft).toBe('kept');
  expect(f.discovery).toHaveBeenCalledTimes(4); expect(f.client.getCookie).toHaveBeenCalledTimes(4);
  expect(new URL(f.history.mock.calls[1][0].url).searchParams.get('beforeSeq')).toBe('603');
  await f.controller.loadOlder(); expect(f.history).toHaveBeenCalledTimes(4);
  f.history.mockResolvedValueOnce(page(400)); await f.controller.refresh();
  expect(f.controller.getSnapshot().messages).toEqual(Array.from({ length: 50 }, (_, i) => row(i + 400)));
  expect(f.controller.getSnapshot().history).toMatchObject({ status: 'ready', windowReset: true });
});
it('stops at end, ignores signed-out loads, and rejects cross-page command/id conflicts atomically', async () => {
  const f = fixture(); await f.controller.loadOlder(); expect(f.discovery).not.toHaveBeenCalled(); await f.login();
  f.history.mockResolvedValueOnce(envelope({ messages: [{ ...row(200), id: row(201).id }], nextBeforeSeq: null }));
  await f.controller.loadOlder(); expect(f.controller.getSnapshot().error).toBe('invalid_response');
  expect(f.controller.getSnapshot().messages).toHaveLength(50);
  f.history.mockResolvedValueOnce(page(200, 1, false)); await f.controller.loadOlder();
  expect(f.controller.getSnapshot().history).toMatchObject({ status: 'ready', nextBeforeSeq: null });
  await f.controller.loadOlder(); expect(f.history).toHaveBeenCalledTimes(3);
});
it.each(['history', 'context', 'cookie'] as const)('allows explicit retry after %s failure without losing cursor or draft', async where => {
  const f = fixture(); await f.login(); f.controller.setDraft('kept');
  if (where === 'history') f.history.mockRejectedValueOnce(new Error('offline'));
  if (where === 'context') f.discovery.mockResolvedValueOnce(envelope({}, 503));
  if (where === 'cookie') f.client.getCookie.mockRejectedValueOnce(new Error('offline'));
  await f.controller.loadOlder();
  expect(f.controller.getSnapshot()).toMatchObject({ draft: 'kept', history: { status: 'error', nextBeforeSeq: 603 } });
  f.history.mockResolvedValueOnce(page(151)); await f.controller.loadOlder();
  expect(f.controller.getSnapshot().messages).toHaveLength(100);
});
it('suppresses double taps and discards old history after refresh (>50 new messages)', async () => {
  const f = fixture(); await f.login(); const pending = deferred(); f.history.mockReturnValueOnce(pending.promise);
  const older = f.controller.loadOlder(); await settle(); await f.controller.loadOlder(); expect(f.history).toHaveBeenCalledTimes(2);
  f.history.mockResolvedValueOnce(page(400)); await f.controller.refresh();
  pending.resolve(page(151)); await older;
  expect(f.controller.getSnapshot().messages[0].seq).toBe(1200); expect(f.controller.getSnapshot().messages).toHaveLength(50);
});
it.each(['logout', 'dispose', 'account', 'pair', 'epoch', 'session', '401', '403'] as const)('does not hydrate old data after %s', async change => {
  const f = fixture(); await f.login(); f.controller.setDraft('private synthetic');
  if (change === 'logout' || change === 'dispose') {
    const pending = deferred(); f.history.mockReturnValueOnce(pending.promise);
    const older = f.controller.loadOlder(); await settle();
    if (change === 'logout') await f.controller.signOut(); else f.controller.dispose();
    pending.resolve(page(151)); await older;
  } else {
    const value = change === 'account' ? { ...context, userId: uuid(44) }
      : change === 'pair' ? { ...context, coupleId: uuid(44) }
      : change === 'epoch' ? { ...context, membershipEpoch: 2 }
      : change === 'session' ? { ...context, sessionId: 'other' } : context;
    f.discovery.mockResolvedValueOnce(envelope(value, change === '401' ? 401 : change === '403' ? 403 : 200));
    await f.controller.loadOlder(); expect(f.history).toHaveBeenCalledTimes(1);
  }
  expect(f.controller.getSnapshot().messages).toHaveLength(0); expect(f.controller.getSnapshot().draft).toBe('');
});
it.each([401, 403])('late same-generation history denial %s overrides newer refresh', async status => {
  const f = fixture(); await f.login(); const pending = deferred(); f.history.mockReturnValueOnce(pending.promise);
  const older = f.controller.loadOlder(); await settle(); await f.controller.refresh();
  pending.resolve(envelope({}, status)); await older; expect(f.controller.getSnapshot().phase).toBe('blocked');
});
it('a superseding context discovery prevents an older request and leaves retry state', async () => {
  const f = fixture(); await f.login(); const pending = deferred(); f.discovery.mockReturnValueOnce(pending.promise);
  const older = f.controller.loadOlder(); await settle(); await f.controller.refresh();
  pending.resolve(envelope(context)); await older; expect(f.history).toHaveBeenCalledTimes(2);
  expect(f.controller.getSnapshot().history?.status).toBe('ready');
});
it('refresh failure releases history lock for retry', async () => {
  const f = fixture(); await f.login(); f.history.mockRejectedValueOnce(new Error('offline')); await f.controller.refresh();
  expect(f.controller.getSnapshot().history?.status).toBe('error');
  f.history.mockResolvedValueOnce(page(151)); await f.controller.loadOlder(); expect(f.controller.getSnapshot().messages).toHaveLength(100);
});
it('unions deterministically, deduplicates identical records, rejects every conflicting identity field and cap overflow', () => {
  expect(mergeHistory([row(2)], [row(1), row(2)])).toEqual([row(1), row(2)]);
  for (const change of [{ seq: 99 }, { coupleId: uuid(88) }, { senderId: uuid(88) }, { clientId: uuid(88) },
    { body: 'changed' }, { version: 2 }, { createdAt: '2026-11-11T00:00:00Z' }]) {
    expect(mergeHistory([row(1)], [{ ...row(1), ...change }])).toBeNull();
  }
  expect(mergeHistory([row(1)], [{ ...row(2), seq: 3 }])).toBeNull();
  expect(mergeHistory([row(1)], [{ ...row(2), clientId: row(1).clientId }])).toBeNull();
  expect(mergeHistory([], Array.from({ length: 201 }, (_, i) => row(i + 1)))).toBeNull();
});

it('preserves unresolved outgoing and edits while loading older; successful send supersedes older load', async () => {
  const f = fixture(); await f.login(); f.controller.setDraft('original'); await f.controller.send();
  f.controller.setDraft('edited'); f.history.mockResolvedValueOnce(page(151)); await f.controller.loadOlder();
  expect(f.controller.getSnapshot()).toMatchObject({ draft: 'edited', outgoing: { body: 'original', status: 'retry' } });
  const pending = deferred(); f.history.mockReturnValueOnce(pending.promise);
  const older = f.controller.loadOlder(); await settle();
  f.post.mockResolvedValueOnce(envelope({ message: { ...row(300), clientId: uuid(9), body: 'original' }, replay: true }));
  f.history.mockResolvedValueOnce(page(251)); await f.controller.send();
  pending.resolve(page(101)); await older;
  expect(f.controller.getSnapshot()).toMatchObject({ draft: 'edited', outgoing: { status: 'sent' }, history: { status: 'ready' } });
  expect(f.controller.getSnapshot().messages).toHaveLength(50);
  expect(f.controller.getSnapshot().messages[0].seq).toBe(753);
});
it('new cookie snapshot is bound before older request; missing cookie clears private state', async () => {
  const f = fixture(); await f.login(); f.client.getCookie.mockResolvedValueOnce('test=rotated');
  f.history.mockResolvedValueOnce(page(151)); await f.controller.loadOlder();
  expect(f.history.mock.calls[1][0].headers.get('cookie')).toBe('test=rotated');
  f.client.getCookie.mockResolvedValueOnce(''); await f.controller.loadOlder();
  expect(f.controller.getSnapshot().messages).toHaveLength(0); expect(f.history).toHaveBeenCalledTimes(2);
});
