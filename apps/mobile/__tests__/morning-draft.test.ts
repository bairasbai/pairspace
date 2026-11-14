import { draftFixture, draftSlot, now, failure } from './morning-draft.fixture';
import { id, scope, slot, envelope, deferred } from './mornings.fixture';
import { parseSavedMorningDraft } from '../src/auth/morning-draft-model';
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
it('loads explicit author private draft; no-op retains version, real changes and restoration increment', async () => {
  const f = draftFixture(), a = f.actions, listener = jest.fn(), stop = a.subscribe(listener);
  f.feature.sync(); expect(f.request).not.toHaveBeenCalled();
  await a.save(); await a.retry(); await a.reload(); a.setDraft('ignored');
  await a.begin(slot(10, true));
  expect(f.request).not.toHaveBeenCalled();
  await a.begin(draftSlot()); expect(a.getSnapshot()).toMatchObject({ draft: 'original', version: 1, status: 'ready' });
  a.setDraft('original'); await a.save(); expect(a.getSnapshot()).toMatchObject({ draft: 'original', version: 1, status: 'saved' });
  a.setDraft('changed'); await a.save(); expect(a.getSnapshot().version).toBe(2);
  a.setDraft('original'); await a.save(); expect(a.getSnapshot().version).toBe(3);
  expect(listener).toHaveBeenCalled(); stop();
  a.cancel(); expect(a.getSnapshot().target).toBeNull();
  f.feature.reset(); await a.begin(draftSlot()); a.setDraft('ignored'); expect(a.getSnapshot().available).toBe(false);
});
it('retains existing editor across another target selection; untouched reload adopts current text', async () => {
  const f = draftFixture(), a = f.actions; await a.begin(draftSlot());
  await a.begin({ ...draftSlot(), id: id(11) }); expect(a.getSnapshot().error).toBe('cancel_edit_first');
  f.setCanonical('new current', 2); await a.reload();
  expect(a.getSnapshot()).toMatchObject({ draft: 'new current', version: 2, draftPreserved: false });
  a.setDraft('my private'); f.setCanonical('concurrent', 3); await a.reload();
  expect(a.getSnapshot()).toMatchObject({ draft: 'my private', version: 3, draftPreserved: true });
  a.setDraft('x'.repeat(16001)); expect(a.getSnapshot().draft).toBe('my private');
  a.setDraft(''); await a.save(); expect(a.getSnapshot().error).toBe('invalid_request');
  a.setDraft('valid'); f.identity.mockReturnValueOnce('bad'); await a.save(); expect(f.write).not.toHaveBeenCalled();
});
it('preserves typing during GET and ACK, and reload after first failed read', async () => {
  const f = draftFixture(), a = f.actions, wait = deferred();
  f.read.mockImplementationOnce(() => wait.promise);
  const loading = a.begin(draftSlot()); await tick(); a.setDraft('typed during load');
  await a.begin(draftSlot()); await a.reload(); await a.save();
  const readRequest = f.read.mock.calls[0][0];
  wait.resolve(envelope({ readId: new URL(readRequest.url).searchParams.get('read_id'), state: 'live', serverNow: now, slot: draftSlot(), body: 'original', version: 1 }));
  await loading; expect(a.getSnapshot()).toMatchObject({ draft: 'typed during load', draftPreserved: true });
  const ack = deferred(); f.write.mockImplementationOnce(() => ack.promise);
  const saving = a.save(); await tick(); a.setDraft('newer draft');
  const cmd = await f.write.mock.calls[0][0].clone().json();
  ack.resolve(envelope({ commandId: cmd.command_id, replay: false, state: 'live', serverNow: now, slot: draftSlot(), body: cmd.body, version: 2 }));
  await saving; expect(a.getSnapshot()).toMatchObject({ draft: 'newer draft', version: 2, draftPreserved: true });
  a.cancel(); f.read.mockImplementationOnce(async request => failure('unavailable_read', request, 404));
  await a.begin(draftSlot()); a.setDraft('keep after failed read'); await a.reload();
  expect(a.getSnapshot().draft).toBe('keep after failed read');
});
it('unknown outcome freezes immutable command and disables cancel/save/reload; explicit retry preserves new draft', async () => {
  const f = draftFixture(), a = f.actions; await a.begin(draftSlot()); a.setDraft('pending');
  f.write.mockImplementationOnce(async () => { throw Error('offline'); }); await a.save();
  expect(a.getSnapshot().status).toBe('unknown');
  const old = await f.write.mock.calls[0][0].clone().json();
  a.cancel(); a.setDraft('new draft'); await a.save(); await a.reload(); await a.begin(draftSlot());
  expect(f.write).toHaveBeenCalledTimes(1); expect(a.getSnapshot().target).not.toBeNull();
  f.write.mockImplementationOnce(async request => envelope({ commandId: (await request.clone().json()).command_id, replay: true,
    state: 'live', serverNow: now, slot: draftSlot(), body: 'subsequent canonical', version: 3 }));
  await a.retry(); const next = await f.write.mock.calls[1][0].clone().json(); expect(next).toEqual(old);
  expect(a.getSnapshot()).toMatchObject({ draft: 'new draft', version: 3, status: 'saved' });
});
it.each(['version_conflict', 'idempotency_conflict', 'invalid_request'])('%s clears command but keeps draft and requires reload', async error => {
  const f = draftFixture(), a = f.actions; await a.begin(draftSlot()); a.setDraft('private');
  f.write.mockImplementationOnce(async request => failure(error, request)); await a.save();
  expect(a.getSnapshot()).toMatchObject({ draft: 'private', needsReload: true });
  await a.retry(); await a.save(); expect(f.write).toHaveBeenCalledTimes(1);
  await a.reload(); await a.save(); expect(f.write).toHaveBeenCalledTimes(2);
});
it('missing draft version zero creates explicitly and private draft stays writable after release', async () => {
  const f = draftFixture(), a = f.actions;
  f.read.mockImplementationOnce(async request => envelope({ readId: new URL(request.url).searchParams.get('read_id'),
    state: 'missing', serverNow: draftSlot().releaseAt, slot: { ...draftSlot(), state: 'missed' }, body: null, version: 0 }));
  await a.begin(draftSlot()); expect(a.getSnapshot()).toMatchObject({ version: 0, draft: '', status: 'ready' });
  a.setDraft('private late text');
  f.write.mockImplementationOnce(async request => envelope({ commandId: (await request.clone().json()).command_id, replay: false,
    state: 'live', serverNow: draftSlot().releaseAt, slot: { ...draftSlot(), state: 'missed' }, body: 'private late text', version: 1 }));
  await a.save(); expect(a.getSnapshot()).toMatchObject({ version: 1, draft: 'private late text', status: 'saved' });
  expect(f.write.mock.calls[0][0].url).toContain('/draft-v2');
});
it('saved draft survives filled/available slot metadata without becoming letter text', async () => {
  const f = draftFixture(), a = f.actions;
  f.read.mockImplementationOnce(async request => envelope({ readId: new URL(request.url).searchParams.get('read_id'),
    state: 'live', serverNow: draftSlot().releaseAt, slot: { ...draftSlot(), prepared: true, state: 'available' }, body: 'old private draft', version: 7 }));
  await a.begin({ ...draftSlot(), prepared: true });
  expect(a.getSnapshot()).toMatchObject({ draft: 'old private draft', version: 7, needsReload: false });
  a.setDraft('new private'); f.write.mockImplementationOnce(async request => envelope({ commandId: (await request.clone().json()).command_id, replay: false,
    state: 'live', serverNow: draftSlot().releaseAt, slot: { ...draftSlot(), prepared: true, state: 'available' }, body: 'new private', version: 8 }));
  await a.save(); expect(a.getSnapshot().status).toBe('saved');
});
it('malformed or stale canonical success is not trusted; write remains unknown', async () => {
  const f = draftFixture(), a = f.actions; await a.begin(draftSlot());
  f.read.mockImplementationOnce(async () => envelope({})); await a.reload(); expect(a.getSnapshot().error).toBe('invalid_response');
  f.setCanonical('stale other', 1); await a.reload(); expect(a.getSnapshot().error).toBe('invalid_response');
  f.setCanonical('new', 2); await a.reload(); f.setCanonical('original', 1); await a.reload(); expect(a.getSnapshot().version).toBe(2);
  f.setCanonical('new', 2); await a.reload(); a.setDraft('edit');
  f.write.mockImplementationOnce(async request => envelope({ commandId: (await request.clone().json()).command_id, replay: false,
    state: 'live', serverNow: now, slot: draftSlot(), body: 'wrong', version: 3 }));
  await a.save(); expect(a.getSnapshot().status).toBe('unknown');
  f.write.mockImplementationOnce(async request => envelope({ commandId: (await request.clone().json()).command_id, replay: true,
    state: 'live', serverNow: now, slot: draftSlot(), body: 'original', version: 1 })); await a.retry();
  expect(a.getSnapshot().status).toBe('unknown');
});
it('cancelling GET fences stale response but current-session auth denial still wins', async () => {
  const f = draftFixture(), a = f.actions, wait = deferred(); f.read.mockImplementationOnce(() => wait.promise);
  const load = a.begin(draftSlot()); await tick(); a.cancel();
  const request = f.read.mock.calls[0][0]; wait.resolve(envelope({ readId: new URL(request.url).searchParams.get('read_id'),
    state: 'live', serverNow: now, slot: draftSlot(), body: 'old', version: 1 })); await load;
  expect(a.getSnapshot().target).toBeNull();
  const denied = deferred(); f.read.mockImplementationOnce(() => denied.promise);
  const later = a.begin(draftSlot()); await tick(); a.cancel(); denied.resolve(failure('unavailable', f.read.mock.calls[1][0], 403));
  await later; expect(f.host.block).toHaveBeenCalledWith('access_required'); expect(a.getSnapshot().available).toBe(false);
});
it('scope/cookie transitions clear everything; old responses never block replacement identity', async () => {
  const f = draftFixture(), a = f.actions, wait = deferred(); f.read.mockImplementationOnce(() => wait.promise);
  const load = a.begin(draftSlot()); await tick(); f.setCapture(null); wait.resolve(envelope({})); await load;
  expect(a.getSnapshot().available).toBe(false); expect(f.host.block).not.toHaveBeenCalled();
  const g = draftFixture(); g.request.mockImplementationOnce(async () => envelope({ ...scope, membershipEpoch: 2 }));
  await g.actions.begin(draftSlot()); expect(g.host.refresh).toHaveBeenCalled(); expect(g.actions.getSnapshot().target).toBeNull();
  const h = draftFixture(); await h.actions.begin(draftSlot()); h.actions.setDraft('private');
  h.host.getCookie.mockResolvedValueOnce('a').mockResolvedValueOnce('b'); await h.actions.save();
  expect(h.host.block).toHaveBeenCalledWith('auth_required'); expect(h.actions.getSnapshot().draft).toBe('');
});
it('parser binds identity, exact schema, draft/version/clock/author/immutable target', () => {
  const value = { readId: id(100), state: 'live', serverNow: now, slot: draftSlot(), body: 'body', version: 1 };
  const parse = (v: unknown) => parseSavedMorningDraft(v, scope, draftSlot(), { readId: id(100) });
  expect(parse(value)).not.toBeNull();
  expect(parse({ ...value, state: 'missing', body: null, version: 0 })).not.toBeNull();
  expect(parse({ ...value, version: 2147483646 })).not.toBeNull();
  for (const patch of [{ readId: id(99) }, { state: 'live', serverNow: 'bad' }, { state: 'live', serverNow: '2030-01-01T99:00:00.000Z' }, { version: -1 }, { version: 1.5 }, { version: 2147483647 },
    { body: '' }, { body: 'a\r\nb' }, { body: null }, { version: 0 }, { slot: {} }, { slot: { ...draftSlot(), id: id(20) } }, { slot: slot(10, true) },
    { slot: { ...draftSlot(), state: 'available' } }, { slot: { ...draftSlot(), preferenceVersion: 2 } }]) expect(parse({ ...value, ...patch })).toBeNull();
  expect(parse({ ...value, state: 'missing', body: null, version: 0, slot: { ...draftSlot(), prepared: true } })).toBeNull();
  expect(parse(null)).toBeNull(); expect(parse({ ...value, extra: true })).toBeNull();
  const ack = { commandId: id(100), replay: false, state: 'live', serverNow: now, slot: draftSlot(), body: 'body', version: 1 };
  expect(parseSavedMorningDraft(ack, scope, draftSlot(), { commandId: id(100) })).not.toBeNull();
  expect(parseSavedMorningDraft({ ...ack, replay: 'yes' }, scope, draftSlot(), { commandId: id(100) })).toBeNull();
  expect(parseSavedMorningDraft({ ...ack, body: null, version: 0 }, scope, draftSlot(), { commandId: id(100) })).toBeNull();
  expect(parseSavedMorningDraft(ack, scope, draftSlot(), { commandId: id(101) })).toBeNull();
});
it('filled slot with no draft is local error, not loss of authorized pair access', async () => {
  const f = draftFixture(), a = f.actions;
  f.read.mockImplementationOnce(async request => failure('slot_filled', request));
  await a.begin({ ...draftSlot(), prepared: true }); a.setDraft('private input after load error');
  expect(a.getSnapshot()).toMatchObject({ status: 'error', draft: 'private input after load error' });
  expect(f.host.block).not.toHaveBeenCalled();
  a.cancel(); await a.begin(draftSlot()); a.setDraft('protected before fill race');
  f.write.mockImplementationOnce(async request => failure('slot_filled', request)); await a.save();
  expect(a.getSnapshot()).toMatchObject({ status: 'error', draft: 'protected before fill race', needsReload: true });
  await a.retry(); expect(f.write).toHaveBeenCalledTimes(1); expect(f.host.block).not.toHaveBeenCalled();
});
