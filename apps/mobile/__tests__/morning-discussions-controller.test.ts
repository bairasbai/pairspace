import { available, deferred, envelope, fixture, id, message, scope } from './morning-discussions.fixture';
import { slot } from './mornings.fixture';

it('navigates all 71 responses in bounded windows without creating/opening a letter', async () => {
  const f = fixture(), a = f.actions;
  await a.open(available());
  expect(a.getSnapshot().messages.map(m => m.seq)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
  a.setDraft('private\nresponse');
  await a.newer(); expect(a.getSnapshot().messages[0].seq).toBe(31);
  await a.newer(); expect(a.getSnapshot().messages.at(-1)!.seq).toBe(71);
  await a.newer(); expect(f.read).toHaveBeenCalledTimes(3);
  await a.older(); expect(a.getSnapshot().messages.at(-1)!.seq).toBe(60);
  await a.last(); expect(a.getSnapshot().messages[0].seq).toBe(42);
  await a.first(); await a.older();
  expect(a.getSnapshot().draft).toBe('private\nresponse');
  expect(f.write).not.toHaveBeenCalled();
  expect(a.getSnapshot().messages).toHaveLength(30);
});
it('requires eligible metadata, both actors can explicitly send, no automatic page injection', async () => {
  const f = fixture(), a = f.actions;
  await a.open(slot()); await a.open({ ...available(10, true), openedAt: null });
  expect(f.read).not.toHaveBeenCalled();
  await a.open(available(10, true)); a.setDraft('Hello\r\nworld');
  await a.send();
  expect(await f.write.mock.calls[0][0].clone().json()).toEqual({ membership_epoch: 1, command_id: id(3000), body: 'Hello\nworld' });
  expect(a.getSnapshot()).toMatchObject({ status: 'sent', draft: '', pendingId: undefined, history: null });
  expect(a.getSnapshot().messages).toHaveLength(30);
  expect(f.read).toHaveBeenCalledTimes(1);
});
it('unknown A retry stays exact while B and a newer draft remain selected', async () => {
  const f = fixture(), a = f.actions;
  await a.open(available()); a.setDraft('A');
  f.write.mockRejectedValueOnce(Error('lost'));
  await a.send(); expect(a.getSnapshot().status).toBe('unknown');
  await a.open(available(11)); a.setDraft('B');
  await a.send(); expect(f.write).toHaveBeenCalledTimes(1);
  await a.retry();
  expect(await f.write.mock.calls[0][0].clone().text()).toBe(await f.write.mock.calls[1][0].clone().text());
  expect(f.write.mock.calls[1][0].url).toContain(`/slots/${id(10)}/discussion-v2`);
  expect(a.getSnapshot()).toMatchObject({ slot: { id: id(11) }, draft: 'B', pendingId: undefined });
  a.selectDraft(id(11)); a.clearDraft(); expect(a.getSnapshot().savedDraftSlots).toEqual([]);
});
it('held ACK preserves newer same-slot draft and late ACK after logout has no effects', async () => {
  const f = fixture(), a = f.actions, held = deferred();
  await a.open(available()); a.setDraft('old'); f.write.mockImplementationOnce(() => held.promise);
  const sending = a.send();
  while (!f.write.mock.calls.length) await Promise.resolve();
  a.setDraft('new');
  held.resolve(envelope({ commandId: id(3000), replay: false, message: { ...message(72), clientId: id(3000), body: 'old' } }));
  await sending; expect(a.getSnapshot().draft).toBe('new');
  const late = deferred(); f.write.mockImplementationOnce(() => late.promise); const send2 = a.send();
  while (f.write.mock.calls.length < 2) await Promise.resolve();
  f.setCapture(null); late.resolve(envelope({ commandId: id(3001), replay: false, message: { ...message(73), clientId: id(3001), body: 'new' } }));
  await send2; expect(a.getSnapshot()).toMatchObject({ available: false, draft: '', messages: [] });
});
it('stale same-session denial still blocks, old-account denial cannot block new account', async () => {
  const f = fixture(), a = f.actions, held = deferred();
  f.read.mockImplementationOnce(() => held.promise); const opening = a.open(available());
  while (!f.read.mock.calls.length) await Promise.resolve();
  const readId = new URL(f.read.mock.calls[0][0].url).searchParams.get('read_id');
  a.close(); held.resolve(new Response(JSON.stringify({ ok: false, error: 'unavailable', readId }), { status: 403 }));
  await opening; expect(f.host.block).toHaveBeenCalledWith('access_required');
  const g = fixture(), late = deferred(); g.read.mockImplementationOnce(() => late.promise);
  const old = g.actions.open(available()); while (!g.read.mock.calls.length) await Promise.resolve();
  const nonce = new URL(g.read.mock.calls[0][0].url).searchParams.get('read_id');
  g.setCapture({ generation: 2, identity: { userId: 'new-provider', sessionId: 'session' }, context: scope });
  late.resolve(new Response(JSON.stringify({ ok: false, error: 'unavailable', readId: nonce }), { status: 403 }));
  await old; expect(g.host.block).not.toHaveBeenCalled(); expect(g.actions.getSnapshot().available).toBe(true);
});
it('refuses the 31st new draft, preserves prior drafts and allows explicit clear', async () => {
  const f = fixture(), a = f.actions;
  for (let n = 10; n < 40; n++) { await a.open(available(n)); a.setDraft(`draft${n}`); }
  await a.open(available(40)); a.setDraft('overflow');
  expect(a.getSnapshot()).toMatchObject({ draft: '', error: 'draft_limit' });
  a.selectDraft(id(10)); expect(a.getSnapshot().draft).toBe('draft10');
  a.clearDraft(); await a.open(available(40)); a.setDraft('now fits');
  expect(a.getSnapshot().savedDraftSlots).toHaveLength(30);
  expect(a.getSnapshot().draft).toBe('now fits');
});
it('rejects forged ACK and contradictory immutable page without poisoning the valid view', async () => {
  const f = fixture(), a = f.actions;
  await a.open(available()); const prior = a.getSnapshot().messages;
  f.read.mockImplementationOnce(async request => envelope({ ...a.getSnapshot().history,
    readId: new URL(request.url).searchParams.get('read_id'), messages: [{ ...message(), body: 'forged' }, ...prior.slice(1)] }));
  await a.first(); expect(a.getSnapshot().messages).toBe(prior); expect(a.getSnapshot().error).toBe('invalid_response');
  a.setDraft('own'); f.write.mockImplementationOnce(async () => envelope({ commandId: id(3000), replay: true,
    message: { ...message(72), clientId: id(3000), body: 'wrong' } }));
  await a.send(); expect(a.getSnapshot()).toMatchObject({ status: 'unknown', draft: 'own', pendingId: id(3000) });
  await a.retry(); expect(a.getSnapshot().status).toBe('sent');
});
