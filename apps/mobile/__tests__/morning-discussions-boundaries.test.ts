import { fixture, available, message, id, scope, envelope, deferred } from './morning-discussions.fixture';
const tickUntil = async (test: () => boolean) => { for (let i = 0; i < 50 && !test(); i++) await Promise.resolve(); expect(test()).toBe(true); };
function error(request: Request, code: string, status: number, nonce?: string) {
  return new Response(JSON.stringify({ ok: false, error: code, readId: nonce ?? new URL(request.url).searchParams.get('read_id') }), { status });
}
function page(request: Request, messages = [message()]) {
  return envelope({ readId: new URL(request.url).searchParams.get('read_id'), slotId: id(10), messages,
    hasPrevious: false, hasNext: false, previousCursor: null, nextCursor: null });
}
test.each([401, 403, 409])('same-account denial %i clears state; wrong nonce cannot deny', async status => {
  const f = fixture(); f.read.mockImplementationOnce(async r => error(r, 'stale_membership', status));
  await f.actions.open(available()); expect(f.host.block).toHaveBeenCalledWith(status === 401 ? 'auth_required' : 'access_required');
  expect(f.actions.getSnapshot().available).toBe(false);
  const g = fixture(); g.read.mockImplementationOnce(async r => error(r, 'unavailable', status, id(900)));
  await g.actions.open(available()); expect(g.host.block).not.toHaveBeenCalled(); expect(g.actions.getSnapshot().error).toBe('invalid_response');
});
test('cookie and verified context guard discussion reads', async () => {
  const f = fixture(); f.host.getCookie.mockRejectedValueOnce(Error('unavailable'));
  await f.actions.open(available()); expect(f.actions.getSnapshot().error).toBe('transport_error'); expect(f.read).not.toHaveBeenCalled();
  f.host.getCookie.mockResolvedValueOnce('old').mockResolvedValueOnce('new'); await f.actions.first();
  expect(f.host.block).toHaveBeenCalledWith('auth_required');
  const g = fixture(); g.request.mockImplementation(async r => r.url.endsWith('/context') ? envelope({ ...scope, membershipEpoch: 2 }) : g.read(r));
  await g.actions.open(available()); expect(g.host.refresh).toHaveBeenCalled(); expect(g.read).not.toHaveBeenCalled();
});
test.each([false, true])('late read success after close/reset=%s is ignored', async reset => {
  const f = fixture(), held = deferred(); f.read.mockReturnValueOnce(held.promise);
  const running = f.actions.open(available()); await tickUntil(() => f.read.mock.calls.length === 1);
  if (reset) f.setCapture(null); else f.actions.close();
  held.resolve(page(f.read.mock.calls[0][0])); await running;
  expect(f.actions.getSnapshot().messages).toEqual([]); expect(f.actions.getSnapshot().slot).toBeNull();
});
test('malformed or conflicting later row never partially replaces existing messages', async () => {
  const f = fixture(); await f.actions.open(available()); const original = f.actions.getSnapshot().messages;
  f.read.mockImplementationOnce(async r => page(r, [message(), { ...message(2), body: 'forged replacement' }]));
  await f.actions.first(); expect(f.actions.getSnapshot().error).toBe('invalid_response'); expect(f.actions.getSnapshot().messages).toEqual(original);
  f.read.mockImplementationOnce(async r => page(r, [message(), { ...message(2), authorId: id(999) }]));
  await f.actions.first(); expect(f.actions.getSnapshot().messages).toEqual(original);
});
test('invalid cursor removes stale navigation, explicit first restores it', async () => {
  const f = fixture(); await f.actions.open(available()); f.actions.setDraft('keep');
  f.read.mockImplementationOnce(async r => error(r, 'invalid_cursor', 400)); await f.actions.newer();
  expect(f.actions.getSnapshot().history).toBeNull(); expect(f.actions.getSnapshot().draft).toBe('keep');
  const calls = f.read.mock.calls.length; await f.actions.newer(); await f.actions.older(); expect(f.read).toHaveBeenCalledTimes(calls);
  await f.actions.first(); expect(f.actions.getSnapshot().history).not.toBeNull();
});
test.each(['invalid_request', 'idempotency_conflict'])('definitive %s preserves current B and both private drafts', async code => {
  const f = fixture(); await f.actions.open(available()); f.actions.setDraft('A');
  f.write.mockRejectedValueOnce(Error('unknown')); await f.actions.send();
  const original = await f.write.mock.calls[0][0].clone().json();
  await f.actions.open(available(11)); f.actions.setDraft('B');
  f.write.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: code }), { status: 409 })); await f.actions.retry();
  expect(await f.write.mock.calls[1][0].clone().json()).toEqual(original);
  expect(f.actions.getSnapshot().slot?.id).toBe(id(11)); expect(f.actions.getSnapshot().draft).toBe('B');
  expect(f.actions.getSnapshot().pendingId).toBeUndefined(); f.actions.selectDraft(id(10)); expect(f.actions.getSnapshot().draft).toBe('A');
});
test('unknown replay malformed ACK preserves command; valid exact retry clears only old draft', async () => {
  const f = fixture(); await f.actions.open(available()); f.actions.setDraft('original');
  f.write.mockImplementationOnce(async r => { const input = await r.clone().json(); return envelope({ commandId: input.command_id, replay: true,
    message: { ...message(72), clientId: input.command_id, body: 'wrong' } }); });
  await f.actions.send(); expect(f.actions.getSnapshot().status).toBe('unknown');
  f.actions.setDraft('newer'); const command = await f.write.mock.calls[0][0].clone().json(); await f.actions.retry();
  expect(await f.write.mock.calls[1][0].clone().json()).toEqual(command); expect(f.actions.getSnapshot().draft).toBe('newer');
  expect(f.actions.getSnapshot().pendingId).toBeUndefined();
});
test('bounded drafts permit existing edits at cap, explicit clear frees one and no oversized draft is saved', async () => {
  const f = fixture();
  for (let n = 10; n < 40; n++) { await f.actions.open(available(n)); f.actions.setDraft(`draft ${n}`); }
  await f.actions.open(available(40)); f.actions.setDraft('blocked'); expect(f.actions.getSnapshot().error).toBe('draft_limit');
  expect(f.actions.getSnapshot().savedDraftSlots).toHaveLength(30);
  f.actions.selectDraft(id(10)); f.actions.setDraft('updated at cap'); expect(f.actions.getSnapshot().draft).toBe('updated at cap');
  f.actions.setDraft('x'.repeat(8001)); expect(f.actions.getSnapshot().draft).toBe('updated at cap');
  f.actions.clearDraft(); await f.actions.open(available(40)); f.actions.setDraft('allowed');
  expect(f.actions.getSnapshot().savedDraftSlots).toHaveLength(30); expect(f.actions.getSnapshot().draft).toBe('allowed');
});
test('invalid/empty selection and no-op actions never post, subscriptions detach', async () => {
  const f = fixture(), listener = jest.fn(), remove = f.actions.subscribe(listener);
  await f.actions.retry(); await f.actions.first(); await f.actions.send(); f.actions.setDraft('no selected');
  await f.actions.open({ ...available(), state: 'sealed' }); expect(f.read).not.toHaveBeenCalled();
  await f.actions.open(available()); f.actions.setDraft('   '); await f.actions.send(); expect(f.actions.getSnapshot().error).toBe('invalid_body');
  const calls = listener.mock.calls.length; f.actions.setDraft('   '); expect(listener).toHaveBeenCalledTimes(calls);
  f.actions.selectDraft(id(999)); expect(f.write).not.toHaveBeenCalled();
  remove(); listener.mockClear(); f.setCapture(null); f.actions.setDraft('after logout'); await f.actions.open(available());
  expect(f.actions.getSnapshot().savedDraftSlots).toEqual([]); expect(listener).not.toHaveBeenCalled();
});
test('saved slot immutable snapshot prevents retargeted reopen', async () => {
  const f = fixture(); await f.actions.open(available()); f.actions.setDraft('saved'); const before = f.read.mock.calls.length;
  await f.actions.open({ ...available(), preferenceVersion: 2 }); expect(f.read).toHaveBeenCalledTimes(before);
  expect(f.actions.getSnapshot().draft).toBe('saved');
});
test('unknown retry never overlaps held read; explicit retry works after completion', async () => {
  const f = fixture(); await f.actions.open(available()); f.actions.setDraft('reply');
  f.write.mockRejectedValueOnce(Error('lost')); await f.actions.send();
  const held = deferred(); f.read.mockReturnValueOnce(held.promise); const reading = f.actions.first();
  await tickUntil(() => f.read.mock.calls.length === 2); await f.actions.retry(); expect(f.write).toHaveBeenCalledTimes(1);
  held.resolve(page(f.read.mock.calls[1][0])); await reading; await f.actions.retry();
  expect(f.write).toHaveBeenCalledTimes(2); expect(f.actions.getSnapshot().status).toBe('sent');
});
