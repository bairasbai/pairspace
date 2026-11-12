import { mergeHistory } from '../src/chat/history';
import { fixture, row, uuid, context, envelope, settle, deferred, windowResponse } from './chat-window.fixture';
it('navigates all 251 messages through fifty-row windows with both actual anchor fields, preserving draft', async () => {
  const f = fixture(); await f.login(); f.controller.setDraft('kept');
  expect(f.controller.getSnapshot().messages[0]).toEqual(row(202));
  for (const start of [152, 102, 52, 2, 1]) { await f.controller.loadOlder(); expect(f.controller.getSnapshot().messages[0]).toEqual(row(start)); expect(f.controller.getSnapshot().messages.length).toBeLessThanOrEqual(50); }
  const count = f.history.mock.calls.length; await f.controller.loadOlder(); expect(f.history).toHaveBeenCalledTimes(count);
  await f.controller.loadNewer(); expect(f.controller.getSnapshot().messages[0]).toEqual(row(2));
  await f.controller.loadOldest(); expect(f.controller.getSnapshot().messages).toEqual(Array.from({ length: 50 }, (_, i) => row(i + 1)));
  await f.controller.loadLatest(); expect(f.controller.getSnapshot().messages.at(-1)).toEqual(row(251));
  expect(f.controller.getSnapshot().draft).toBe('kept');
  const query = new URL(f.history.mock.calls[1][0].url).searchParams;
  expect(query.get('anchor_seq')).toBe(String(row(202).seq)); expect(query.get('anchor_id')).toBe(row(202).id);
  expect(new Set(f.history.mock.calls.map(([r]) => new URL(r.url).searchParams.get('read_id'))).size).toBe(f.history.mock.calls.length);
});
it('stops at end, refuses signed-out actions and rejects cross-window immutable conflicts atomically', async () => {
  const f = fixture(); await f.controller.loadOlder(); await f.controller.loadNewer(); await f.controller.loadOldest(); expect(f.discovery).not.toHaveBeenCalled(); await f.login();
  f.history.mockImplementationOnce(async r => { const json = await windowResponse(r).json(); json.value.messages[0].id = row(202).id; return envelope(json.value); });
  await f.controller.loadOlder(); expect(f.controller.getSnapshot().error).toBe('invalid_response'); expect(f.controller.getSnapshot().messages[0]).toEqual(row(202));
  await f.controller.loadOldest(); expect(f.controller.getSnapshot().history?.nextBeforeSeq).toBeNull();
});
it.each(['history', 'context', 'cookie'] as const)('retries after %s failure without losing cursor/draft', async where => {
  const f = fixture(); await f.login(); f.controller.setDraft('kept');
  if (where === 'history') f.history.mockRejectedValueOnce(Error('offline'));
  if (where === 'context') f.discovery.mockResolvedValueOnce(envelope({}, 503));
  if (where === 'cookie') f.client.getCookie.mockRejectedValueOnce(Error('offline'));
  await f.controller.loadOlder(); expect(f.controller.getSnapshot()).toMatchObject({ draft: 'kept', history: { status: 'error', nextBeforeSeq: row(202).seq } });
  await f.controller.loadOlder(); expect(f.controller.getSnapshot().messages[0]).toEqual(row(152));
});
it('double taps suppressed, refresh supersedes pending success and old nonce denial cannot affect state', async () => {
  const f = fixture(); await f.login(); const pending = deferred(); f.history.mockReturnValueOnce(pending.promise);
  const older = f.controller.loadOlder(); await settle(); await f.controller.loadOlder(); expect(f.history).toHaveBeenCalledTimes(2);
  await f.controller.refresh(); pending.resolve(windowResponse(f.history.mock.calls[1][0])); await older;
  expect(f.controller.getSnapshot().messages[0]).toEqual(row(202));
  f.history.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: 'unavailable', readId: uuid(777) }), { status: 403 }));
  await f.controller.loadOlder(); expect(f.controller.getSnapshot().phase).toBe('signed_in');
});
it.each(['logout','dispose','account','pair','epoch','session','401','403'] as const)('never hydrates old data after %s', async change => {
  const f = fixture(); await f.login(); f.controller.setDraft('private');
  if (change === 'logout' || change === 'dispose') {
    const pending = deferred(); f.history.mockReturnValueOnce(pending.promise); const older = f.controller.loadOlder(); await settle();
    if (change === 'logout') await f.controller.signOut(); else f.controller.dispose();
    pending.resolve(windowResponse(f.history.mock.calls[1][0])); await older;
  } else {
    const value = change === 'account' ? { ...context, userId: uuid(44) } : change === 'pair' ? { ...context, coupleId: uuid(44) }
      : change === 'epoch' ? { ...context, membershipEpoch: 2 } : change === 'session' ? { ...context, sessionId: 'other' } : context;
    f.discovery.mockResolvedValueOnce(envelope(value, change === '401' ? 401 : change === '403' ? 403 : 200)); await f.controller.loadOlder(); expect(f.history).toHaveBeenCalledTimes(1);
  }
  expect(f.controller.getSnapshot().messages).toHaveLength(0); expect(f.controller.getSnapshot().draft).toBe('');
});
it.each([401,403])('same-generation nonce-bound denial %s overrides newer navigation, old account denial does not', async status => {
  const f = fixture(); await f.login(); const pending = deferred(); f.history.mockReturnValueOnce(pending.promise);
  const older = f.controller.loadOlder(); await settle(); const readId = new URL(f.history.mock.calls[1][0].url).searchParams.get('read_id'); await f.controller.refresh();
  pending.resolve(new Response(JSON.stringify({ ok: false, error: 'unavailable', readId }), { status })); await older; expect(f.controller.getSnapshot().phase).toBe('blocked');
  await f.controller.signOut(); await f.login(); const late = deferred(); f.history.mockReturnValueOnce(late.promise); const load = f.controller.loadOlder(); await settle();
  const oldRead = new URL(f.history.mock.calls.at(-1)![0].url).searchParams.get('read_id'); await f.controller.signOut(); await f.login(); f.controller.setDraft('new account draft');
  late.resolve(new Response(JSON.stringify({ ok: false, error: 'unavailable', readId: oldRead }), { status })); await load;
  expect(f.controller.getSnapshot()).toMatchObject({ phase: 'signed_in', draft: 'new account draft' });
});
it('superseded discovery and failed refresh release navigation lock; cookie change clears private data', async () => {
  const f = fixture(); await f.login(); const pending = deferred(); f.discovery.mockReturnValueOnce(pending.promise);
  const older = f.controller.loadOlder(); await settle(); await f.controller.refresh(); pending.resolve(envelope(context)); await older;
  expect(f.history).toHaveBeenCalledTimes(2); f.history.mockRejectedValueOnce(Error()); await f.controller.refresh(); await f.controller.loadOlder(); expect(f.controller.getSnapshot().messages[0]).toEqual(row(152));
  f.client.getCookie.mockResolvedValueOnce('rotated').mockResolvedValueOnce('different'); await f.controller.loadOlder(); expect(f.controller.getSnapshot().phase).toBe('blocked');
});
it('unknown send retries original command; successful ACK leaves navigated window/newdraft intact until explicit Latest', async () => {
  const f = fixture(); await f.login(); f.controller.setDraft('original'); await f.controller.send(); f.controller.setDraft('edited'); await f.controller.loadOlder();
  expect(f.controller.getSnapshot()).toMatchObject({ draft: 'edited', outgoing: { body: 'original', status: 'retry' } });
  const pending = deferred(); f.history.mockReturnValueOnce(pending.promise); const older = f.controller.loadOlder(); await settle();
  f.post.mockResolvedValueOnce(envelope({ message: { ...row(300), clientId: uuid(9), body: 'original' }, replay: true })); await f.controller.send();
  pending.resolve(windowResponse(f.history.mock.calls.at(-1)![0])); await older;
  expect(f.controller.getSnapshot()).toMatchObject({ draft: 'edited', outgoing: { status: 'sent' } }); expect(f.controller.getSnapshot().messages[0]).toEqual(row(102));
  expect(await f.post.mock.calls[0][0].clone().text()).toBe(await f.post.mock.calls[1][0].clone().text());
  await f.controller.loadLatest(); expect(f.controller.getSnapshot().messages[0]).toEqual(row(202));
});
it('invalid cursor preserves current window but disables anchors until explicit Latest', async () => {
  const f = fixture(); await f.login(); f.history.mockImplementationOnce(async r => new Response(JSON.stringify({ ok: false, error: 'invalid_cursor', readId: new URL(r.url).searchParams.get('read_id') }), { status: 400 }));
  await f.controller.loadOlder(); expect(f.controller.getSnapshot().messages).toHaveLength(50); expect(f.controller.getSnapshot().history).toMatchObject({ nextBeforeSeq: null, nextAfterSeq: null, status: 'error' });
  const n = f.history.mock.calls.length; await f.controller.loadOlder(); await f.controller.loadNewer(); expect(f.history).toHaveBeenCalledTimes(n); await f.controller.loadLatest(); expect(f.controller.getSnapshot().history?.status).toBe('ready');
});
it('legacy merge remains deterministic with unchanged identity guards and old bound', () => {
  expect(mergeHistory([row(2)], [row(1),row(2)])).toEqual([row(1),row(2)]);
  for (const change of [{seq:99},{coupleId:uuid(88)},{senderId:uuid(88)},{clientId:uuid(88)},{body:'changed'},{version:2},{createdAt:'2026-11-11T00:00:00Z'}]) expect(mergeHistory([row(1)],[{...row(1),...change}])).toBeNull();
  expect(mergeHistory([row(1)],[{...row(2),seq:3}])).toBeNull(); expect(mergeHistory([row(1)],[{...row(2),clientId:row(1).clientId}])).toBeNull();
  expect(mergeHistory([],Array.from({length:201},(_,i)=>row(i+1)))).toBeNull();
});
it('a nonce-bound stale membership response scrubs current private scope', async () => {
  const f = fixture(); await f.login(); f.controller.setDraft('private');
  f.history.mockImplementationOnce(async r => new Response(JSON.stringify({ ok: false, error: 'stale_membership', readId: new URL(r.url).searchParams.get('read_id') }), { status: 409 }));
  await f.controller.loadOlder(); expect(f.controller.getSnapshot()).toEqual({ phase: 'blocked', error: 'access_required', draft: '', messages: [] });
});
