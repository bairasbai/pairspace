import { fixture, own, incoming, told, removed, declined, uuid, context, ack, list, detail, error, envelope, settle, deferred, prose } from './stories-fixtures';

it('requires explicit complete history before topic publication; metadata ACK is not a fresh snapshot', async () => {
  const f = fixture(), notify = jest.fn(), stop = f.api.subscribe(notify);
  f.controller.sync(); expect(notify).not.toHaveBeenCalled();
  await f.api.order(); expect(f.api.getSnapshot().requiresRefresh).toBe(true);
  await f.load(); await f.api.order();
  expect(f.api.getSnapshot()).toMatchObject({ stories: [own], checked: false, used: 1, status: 'saved', topicDraft: '', checkedAt: '2026-11-11T00:00:00.000Z' });
  expect(await f.operation.mock.calls[1][0].json()).toEqual({ command_id: uuid(3), membership_epoch: 1, topic: own.topic });
  expect(f.operation.mock.calls[1][0].cache).toBe('no-store');
  stop(); f.controller.reset(); f.api.setTopic('ignored'); f.api.setStory('ignored'); f.api.beginStory(incoming.id);
  await f.api.order(); await f.api.load(); await f.api.retry(); await f.api.open(told.id); f.set(null); f.controller.sync();
  expect(f.api.getSnapshot().available).toBe(false);
});
it('retries immutable long narrative after unknown ACK while preserving newer RAM', async () => {
  const f = fixture(); await f.load([incoming]); f.api.beginStory(incoming.id);
  const original = '🦉'.repeat(8000); f.api.setStory(original);
  const gate = deferred(); f.operation.mockReturnValueOnce(gate.promise);
  const work = f.api.tell(); await settle();
  await f.api.tell(); await f.api.load(); await f.api.retry();
  f.api.setStory('Newer unsaved narrative'); f.api.setTopic('Separate newer topic');
  gate.resolve(error('temporary', 503)); await work;
  const originalRequest = await f.operation.mock.calls[1][0].json();
  f.operation.mockResolvedValueOnce(ack(told, true)); await f.api.retry();
  expect(await f.operation.mock.calls[2][0].json()).toEqual(originalRequest);
  expect(originalRequest.body).toBe(original); expect(f.command).toHaveBeenCalledTimes(1);
  expect(f.api.getSnapshot()).toMatchObject({ pending: false, storyDraft: { text: 'Newer unsaved narrative', stale: 'terminal' }, topicDraft: 'Separate newer topic' });
  const calls = f.operation.mock.calls.length; await f.api.tell(); f.api.beginStory(incoming.id); expect(f.operation).toHaveBeenCalledTimes(calls);
  f.api.cancelStory(); f.api.cancelTopic(); expect(f.api.getSnapshot()).toMatchObject({ storyDraft: null, topicDraft: '' });
});
it('does not overwrite a nonempty long-form draft when another topic is selected', async () => {
  const f = fixture(), second = { ...incoming, id: uuid(22), sequence: 2 }; await f.load([second, incoming]);
  f.api.beginStory(incoming.id); f.api.setStory('Unsaved long-form work'); f.api.beginStory(second.id);
  expect(f.api.getSnapshot().storyDraft).toMatchObject({ id: incoming.id, text: 'Unsaved long-form work' });
  f.api.cancelStory(); f.api.beginStory(second.id); expect(f.api.getSnapshot().storyDraft?.id).toBe(second.id);
});
it('recipient-only tell and separately confirmed decline/removals preserve authorship', async () => {
  const f = fixture(); await f.load([own]); f.api.beginStory(own.id); await f.api.tell(); await f.api.decline(own.id, true); await f.api.removeStory(own.id, true);
  expect(f.operation).toHaveBeenCalledTimes(1);
  const g = fixture(); await g.load([incoming]); g.api.beginStory(incoming.id); await g.api.tell(); expect(g.api.getSnapshot().status).toBe('invalid');
  await g.api.decline(incoming.id, false); await g.api.removeTopic(incoming.id, true);
  g.operation.mockResolvedValueOnce(ack(declined)); await g.api.decline(incoming.id, true);
  expect(g.api.getSnapshot()).toMatchObject({ stories: [declined], storyDraft: null });
  await g.api.decline(incoming.id, true); expect(g.operation).toHaveBeenCalledTimes(2);
  const h = fixture(); await h.load([told]); await h.api.removeStory(told.id, false);
  h.operation.mockResolvedValueOnce(ack(removed)); await h.api.removeStory(told.id, true);
  expect(h.api.getSnapshot().stories).toEqual([removed]); expect(h.operation.mock.calls[1][0].method).toBe('DELETE');
  const k = fixture(); await k.load([own]);
  const withdrawn = { ...own, topicState: 'removed', storyState: 'withdrawn', version: 2 };
  delete withdrawn.topic; k.operation.mockResolvedValueOnce(ack(withdrawn)); await k.api.removeTopic(own.id, true);
  expect(k.api.getSnapshot().stories[0]).not.toHaveProperty('topic');
});
it('opens only one explicit body, closes it, and full metadata refresh alone never fetches it', async () => {
  const f = fixture(); await f.load([told]); expect(f.api.getSnapshot().opened).toBeNull();
  f.operation.mockResolvedValueOnce(detail()); await f.api.open(told.id);
  expect(f.api.getSnapshot()).toMatchObject({ opened: { body: prose, story: told }, checked: false, readerStatus: 'opened' });
  const r = f.operation.mock.calls[1][0]; expect(r.method).toBe('GET'); expect(r.url).toContain('/text?membership_epoch=1'); expect(r.cache).toBe('no-store');
  await f.load([told]); expect(f.api.getSnapshot().opened?.body).toBe(prose);
  f.api.close(); expect(f.api.getSnapshot().opened).toBeNull();
  await f.api.open('missing'); expect(f.operation).toHaveBeenCalledTimes(3);
});
it('close invalidates in-flight detail even when same record/version remains told', async () => {
  const f = fixture(); await f.load([told]); const gate = deferred(); f.operation.mockReturnValueOnce(gate.promise);
  const work = f.api.open(told.id); await settle(); f.api.close();
  expect(f.operation.mock.calls[1][0].signal.aborted).toBe(true);
  gate.resolve(detail()); await work;
  expect(f.api.getSnapshot()).toMatchObject({ opened: null, readerStatus: 'closed', busy: false });
});
it('opening B invalidates late A and a late completion cannot close or replace B', async () => {
  const f = fixture(), second = { ...told, id: uuid(22), sequence: 2 }; await f.load([second, told]);
  const a = deferred(), b = deferred(); f.operation.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
  const first = f.api.open(told.id); await settle(); const next = f.api.open(second.id); await settle();
  b.resolve(detail(second, 'Story B')); await next; a.resolve(detail(told, 'Story A')); await first;
  expect(f.api.getSnapshot()).toMatchObject({ opened: { story: second, body: 'Story B' }, readerStatus: 'opened', busy: false });
});
it('newer detail merges only canonical metadata, discards body and needs explicit reopen', async () => {
  const f = fixture(); await f.load([told]); const newer = { ...told, topicState: 'removed' as const, version: 3 }; delete newer.topic;
  f.operation.mockResolvedValueOnce(detail(newer)); await f.api.open(told.id);
  expect(f.api.getSnapshot()).toMatchObject({ stories: [newer], opened: null, readerStatus: 'changed', checked: false });
  f.operation.mockResolvedValueOnce(detail(newer)); await f.api.open(told.id); expect(f.api.getSnapshot().opened?.body).toBe(prose);
  await f.load([{ ...removed, topicState: 'removed', version: 4, topic: null }]); // Explicit null is not field absence.
  expect(f.api.getSnapshot().stories).toEqual([newer]);
  const terminal = { ...removed, topicState: 'removed' as const, version: 4 }; delete terminal.topic;
  f.operation.mockResolvedValueOnce(envelope({ story: terminal, checkedAt: '2026-11-11T00:00:00.000Z' })); await f.api.open(told.id);
  expect(f.api.getSnapshot()).toMatchObject({ stories: [terminal], opened: null, readerStatus: 'changed' });
  const calls = f.operation.mock.calls.length; await f.api.open(told.id); expect(f.operation).toHaveBeenCalledTimes(calls);
});
it('partial ACK can have sequence gap; next full GET must contain every row and fence old metadata', async () => {
  const f = fixture(); await f.load([own]); f.api.setTopic('A new topic');
  const third = { ...own, id: uuid(30), sequence: 3, topic: 'A new topic' }; f.operation.mockResolvedValueOnce(ack(third)); await f.api.order();
  expect(f.api.getSnapshot()).toMatchObject({ used: 3, checked: false, stories: [third, own] });
  await f.load([third, own]); expect(f.api.getSnapshot()).toMatchObject({ error: true, checked: false });
  const second = { ...own, id: uuid(20), sequence: 2 }; await f.load([third, second, own]); expect(f.api.getSnapshot().checked).toBe(true);
  await f.load([second, own]); expect(f.api.getSnapshot().stories).toEqual([third, second, own]);
});
it('scope/reset/cookie/context changes discard private RAM and late detail', async () => {
  const f = fixture(); await f.load([told]); const gate = deferred(); f.operation.mockReturnValueOnce(gate.promise);
  const work = f.api.open(told.id); await settle(); f.set(null); f.controller.sync(); gate.resolve(detail()); await work;
  expect(f.api.getSnapshot()).toMatchObject({ available: false, opened: null, topicDraft: '', pending: false });
  const g = fixture(); await g.load([incoming]); g.api.beginStory(incoming.id); g.api.setStory('Private');
  g.host.getCookie.mockResolvedValueOnce('synthetic=cookie').mockResolvedValueOnce('changed'); await g.api.tell();
  expect(g.host.block).toHaveBeenCalledWith('auth_required'); expect(g.api.getSnapshot().storyDraft).toBeNull();
  const h = fixture(); h.discovery.mockResolvedValueOnce(envelope({ ...context, membershipEpoch: 2 })); await h.api.load();
  expect(h.host.refresh).toHaveBeenCalled(); expect(h.api.getSnapshot().available).toBe(false);
});
it('canonical retry can settle after body removal without refetching/resurrecting text; cancel is not undo', async () => {
  const f = fixture(); await f.load([incoming]); f.api.beginStory(incoming.id); f.api.setStory('Original');
  f.operation.mockRejectedValueOnce(Error('offline')); await f.api.tell(); f.api.cancelStory();
  f.operation.mockResolvedValueOnce(ack(removed, true)); await f.api.retry();
  expect(f.api.getSnapshot()).toMatchObject({ stories: [removed], opened: null, pending: false, storyDraft: null, status: 'saved' });
});
it('rejects metadata body leaks, malformed detail, stale versions and bounded streamed output', async () => {
  for (const value of [
    { ...told, body: prose }, { ...told, toldAt: 'bad' }, { ...told, topic: ' changed ' },
  ]) { const f = fixture(); await f.load([value]); expect(f.api.getSnapshot().checked).toBe(false); }
  const f = fixture(); await f.load([told]);
  for (const bad of [detail(told, ''), detail(told, 'x'.repeat(8001)), detail({ ...told, id: uuid(99) }), detail(told, prose, '2026-01-01T00:00:00.000Z'),
    envelope({ story: told, checkedAt: '2026-11-11T00:00:00.000Z', body: prose, preview: 'extra' }), detail(incoming, prose)]) {
    f.operation.mockResolvedValueOnce(bad); await f.api.open(told.id); expect(f.api.getSnapshot()).toMatchObject({ opened: null, readerStatus: 'error' });
  }
  f.operation.mockResolvedValueOnce(new Response('x'.repeat(65537), { headers: { 'content-length': '1' } })); await f.api.open(told.id);
  expect(f.api.getSnapshot().opened).toBeNull();
  f.api.setTopic('order'); const g = fixture(); await g.load(); g.operation.mockResolvedValueOnce(envelope({ story: own, commandId: uuid(3), replay: false, body: prose })); await g.api.order();
  expect(g.api.getSnapshot()).toMatchObject({ pending: true, status: 'retry' });
});
it('handles explicit conflicts/auth failures/invalid responses without silent automatic retries', async () => {
  for (const code of ['version_conflict', 'idempotency_conflict', 'capacity_reached']) {
    const f = fixture(); await f.load(); f.operation.mockResolvedValueOnce(error(code, 409)); await f.api.order();
    expect(f.api.getSnapshot()).toMatchObject({ pending: false, requiresRefresh: true, status: code === 'capacity_reached' ? 'limit' : 'conflict' });
  }
  const f = fixture(); await f.load(); f.operation.mockResolvedValueOnce(error('invalid_request', 400)); await f.api.order(); expect(f.api.getSnapshot().status).toBe('invalid');
  const g = fixture(); await g.load(); g.operation.mockResolvedValueOnce(error('stale_membership', 409)); await g.api.order(); expect(g.host.block).toHaveBeenCalledWith('access_required');
  for (const status of [401, 403]) { const h = fixture(); h.operation.mockResolvedValueOnce(error('denied', status)); await h.api.load(); expect(h.api.getSnapshot().available).toBe(false); }
  const k = fixture(); k.operation.mockResolvedValueOnce(error('not_found', 404)); await k.api.load(); expect(k.api.getSnapshot().status).toBe('unavailable');
  k.discovery.mockResolvedValueOnce(error('denied', 401)); await k.api.load(); expect(k.host.block).toHaveBeenCalledWith('auth_required');
  const m = fixture(); m.discovery.mockRejectedValueOnce(Error('offline')); await m.api.load(); expect(m.api.getSnapshot().error).toBe(true);
});
