import { createPredictionsController } from '../src/auth/predictions';
import { ack, before, context, declined, deferred, detail, due, envelope, error, fixture, incoming, list, opened, own, ownOpened, prose, removed, schedule, settle, uuid } from './predictions-fixtures';
it('starts with empty explicit schedule, no network/device clock; creation needs confirmed full history and future zoned date', async () => {
  const f = fixture(); expect(f.api.getSnapshot().schedule).toEqual({ localDate: '', localTime: '', timezone: '', offset: '' });
  expect(f.operation).not.toHaveBeenCalled(); await f.api.create(false); await f.api.create('true' as unknown as boolean); expect(f.operation).not.toHaveBeenCalled();
  await f.api.create(true); expect(f.api.getSnapshot().requiresRefresh).toBe(true); await f.load([], before);
  await f.api.create(true); expect(f.api.getSnapshot().status).toBe('invalid'); f.schedule();
  f.api.setDraft(' e\u0301\r\n next '); f.operation.mockResolvedValueOnce(ack(own, false, uuid(3), before)); await f.api.create(true);
  const r = f.operation.mock.calls[1][0]; expect(r.method).toBe('POST'); expect(r.url).not.toContain('next');
  expect(await r.json()).toEqual({ text: 'é\n next', schedule, confirm: true, membership_epoch: 1, command_id: uuid(3) });
  expect(r.headers.get('idempotency-key')).toBe(uuid(3)); expect(r.headers.has('authorization')).toBe(false);
  expect(f.api.getSnapshot().draft).toBe(''); expect(f.api.getSnapshot().schedule.timezone).toBe(''); expect(f.api.getSnapshot().checked).toBe(false);
  expect(Object.isFrozen(f.api.getSnapshot().predictions[0])).toBe(true);
});
it('creation rejects current day, wrong DST offset, malformed text and ID; never silently invents a timezone', async () => {
  for (const bad of [{ ...schedule, localDate: '2026-11-10' }, { ...schedule, timezone: '' },
    { ...schedule, localDate: '2027-03-14', localTime: '02:30', timezone: 'America/New_York', offset: '-05:00' }]) {
    const f = fixture(); await f.load([], before); f.schedule(bad); await f.api.create(true); expect(f.api.getSnapshot().status).toBe('invalid'); expect(f.operation).toHaveBeenCalledTimes(1);
  }
  const f = fixture(); await f.load([], before); f.schedule(); f.api.setDraft('a\rb'); await f.api.create(true); expect(f.api.getSnapshot().status).toBe('invalid');
  f.api.setDraft('x'.repeat(8001)); expect(f.api.getSnapshot().draft.length).toBe(8000); await f.api.create(true); expect(f.operation).toHaveBeenCalledTimes(1);
  f.api.setDraft('x'); f.command.mockReturnValueOnce('bad'); await f.api.create(true); expect(f.api.getSnapshot().status).toBe('invalid');
  f.api.setSchedule('timezone', 'x'.repeat(101)); expect(f.api.getSnapshot().schedule.timezone.length).toBe(100);
});
it('unknown create preserves exact text/schedule/command despite editing or canceling newer draft', async () => {
  const f = fixture(); await f.load([], before); f.schedule(); f.api.setDraft('🦉'.repeat(2000));
  f.operation.mockRejectedValueOnce(Error('offline')); await f.api.create(true); expect(f.api.getSnapshot().pending).toBe(true);
  f.api.cancelDraft(); f.api.setDraft('Synthetic newer draft'); f.api.setSchedule('timezone', 'UTC');
  f.operation.mockResolvedValueOnce(ack(own, true, uuid(3), before)); await f.api.retry();
  expect(f.api.getSnapshot().draft).toBe('Synthetic newer draft'); expect(f.api.getSnapshot().schedule.timezone).toBe('UTC');
  expect(await f.operation.mock.calls[1][0].json()).toEqual(await f.operation.mock.calls[2][0].json());
  expect(f.api.getSnapshot().pending).toBe(false); await f.api.retry(); expect(f.operation).toHaveBeenCalledTimes(3);
});
it('recipient cannot read unopened or removed; only explicit confirmed due opening fetches separate body after ACK', async () => {
  const f = fixture(); await f.load([incoming], before); await f.api.open(incoming.id, true); expect(f.api.getSnapshot().status).toBe('not_due');
  await f.api.read(incoming.id); await f.api.remove(incoming.id, true); await f.api.open(incoming.id, false); expect(f.operation).toHaveBeenCalledTimes(1);
  await f.load([incoming]); f.operation.mockResolvedValueOnce(ack(opened)).mockResolvedValueOnce(detail()); await f.api.open(incoming.id, true);
  expect(f.api.getSnapshot().reader?.text).toBe(prose); expect(f.api.getSnapshot().predictions[0]).toEqual(opened);
  expect(f.operation.mock.calls[2][0].method).toBe('POST'); expect(f.operation.mock.calls[3][0].method).toBe('GET');
  expect(f.operation.mock.calls[3][0].url).toContain('/predictions/' + incoming.id + '/text');
  expect(await f.operation.mock.calls[2][0].json()).toEqual({ membership_epoch: 1, command_id: uuid(3), expected_version: 1, confirm: true });
  f.api.close(); f.operation.mockResolvedValueOnce(detail()); await f.api.read(opened.id); expect(f.api.getSnapshot().reader?.text).toBe(prose);
  const n = f.operation.mock.calls.length; await f.api.open(opened.id, true); await f.api.decline(opened.id, true); await f.api.open(uuid(999), true); expect(f.operation).toHaveBeenCalledTimes(n);
  const g = fixture(); await g.load([own]); await g.api.open(own.id, true); await g.api.decline(own.id, true); await g.api.remove(own.id, false); expect(g.operation).toHaveBeenCalledTimes(1);
});
it('Close while open POST is pending keeps its immutable command but prohibits automatic GET even after valid ACK', async () => {
  const f = fixture(); await f.load([incoming]); const held = deferred(); f.operation.mockImplementationOnce(() => held.promise);
  const task = f.api.open(incoming.id, true); await settle(); expect(f.api.getSnapshot().readerStatus).toBe('loading');
  f.api.close(); await f.api.read(incoming.id); expect(f.api.getSnapshot().busy).toBe(true);
  held.resolve(ack(opened)); await task;
  expect(f.operation).toHaveBeenCalledTimes(2); expect(f.api.getSnapshot().pending).toBe(false); expect(f.api.getSnapshot().reader).toBeNull();
  expect(f.api.getSnapshot().readerStatus).toBe('closed'); expect(f.api.getSnapshot().predictions[0]).toEqual(opened);
  f.operation.mockResolvedValueOnce(detail()); await f.api.read(incoming.id); expect(f.api.getSnapshot().reader?.text).toBe(prose);
});
it('Close after lost open ACK makes retry metadata-only even if refresh learned the opening', async () => {
  const f = fixture(); await f.load([incoming]); f.operation.mockRejectedValueOnce(Error('unknown outcome')); await f.api.open(incoming.id, true);
  expect(f.api.getSnapshot().pending).toBe(true); await f.load([opened]); f.api.close(); f.operation.mockResolvedValueOnce(ack(opened, true)); await f.api.retry();
  expect(f.api.getSnapshot().pending).toBe(false); expect(f.api.getSnapshot().reader).toBeNull(); expect(f.operation).toHaveBeenCalledTimes(4);
  expect(await f.operation.mock.calls[1][0].json()).toEqual(await f.operation.mock.calls[3][0].json());
});
it('Close triggered by ACK publication blocks queued follow-up GET; Close during its GET fences late body', async () => {
  const f = fixture(); await f.load([incoming]); const off = f.api.subscribe(() => {
    if (f.api.getSnapshot().status === 'saved' && f.api.getSnapshot().readerStatus === 'loading') f.api.close();
  });
  f.operation.mockResolvedValueOnce(ack(opened)); await f.api.open(incoming.id, true); off(); expect(f.operation).toHaveBeenCalledTimes(2);
  const g = fixture(); await g.load([incoming]); const late = deferred(); g.operation.mockResolvedValueOnce(ack(opened)).mockImplementationOnce(() => late.promise);
  const task = g.api.open(incoming.id, true); await settle(); expect(g.operation).toHaveBeenCalledTimes(3); g.api.close(); late.resolve(detail()); await task;
  expect(g.api.getSnapshot().reader).toBeNull(); expect(g.api.getSnapshot().readerStatus).toBe('closed');
});
it('an open ACK with any text is rejected without body GET; replay must prove the original requested transition', async () => {
  for (const response of [envelope({ prediction: opened, commandId: uuid(3), replay: false, checkedAt: due, text: prose }),
    ack(incoming, true), ack(declined, true), ack({ ...opened, id: uuid(99) }), ack(opened, false, uuid(99)),
    ack({ ...opened, releaseAt: '2026-11-12T06:00:00.000Z' }), ack(removed, false)]) {
    const f = fixture(); await f.load([incoming]); f.operation.mockResolvedValueOnce(response); await f.api.open(incoming.id, true);
    expect(f.api.getSnapshot().status).toBe('retry'); expect(f.api.getSnapshot().reader).toBeNull(); expect(f.operation).toHaveBeenCalledTimes(2);
  }
  const f = fixture(); await f.load([incoming]); f.operation.mockRejectedValueOnce(Error('unknown')); await f.api.open(incoming.id, true);
  await f.load([removed]); f.operation.mockResolvedValueOnce(ack(opened, true)); await f.api.retry(); expect(f.api.getSnapshot().status).toBe('retry');
  f.operation.mockResolvedValueOnce(ack(removed, true)); await f.api.retry(); expect(f.api.getSnapshot().pending).toBe(false); expect(f.api.getSnapshot().reader).toBeNull();
});
it('decline is body-free and removal erases an author reader; transition replay cannot erase a prior decision', async () => {
  const f = fixture(); await f.load([incoming]); f.operation.mockResolvedValueOnce(ack(declined)); await f.api.decline(incoming.id, true);
  expect(f.api.getSnapshot().predictions[0]).toEqual(declined); expect(f.api.getSnapshot().reader).toBeNull();
  const g = fixture(); await g.load([ownOpened]); g.operation.mockResolvedValueOnce(detail(ownOpened)); await g.api.read(own.id);
  g.operation.mockResolvedValueOnce(ack({ ...ownOpened, contentState: 'removed', version: 3 })); await g.api.remove(own.id, true);
  expect(g.api.getSnapshot().reader).toBeNull(); expect(g.operation.mock.calls[2][0].method).toBe('DELETE');
  const h = fixture(); await h.load([ownOpened]); h.operation.mockResolvedValueOnce(ack({ ...own, contentState: 'removed', version: 2 }, true)); await h.api.remove(own.id, true);
  expect(h.api.getSnapshot().status).toBe('retry');
});
it('late GET from closed/replaced reader never returns private text; newer canonical metadata requires explicit reread', async () => {
  const f = fixture(); await f.load([own, opened]); const late = deferred(); f.operation.mockImplementationOnce(() => late.promise);
  const task = f.api.read(own.id); await settle(); f.operation.mockResolvedValueOnce(detail()); await f.api.read(opened.id);
  late.resolve(detail(own, 'Synthetic obsolete own')); await task; expect(f.api.getSnapshot().reader?.prediction.id).toBe(opened.id);
  const g = fixture(); await g.load([own]); g.operation.mockResolvedValueOnce(detail(ownOpened)); await g.api.read(own.id);
  expect(g.api.getSnapshot().readerStatus).toBe('changed'); expect(g.api.getSnapshot().reader).toBeNull();
  g.operation.mockResolvedValueOnce(detail(ownOpened)); await g.api.read(own.id); expect(g.api.getSnapshot().reader?.text).toBe(prose);
  g.operation.mockResolvedValueOnce(detail({ ...ownOpened, contentState: 'removed', version: 3 })); await g.api.read(own.id); expect(g.api.getSnapshot().reader).toBeNull();
});
it('history has no sequence, must contain all known IDs and <=100 unique monotone records', async () => {
  for (const response of [list([own, own]), list([{ ...own, sequence: 1 }]), list([{ ...own, text: prose }]),
    list([own], '2020-01-01T00:00:00.000Z'), envelope({ predictions: [], checkedAt: due, capacity: 99, used: 0 }),
    envelope({ predictions: [], checkedAt: due, capacity: 100, used: '0' })]) {
    const f = fixture(); f.operation.mockResolvedValueOnce(response); await f.api.load(); expect(f.api.getSnapshot().checked).toBe(false); expect(f.api.getSnapshot().error).toBe(true);
  }
  const f = fixture(); await f.load([own, incoming]); f.operation.mockResolvedValueOnce(list([own])); await f.api.load(); expect(f.api.getSnapshot().predictions).toHaveLength(2);
  const hundred = Array.from({ length: 100 }, (_, n) => ({ ...own, id: uuid(300 + n) })); const cap = fixture(); await cap.load(hundred, before); cap.schedule();
  await cap.api.create(true); expect(cap.api.getSnapshot().status).toBe('limit'); expect(cap.operation).toHaveBeenCalledTimes(1);
  cap.operation.mockResolvedValueOnce(detail(hundred[0], prose, before)); await cap.api.read(hundred[0].id); expect(cap.api.getSnapshot().reader?.text).toBe(prose);
});
it('malformed body, private headers, byte bounds and clock rollback fail closed', async () => {
  for (const response of [detail(opened, ' bad '), detail(opened, ''), detail(opened, 'x'.repeat(32769)), detail(opened, prose, before),
    envelope({ prediction: opened, checkedAt: due, text: prose, extra: true }), new Response(JSON.stringify({ ok: true, value: { prediction: opened, checkedAt: due, text: prose } }))]) {
    const f = fixture(); await f.load([opened]); f.operation.mockResolvedValueOnce(response); await f.api.read(opened.id); expect(f.api.getSnapshot().reader).toBeNull(); expect(f.api.getSnapshot().readerStatus).toBe('error');
  }
  const f = fixture(); await f.load([incoming]); f.operation.mockResolvedValueOnce(ack(opened, true, uuid(3), before)); await f.api.open(incoming.id, true); expect(f.api.getSnapshot().status).toBe('retry');
});
it('scope/session/cookie replacement clears draft, schedule, metadata and bodies; obsolete open ACK cannot start GET', async () => {
  const f = fixture(); f.schedule(); await f.load([incoming]); const late = deferred(); f.operation.mockImplementationOnce(() => late.promise);
  const task = f.api.open(incoming.id, true); await settle(); f.set({ generation: 2, identity: { userId: 'other', sessionId: 'other' }, context: { ...context, membershipEpoch: 2 } }); f.controller.sync();
  late.resolve(ack(opened)); await task; expect(f.api.getSnapshot().reader).toBeNull(); expect(f.api.getSnapshot().draft).toBe(''); expect(f.api.getSnapshot().schedule.timezone).toBe(''); expect(f.api.getSnapshot().predictions).toEqual([]);
  expect(f.operation).toHaveBeenCalledTimes(2); f.set(null); f.controller.sync(); await f.api.load(); expect(f.api.getSnapshot().available).toBe(false);
  const g = fixture(); await g.load([opened]); g.host.getCookie.mockResolvedValueOnce('synthetic=cookie').mockResolvedValueOnce('changed'); await g.api.read(opened.id);
  expect(g.host.block).toHaveBeenCalledWith('auth_required'); expect(g.api.getSnapshot().available).toBe(false);
  for (const code of [401, 403]) { const h = fixture(); h.operation.mockResolvedValueOnce(error('unavailable', code)); await h.api.load(); expect(h.api.getSnapshot().available).toBe(false); }
  const h = fixture(); h.operation.mockResolvedValueOnce(error('stale_membership', 409)); await h.api.load(); expect(h.api.getSnapshot().available).toBe(false);
});
it('transport/context/conflict/not_due failures preserve honest unknown outcomes and require deliberate refresh', async () => {
  const f = fixture(); f.discovery.mockRejectedValueOnce(Error('offline')); await f.api.load(); expect(f.api.getSnapshot().error).toBe(true);
  f.discovery.mockResolvedValueOnce(error('unauthenticated', 401)); await f.api.load(); expect(f.api.getSnapshot().available).toBe(false);
  const changed = fixture(); changed.discovery.mockResolvedValueOnce(envelope({ ...context, membershipEpoch: 2 })); await changed.api.load(); expect(changed.host.refresh).toHaveBeenCalled();
  for (const code of ['version_conflict', 'idempotency_conflict', 'capacity_reached', 'not_due']) {
    const g = fixture(); await g.load([incoming]); g.operation.mockResolvedValueOnce(error(code, 409)); await g.api.open(incoming.id, true);
    expect(g.api.getSnapshot().requiresRefresh).toBe(true); expect(g.api.getSnapshot().pending).toBe(false);
    const n = g.operation.mock.calls.length; await g.api.open(incoming.id, true); expect(g.operation).toHaveBeenCalledTimes(n);
  }
  for (const status of [400, 404, 503]) { const g = fixture(); await g.load([incoming]); g.operation.mockResolvedValueOnce(error(status === 400 ? 'invalid_request' : 'unavailable', status)); await g.api.open(incoming.id, true); expect(g.api.getSnapshot().status).toBe(status === 400 ? 'invalid' : 'retry'); }
  const missing = fixture(); missing.operation.mockResolvedValueOnce(error('not_found', 404)); await missing.api.load(); expect(missing.api.getSnapshot().status).toBe('unavailable');
  expect(() => createPredictionsController({ mode: 'synthetic-loopback', baseURL: 'https://remote.invalid' }, fixture().host, async () => list(), () => uuid(3))).toThrow();
});
it('creation ACK is tied to immutable schedule, initial server clock and previously absent identity; replay can advance after unknown outcome', async () => {
  for (const q of [{ ...own, createdAt: '2026-11-09T00:00:00.000Z' },
    { ...own, localDate: '2026-11-12', releaseAt: '2026-11-12T06:00:00.000Z' }, ownOpened]) {
    const f = fixture(); await f.load([], before); f.schedule(); f.operation.mockResolvedValueOnce(ack(q, false)); await f.api.create(true);
    expect(f.api.getSnapshot().status).toBe('retry'); expect(f.api.getSnapshot().draft).toBe(prose);
  }
  const f = fixture(); await f.load([own], before); f.schedule(); f.operation.mockResolvedValueOnce(ack(own, true)); await f.api.create(true);
  expect(f.api.getSnapshot().status).toBe('retry');
  const g = fixture(); await g.load([], before); g.schedule(); g.operation.mockRejectedValueOnce(Error('unknown')); await g.api.create(true);
  await g.load([ownOpened]); g.operation.mockResolvedValueOnce(ack(ownOpened, true)); await g.api.retry();
  expect(g.api.getSnapshot().pending).toBe(false); expect(g.api.getSnapshot().predictions[0]).toEqual(ownOpened); expect(g.api.getSnapshot().reader).toBeNull();
});
it('late rejected transport after context reset cannot revive pending work or reader text', async () => {
  const f = fixture(); await f.load([incoming]); let reject!: (e: Error) => void;
  const lost = new Promise<Response>((_resolve, no) => { reject = no; }); f.operation.mockImplementationOnce(() => lost);
  const task = f.api.open(incoming.id, true); await settle(); f.set(null); f.controller.sync(); reject(Error('late network failure')); await task;
  expect(f.api.getSnapshot().available).toBe(false); expect(f.api.getSnapshot().pending).toBe(false); expect(f.api.getSnapshot().reader).toBeNull();
  f.api.setDraft('ignored'); f.api.setSchedule('timezone', 'UTC'); expect(f.api.getSnapshot().draft).toBe(''); expect(f.api.getSnapshot().schedule.timezone).toBe('');
});
