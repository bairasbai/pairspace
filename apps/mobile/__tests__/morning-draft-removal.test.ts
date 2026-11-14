import { draftFixture, draftSlot, now, failure } from './morning-draft.fixture';
import { id, scope, envelope, deferred } from './mornings.fixture';
import { parseSavedMorningDraft } from '../src/auth/morning-draft-model';
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const tombstone = (identity: object, version = 2) => ({ ...identity, serverNow: now, slot: draftSlot(), body: null, version, state: 'deleted' });
const deletedAck = async (request: Request, replay = false) => envelope(tombstone({ commandId: (await request.clone().json()).command_id, replay }));
it('explicit confirmation binds revision, cancellation is local and valid removal clears unchanged canonical input', async () => {
  const f = draftFixture(), a = f.actions;
  a.beginDelete(); await a.confirmDelete('bad'); await a.begin(draftSlot());
  a.beginDelete(); const old = a.getSnapshot().confirmation!; a.setDraft('new'); await a.confirmDelete(old.token);
  expect(f.write).not.toHaveBeenCalled(); a.setDraft('original'); a.beginDelete(); a.cancelDelete();
  await a.confirmDelete(old.token); expect(f.write).not.toHaveBeenCalled();
  f.identity.mockReturnValueOnce('bad'); a.beginDelete(); expect(a.getSnapshot().error).toBe('invalid_request');
  a.beginDelete(); const token = a.getSnapshot().confirmation!.token; await a.confirmDelete('wrong');
  f.write.mockImplementationOnce(request => deletedAck(request)); await a.confirmDelete(token);
  expect(f.write.mock.calls[0][0].method).toBe('DELETE');
  expect(await f.write.mock.calls[0][0].clone().json()).toMatchObject({ expected_version: 1, confirm: true });
  expect(a.getSnapshot()).toMatchObject({ status: 'deleted', state: 'deleted', draft: '', version: 2 });
  a.beginDelete(); await a.save(); expect(f.write).toHaveBeenCalledTimes(1);
});
it('unknown removal retries immutable command and retains newer unsaved input, not canonical', async () => {
  const f = draftFixture(), a = f.actions; await a.begin(draftSlot()); a.beginDelete();
  f.write.mockImplementationOnce(async () => { throw Error('lost'); }); await a.confirmDelete(a.getSnapshot().confirmation!.token);
  const original = await f.write.mock.calls[0][0].clone().json(); expect(a.getSnapshot().status).toBe('unknown');
  a.cancel(); a.setDraft('new unsaved'); a.beginDelete(); await a.reload(); await a.save();
  f.write.mockImplementationOnce(request => deletedAck(request, true)); await a.retry();
  expect(await f.write.mock.calls[1][0].clone().json()).toEqual(original);
  expect(a.getSnapshot()).toMatchObject({ status: 'deleted', draft: 'new unsaved', draftPreserved: true });
});
it('fresh write terminal conflict learns tombstone; old live reads cannot resurrect across close and begin', async () => {
  const f = draftFixture(), a = f.actions; await a.begin(draftSlot()); a.setDraft('edit not committed');
  f.write.mockImplementationOnce(async request => new Response(JSON.stringify({ ok: false, error: 'draft_deleted',
    value: tombstone({ commandId: (await request.clone().json()).command_id, replay: false }) }), { status: 409 }));
  await a.save(); expect(a.getSnapshot()).toMatchObject({ state: 'deleted', draft: 'edit not committed' });
  a.cancel(); await a.begin(draftSlot()); expect(a.getSnapshot()).toMatchObject({ state: 'deleted', draft: '' });
  await a.save(); expect(f.write).toHaveBeenCalledTimes(1);
});
it('late tombstone from cancelled read learns metadata without replacing another form or its newer draft', async () => {
  const f = draftFixture(), a = f.actions, wait = deferred(); f.read.mockImplementationOnce(() => wait.promise);
  const old = a.begin(draftSlot()); await tick(); const request = f.read.mock.calls[0][0]; a.cancel();
  const second = { ...draftSlot(), id: id(55) };
  f.read.mockImplementationOnce(async request => envelope({ readId: new URL(request.url).searchParams.get('read_id'),
    serverNow: now, slot: second, body: 'second', version: 1, state: 'live' }));
  await a.begin(second); a.setDraft('second new unsaved');
  wait.resolve(envelope(tombstone({ readId: new URL(request.url).searchParams.get('read_id') }))); await old;
  expect(a.getSnapshot()).toMatchObject({ target: second, draft: 'second new unsaved' });
  a.cancel(); await a.begin(draftSlot()); expect(a.getSnapshot()).toMatchObject({ state: 'deleted', draft: '' });
});
it('non-evicting bounded ledger fails closed; reset changes auth scope, not local navigation', async () => {
  expect(() => draftFixture(0)).toThrow('invalid_terminal_limit');
  const f = draftFixture(1), a = f.actions;
  f.read.mockImplementationOnce(async request => envelope(tombstone({ readId: new URL(request.url).searchParams.get('read_id') })));
  await a.begin(draftSlot()); a.cancel();
  const other = { ...draftSlot(), id: id(55) };
  f.read.mockImplementationOnce(async request => envelope({ ...tombstone({ readId: new URL(request.url).searchParams.get('read_id') }), slot: other }));
  await a.begin(other); expect(a.getSnapshot()).toMatchObject({ error: 'terminal_knowledge_limit', draft: '' });
  a.setDraft('cannot'); await a.reload(); a.cancel(); await a.begin(draftSlot()); expect(a.getSnapshot().draft).toBe('');
  f.feature.reset(); f.feature.sync(); await a.begin(draftSlot()); expect(a.getSnapshot().state).toBe('live');
});
it('invalid deletion success stays unknown; missing draft error is definitive and preserves input', async () => {
  const f = draftFixture(), a = f.actions; await a.begin(draftSlot()); a.beginDelete();
  await a.confirmDelete(a.getSnapshot().confirmation!.token); expect(a.getSnapshot().status).toBe('unknown');
  f.write.mockImplementationOnce(async request => failure('draft_missing', request)); await a.retry();
  expect(a.getSnapshot()).toMatchObject({ status: 'error', needsReload: true });
  await a.retry(); expect(f.write).toHaveBeenCalledTimes(2);
});
it('deleted states validate strictly and cannot impersonate missing/live', () => {
  const parse = (v: unknown) => parseSavedMorningDraft(v, scope, draftSlot(), { readId: id(100) });
  const dead = tombstone({ readId: id(100) }); expect(parse(dead)?.state).toBe('deleted');
  for (const patch of [{ version: 1 }, { body: 'private' }, { state: 'unknown' }, { state: 'missing' }, { state: 'live' }]) expect(parse({ ...dead, ...patch })).toBeNull();
});
it('rejects forged fresh tombstone ACK and inconsistent terminal versions fail closed', async () => {
  const f = draftFixture(), a = f.actions; await a.begin(draftSlot()); a.setDraft('edit');
  f.write.mockImplementationOnce(request => deletedAck(request)); await a.save();
  expect(a.getSnapshot().status).toBe('unknown');
  f.write.mockImplementationOnce(request => deletedAck(request, true)); await a.retry(); expect(a.getSnapshot().state).toBe('deleted');
  f.read.mockImplementationOnce(async request => envelope(tombstone({ readId: new URL(request.url).searchParams.get('read_id') }, 3)));
  await a.reload(); expect(a.getSnapshot()).toMatchObject({ error: 'terminal_knowledge_limit', draft: '' });
});
it('new deletion ACK cannot invent a larger version', async () => {
  const f = draftFixture(), a = f.actions; await a.begin(draftSlot()); a.beginDelete();
  f.write.mockImplementationOnce(async request => envelope(tombstone({ commandId: (await request.clone().json()).command_id, replay: false }, 3)));
  await a.confirmDelete(a.getSnapshot().confirmation!.token); expect(a.getSnapshot().status).toBe('unknown');
});
it('late terminal read scrubs a reopened same-slot live form but preserves genuinely newer RAM', async () => {
  for (const typed of [false, true]) {
    const f = draftFixture(), a = f.actions, wait = deferred(); f.read.mockImplementationOnce(() => wait.promise);
    const old = a.begin(draftSlot()); await tick(); const request = f.read.mock.calls[0][0];
    a.cancel(); await a.begin(draftSlot()); if (typed) a.setDraft('new unsaved');
    wait.resolve(envelope(tombstone({ readId: new URL(request.url).searchParams.get('read_id') }))); await old;
    expect(a.getSnapshot()).toMatchObject({ state: 'deleted', draft: typed ? 'new unsaved' : '' });
  }
});
