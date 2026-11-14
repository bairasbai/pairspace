import { deferred, envelope, fixture, id, prefs, scope, slot } from './mornings.fixture';
import type { MorningSlot } from '../src/auth/morning-model';
function page(request: Request, slots: MorningSlot[], preferences = prefs) {
  return envelope({ readId: new URL(request.url).searchParams.get('read_id'), serverNow: '2030-01-01T00:00:00.000Z',
    preferences, slots, hasOlder: false, hasNewer: false, olderCursor: null, newerCursor: null, lastAvailableId: null });
}
const spin = async (predicate: () => boolean) => { for (let i = 0; i < 40 && !predicate(); i++) await Promise.resolve(); expect(predicate()).toBe(true); };
test.each([401, 403, 409])('current denial %i clears access but malformed nonce does not', async status => {
  const f = fixture();
  f.read.mockImplementation(async req => new Response(JSON.stringify({ ok: false, error: 'stale_membership',
    readId: new URL(req.url).searchParams.get('read_id') }), { status }));
  await f.actions.list(); expect(f.host.block).toHaveBeenCalledWith(status === 401 ? 'auth_required' : 'access_required');
  expect(f.actions.getSnapshot().available).toBe(false);
  const other = fixture();
  other.read.mockResolvedValue(new Response(JSON.stringify({ ok: false, error: 'unavailable', readId: id(999) }), { status: 403 }));
  await other.actions.list(); expect(other.host.block).not.toHaveBeenCalled(); expect(other.actions.getSnapshot().error).toBe('invalid_response');
});
test('cookie failures and changed cookie fail closed; context mismatch refreshes', async () => {
  const f = fixture(); f.host.getCookie.mockRejectedValueOnce(Error('offline')); await f.actions.list();
  expect(f.actions.getSnapshot().error).toBe('transport_error'); expect(f.read).not.toHaveBeenCalled();
  f.host.getCookie.mockResolvedValueOnce('one').mockResolvedValueOnce('two'); await f.actions.list();
  expect(f.host.block).toHaveBeenCalledWith('auth_required');
  const g = fixture(); g.request.mockImplementation(async req => req.url.endsWith('/context') ? envelope({ ...scope, membershipEpoch: 2 }) : g.read(req));
  await g.actions.list(); expect(g.host.refresh).toHaveBeenCalled(); expect(g.read).not.toHaveBeenCalled();
});
test('close and account reset suppress held read and late denial', async () => {
  for (const reset of [false, true]) {
    const f = fixture(), held = deferred(); f.read.mockReturnValueOnce(held.promise);
    const running = f.actions.list(); await spin(() => f.read.mock.calls.length === 1);
    if (reset) f.setCapture(null); else f.actions.close();
    held.resolve(page(f.read.mock.calls[0][0], [slot()])); await running;
    expect(f.actions.getSnapshot().slots).toEqual([]); expect(f.host.block).not.toHaveBeenCalled();
  }
});
test('staged metadata updates roll back atomically on later immutable or preference contradiction', async () => {
  const f = fixture(); await f.actions.list();
  f.read.mockImplementationOnce(async req => page(req, [{ ...slot(11), prepared: true }, { ...slot(10), preferenceVersion: 2 }]));
  await f.actions.list(); expect(f.actions.getSnapshot().error).toBe('invalid_response');
  f.read.mockImplementationOnce(async req => page(req, [slot(11), slot(10)])); await f.actions.list();
  expect(f.actions.getSnapshot().status).toBe('ready');
  f.read.mockImplementationOnce(async req => page(req, [{ ...slot(11), prepared: true }], [{ ...prefs[0], localTime: '10:00' }, prefs[1]]));
  await f.actions.list(); expect(f.actions.getSnapshot().error).toBe('invalid_response');
  f.read.mockImplementationOnce(async req => page(req, [slot(11)])); await f.actions.list();
  expect(f.actions.getSnapshot().slots[0].prepared).toBe(false);
  f.read.mockImplementationOnce(async req => page(req, [slot(11)], [{ ...prefs[0], version: 2 }, prefs[1]])); await f.actions.list();
  f.read.mockImplementationOnce(async req => page(req, [slot(11)])); await f.actions.list();
  expect(f.actions.getSnapshot().error).toBe('invalid_response');
});
test.each([false, true])('unknown fill retry preserves selected B draft, conflict=%s', async conflict => {
  const f = fixture(); await f.actions.list(); f.actions.selectSlot(id(10)); f.actions.setDraft('A old');
  f.actions.requestFill(); const token = f.actions.getSnapshot().confirmation!.token;
  f.write.mockRejectedValueOnce(Error('lost')); await f.actions.confirm(token);
  const command = await f.write.mock.calls[0][0].clone().json();
  f.actions.selectSlot(id(11)); f.actions.setDraft('B newer');
  if (conflict) f.write.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: 'slot_filled' }), { status: 409 }));
  await f.actions.retry();
  expect(await f.write.mock.calls[1][0].clone().json()).toEqual(command);
  expect(f.actions.getSnapshot().selected?.id).toBe(id(11)); expect(f.actions.getSnapshot().draft).toBe('B newer');
  expect(f.actions.getSnapshot().pendingId).toBeUndefined();
  f.actions.selectSlot(id(10)); expect(f.actions.getSnapshot().draft).toBe(conflict ? 'A old' : '');
});
test('30 saved drafts survive page replacement and explicit clearing frees a slot', async () => {
  const f = fixture(); const slots = Array.from({ length: 30 }, (_, i) => slot(40 - i));
  f.read.mockImplementationOnce(async req => page(req, slots)); await f.actions.list();
  for (const s of slots) { f.actions.selectSlot(s.id); f.actions.setDraft(`draft ${s.id}`); }
  f.read.mockImplementationOnce(async req => page(req, [slot(99)])); await f.actions.list();
  f.actions.selectSlot(id(99)); f.actions.setDraft('new'); expect(f.actions.getSnapshot().error).toBe('draft_limit');
  expect(f.actions.getSnapshot().savedDraftSlots).toHaveLength(30);
  f.actions.selectSlot(id(40)); expect(f.actions.getSnapshot().draft).toContain(id(40)); f.actions.clearDraft();
  f.actions.selectSlot(id(99)); f.actions.setDraft('new'); expect(f.actions.getSnapshot().draft).toBe('new');
});
test('preference replay cannot forge same-version intent but higher canonical version is accepted', async () => {
  const f = fixture(); await f.actions.list(); f.actions.setPreference({ timezone: 'UTC', localTime: '09:00' });
  f.write.mockImplementationOnce(async req => { const b = await req.json(); return envelope({ commandId: b.command_id, replay: true,
    preference: { ...prefs[0], version: 2, localTime: '10:00' } }); });
  await f.actions.savePreference(); expect(f.actions.getSnapshot().status).toBe('unknown');
  f.write.mockImplementationOnce(async req => { const b = await req.json(); return envelope({ commandId: b.command_id, replay: true,
    preference: { ...prefs[0], version: 3, localTime: '10:00' } }); });
  await f.actions.retry(); expect(f.actions.getSnapshot().status).toBe('sent');
  expect(f.actions.getSnapshot().preferences[1].version).toBe(3);
});
test('invalid actions do not write; subscriptions stop after unsubscribe', async () => {
  const f = fixture(), listener = jest.fn(), remove = f.actions.subscribe(listener);
  f.actions.setPreference({ localTime: '99:99' }); await f.actions.savePreference(); expect(f.actions.getSnapshot().status).toBe('invalid');
  f.actions.requestAssignment(); f.actions.requestFill(); await f.actions.confirm('wrong'); await f.actions.retry();
  await f.actions.open(id(99)); await f.actions.older(); await f.actions.newer(); await f.actions.openLastAvailable();
  expect(f.write).not.toHaveBeenCalled(); remove(); listener.mockClear(); f.feature.reset(); expect(listener).not.toHaveBeenCalled();
});
test('held opened body cannot change on reread of immutable same slot', async () => {
  const f = fixture();
  const available: MorningSlot = { ...slot(10), prepared: true, state: 'available' };
  f.read.mockImplementationOnce(async req => envelope({ readId: new URL(req.url).searchParams.get('read_id'),
    serverNow: available.releaseAt, preferences: prefs, slots: [available], hasOlder: false, hasNewer: false,
    olderCursor: null, newerCursor: null, lastAvailableId: null }));
  await f.actions.list(); f.actions.selectSlot(available.id);
  const detail = (req: Request, body: string) => envelope({ readId: new URL(req.url).searchParams.get('read_id'),
    serverNow: available.releaseAt, slot: available, body });
  f.read.mockImplementationOnce(async req => detail(req, 'original')); await f.actions.open(available.id);
  expect(f.actions.getSnapshot().opened?.body).toBe('original');
  f.read.mockImplementationOnce(async req => detail(req, 'changed')); await f.actions.open(available.id);
  expect(f.actions.getSnapshot().error).toBe('invalid_response');
  expect(f.actions.getSnapshot().opened?.body).not.toBe('changed');
});
test('known server clock rejects past assignment without POST', async () => {
  const f = fixture(); await f.actions.list(); f.actions.setLocalDate('2029-12-31'); f.actions.requestAssignment();
  expect(f.actions.getSnapshot().confirmation).toBeUndefined();
  await f.actions.confirm('nonexistent'); expect(f.write).not.toHaveBeenCalled();
  f.actions.setLocalDate('2032-01-01'); f.actions.requestAssignment(); expect(f.actions.getSnapshot().confirmation).toBeUndefined();
});
test('explicit navigation, schedule choice and cancelled confirmation preserve drafts', async () => {
  const f = fixture(); await f.actions.latest(); await f.actions.oldest();
  f.actions.setLocalDate('2030-01-02'); f.actions.chooseOffset('bad'); f.actions.chooseOffset('+00:00');
  expect(f.actions.getSnapshot().offset).toBe('+00:00'); f.actions.requestAssignment(); f.actions.cancelConfirmation();
  expect(f.actions.getSnapshot().confirmation).toBeUndefined(); expect(f.write).not.toHaveBeenCalled();
  f.actions.selectSlot('unknown'); f.actions.setDraft('without selection');
  f.actions.setPreference({ localTime: '123456' }); f.actions.setPreference({ timezone: 'x'.repeat(101) });
  f.actions.setLocalDate('x'.repeat(11)); expect(f.actions.getSnapshot().localDate).toBe('2030-01-02');
  f.setCapture(null); f.actions.requestAssignment(); f.actions.requestFill(); await f.actions.savePreference();
  f.actions.chooseOffset('+00:00'); expect(f.write).not.toHaveBeenCalled();
});
