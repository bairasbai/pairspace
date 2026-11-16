import { createCapsulesController } from '../src/auth/capsules';
import { ack, before, context, deferred, detail, due, envelope, error, fixture, list, own, prose, removed, resealed, schedule, settle, uuid } from './capsules-fixtures';
it('idle uses no network; explicit confirmed creation uses exact HTTP fields and clears only submitted form', async () => {
 const f = fixture(); expect(f.operation).not.toHaveBeenCalled(); expect(f.api.getSnapshot().revision).toBeGreaterThan(0);
 await f.api.create(false); await f.api.create('true' as unknown as boolean); expect(f.operation).not.toHaveBeenCalled();
 await f.api.create(true); expect(f.api.getSnapshot().requiresRefresh).toBe(true);
 await f.load([], before); await f.api.create(true); expect(f.api.getSnapshot().status).toBe('invalid');
 f.schedule(); f.api.setDraft(' e\u0301\r\n next '); f.operation.mockResolvedValueOnce(ack(own, false, uuid(3), before)); await f.api.create(true);
 const request = f.operation.mock.calls[1][0]; expect(request.method).toBe('POST'); expect(request.url).toContain('/capsules');
 expect(await request.json()).toEqual({ text: 'é\n next', schedule, confirm: true, membership_epoch: 1, command_id: uuid(3) });
 expect(request.headers.get('idempotency-key')).toBe(uuid(3)); expect(request.headers.get('cookie')).toBe('synthetic=cookie');
 expect(request.credentials).toBe('omit'); expect(request.redirect).toBe('error'); expect(request.cache).toBe('no-store');
 expect(f.api.getSnapshot().draft).toBe(''); expect(f.api.getSnapshot().checked).toBe(false); expect(Object.isFrozen(f.api.getSnapshot().capsules[0])).toBe(true);
});
it('schedule and body validation reject invalid commands; year suggestion uses server day and explicit zone', async () => {
 const f = fixture(); f.api.suggestYear(); expect(f.api.getSnapshot().schedule.localDate).toBe('');
 await f.load([], before); f.api.suggestYear(); expect(f.api.getSnapshot().schedule.localDate).toBe('');
 f.schedule(); f.api.suggestYear(); expect(f.api.getSnapshot().schedule.localDate).toBe('2027-11-10');
 f.api.setSchedule('timezone', 'bad'); f.api.suggestYear(); expect(f.api.getSnapshot().status).toBe('invalid');
 for (const bad of [{ ...schedule, localDate: '2026-11-10' }, { ...schedule, timezone: '' }, { ...schedule, offset: '+04:00' }]) {
  f.schedule(bad); await f.api.create(true); expect(f.api.getSnapshot().status).toBe('invalid');
 }
 f.schedule(); for (const bad of ['', 'x'.repeat(2001), 'a\rb']) { f.api.setDraft(bad); await f.api.create(true); expect(f.api.getSnapshot().status).toBe('invalid'); }
 f.api.setDraft('x'.repeat(8001)); expect(f.api.getSnapshot().draft.length).toBe(8000); f.api.setDraft('ok'); f.command.mockReturnValueOnce('bad'); await f.api.create(true);
 f.api.setSchedule('timezone', 'x'.repeat(101)); expect(f.api.getSnapshot().schedule.timezone.length).toBe(100); expect(f.operation).toHaveBeenCalledTimes(1);
});
it('mounted unknown create retry keeps exact payload through editing; legitimate replay reconstructs original schedule', async () => {
 const f = fixture(); await f.load([], before); f.schedule(); f.operation.mockRejectedValueOnce(Error('lost ACK')); await f.api.create(true);
 expect(f.api.getSnapshot().pending).toBe(true); f.api.cancelDraft(); expect(f.api.getSnapshot().draft).toBe(''); expect(f.api.getSnapshot().pending).toBe(true);
 f.api.setDraft('Newer'); f.api.setSchedule('timezone', 'UTC');
 f.operation.mockResolvedValueOnce(ack(resealed, true, uuid(3), due)); await f.api.retry();
 expect(await f.operation.mock.calls[1][0].json()).toEqual(await f.operation.mock.calls[2][0].json());
 expect(f.api.getSnapshot().draft).toBe('Newer'); expect(f.api.getSnapshot().schedule.timezone).toBe('UTC'); expect(f.api.getSnapshot().pending).toBe(false);
 expect(f.api.getSnapshot().capsules).toEqual([resealed]); expect(f.api.getSnapshot().reader).toBeNull(); await f.api.retry(); expect(f.operation).toHaveBeenCalledTimes(3);
});
it('reseal is confirmed PUT CAS, supplies only new text; remove is terminal DELETE with body-free ACK', async () => {
 const f = fixture(); await f.load([own], before); await f.api.reseal(own.id, false); await f.api.reseal(uuid(999), true); expect(f.operation).toHaveBeenCalledTimes(1);
 f.schedule({ ...schedule, localDate: '2026-11-13' }); f.api.setDraft('New synthetic');
 f.operation.mockResolvedValueOnce(ack(resealed, false, uuid(3), resealed.sealedAt)); await f.api.reseal(own.id, true);
 const request = f.operation.mock.calls[1][0]; expect(request.method).toBe('PUT'); expect(request.url).toContain('/capsules/' + own.id);
 expect(await request.json()).toEqual({ membership_epoch: 1, command_id: uuid(3), confirm: true, expected_version: 1, text: 'New synthetic', schedule: { ...schedule, localDate: '2026-11-13' } });
 const tombstone = { ...resealed, version: 3, contentState: 'removed' };
 f.operation.mockResolvedValueOnce(ack(tombstone, false, uuid(3), due)); await f.api.remove(own.id, true);
 expect(f.operation.mock.calls[2][0].method).toBe('DELETE'); expect(await f.operation.mock.calls[2][0].json()).toEqual({ membership_epoch: 1, command_id: uuid(3), expected_version: 2, confirm: true });
 await f.api.remove(own.id, true); await f.api.reseal(own.id, true); expect(f.operation).toHaveBeenCalledTimes(3);
 await f.load([tombstone]); await f.api.create(true); expect(f.api.getSnapshot().status).toBe('limit');
});
it('even owner cannot fetch before server due; explicit read is separate, close/unmount cancels late body', async () => {
 const f = fixture(); await f.load([own], before); await f.api.read(own.id); expect(f.operation).toHaveBeenCalledTimes(1);
 await f.load([own]); await f.api.reseal(own.id, true); expect(f.api.getSnapshot().status).toBe('not_due');
 const held = deferred(); f.operation.mockImplementationOnce(() => held.promise); const task = f.api.read(own.id); await settle();
 expect(f.api.getSnapshot().readerStatus).toBe('loading'); f.api.leaveScreen(); held.resolve(detail()); await task;
 expect(f.api.getSnapshot().reader).toBeNull(); expect(f.api.getSnapshot().readerStatus).toBe('closed'); expect(f.api.getSnapshot().draft).toBe('');
 await f.load([own]); f.operation.mockResolvedValueOnce(detail()); await f.api.read(own.id); expect(f.api.getSnapshot().reader?.text).toBe(prose);
 f.api.close(); expect(f.api.getSnapshot().reader).toBeNull();
});
it('late mutation ACK after screen exit is discarded and unknown command requires metadata refresh', async () => {
 const f = fixture(); await f.load([], before); f.schedule(); const held = deferred(); f.operation.mockImplementationOnce(() => held.promise);
 const task = f.api.create(true); await settle(); f.api.leaveScreen(); held.resolve(ack(own, false, uuid(3), before)); await task;
 expect(f.api.getSnapshot()).toMatchObject({ status: 'conflict', draft: '', reader: null, pending: false, requiresRefresh: true, capsules: [] }); await f.api.retry(); expect(f.operation).toHaveBeenCalledTimes(2);
});
it('scope/logout reset clears pending/draft/body and rejects late ACK or reader completion', async () => {
 for (const reading of [false, true]) {
  const f = fixture(); await f.load(reading ? [own] : [], reading ? due : before); f.schedule(); const held = deferred(); f.operation.mockImplementationOnce(() => held.promise);
  const task = reading ? f.api.read(own.id) : f.api.create(true); await settle(); const generation = f.api.getSnapshot().generation;
  f.set(null); f.controller.sync(); expect(f.api.getSnapshot().generation).toBeGreaterThan(generation);
  held.resolve(reading ? detail() : ack(own, false, uuid(3), before)); await task;
  expect(f.api.getSnapshot()).toMatchObject({ available: false, pending: false, draft: '', reader: null, capsules: [] });
 }
});
it('same-session cookie replacement and context mismatch fail closed before private operation', async () => {
 const f = fixture(); f.host.getCookie.mockResolvedValueOnce('first').mockResolvedValueOnce('second'); await f.api.load();
 expect(f.host.block).toHaveBeenCalledWith('auth_required'); expect(f.operation).not.toHaveBeenCalled();
 const g = fixture(); g.discovery.mockResolvedValueOnce(envelope({ ...context, membershipEpoch: 2 })); await g.api.load();
 expect(g.host.refresh).toHaveBeenCalled(); expect(g.operation).not.toHaveBeenCalled(); expect(g.api.getSnapshot().draft).toBe('');
});
it.each([401, 403])('access failure %s scrubs scope', async status => {
 const f = fixture(); f.operation.mockResolvedValueOnce(error('unavailable', status)); await f.api.load(); expect(f.host.block).toHaveBeenCalledWith('access_required'); expect(f.api.getSnapshot().available).toBe(false);
});
it.each(['version_conflict', 'idempotency_conflict', 'capacity_reached', 'not_due'])('known command rejection %s requires refresh without retries', async code => {
 const f = fixture(); await f.load([], before); f.schedule(); f.operation.mockResolvedValueOnce(error(code, 409)); await f.api.create(true);
 expect(f.api.getSnapshot()).toMatchObject({ pending: false, requiresRefresh: true, error: true }); await f.api.retry(); expect(f.operation).toHaveBeenCalledTimes(2);
});
it('invalid request permits corrected form; stale membership blocks; 404 retains unknown command', async () => {
 const f = fixture(); await f.load([], before); f.schedule(); f.operation.mockResolvedValueOnce(error('invalid_request', 400)); await f.api.create(true); expect(f.api.getSnapshot()).toMatchObject({ pending: false, status: 'invalid' });
 f.api.setDraft('New distinct draft'); f.operation.mockResolvedValueOnce(error('not_found', 404)); await f.api.create(true); expect(f.api.getSnapshot()).toMatchObject({ pending: true, status: 'retry' });
 f.operation.mockResolvedValueOnce(error('stale_membership', 409)); await f.api.retry(); expect(f.host.block).toHaveBeenCalledWith('access_required');
});
it('strict list rejects partner metadata, extra text, missing history, version and clock rollback, wrong capacity', async () => {
 const bad = [{ capsules: [own], checkedAt: due, used: 1, capacity: 2 }, { capsules: [own, own], checkedAt: due, used: 2, capacity: 1 },
  { capsules: [{ ...own, authorId: uuid(4) }], checkedAt: due, used: 1, capacity: 1 }, { capsules: [{ ...own, text: prose }], checkedAt: due, used: 1, capacity: 1 },
  { capsules: [own], checkedAt: before, used: 1, capacity: 1 }, { capsules: [], checkedAt: due, used: 0, capacity: 1 }];
 for (const value of bad) { const f = fixture(); await f.load([own]); f.operation.mockResolvedValueOnce(envelope(value)); await f.api.load(); expect(f.api.getSnapshot().error).toBe(true); expect(f.api.getSnapshot().capsules).toEqual([own]); }
 const f = fixture(); await f.load([resealed]); f.operation.mockResolvedValueOnce(list([own])); await f.api.load(); expect(f.api.getSnapshot().error).toBe(true);
});
it('strict read rejects unrequested/invalid text, metadata mismatch, pre-due response and server clock rollback', async () => {
 for (const value of [ { capsule: own, checkedAt: due }, { capsule: own, checkedAt: due, text: ' noncanonical ' },
  { capsule: own, checkedAt: due, text: prose, extra: 1 }, { capsule: own, checkedAt: before, text: prose },
  { capsule: { ...own, id: uuid(99) }, checkedAt: due, text: prose }, { capsule: removed, checkedAt: due, text: prose } ]) {
  const f = fixture(); await f.load([own]); f.operation.mockResolvedValueOnce(envelope(value)); await f.api.read(own.id); expect(f.api.getSnapshot().reader).toBeNull(); expect(f.api.getSnapshot().readerStatus).toBe('error');
 }
 const f = fixture(); await f.load([own]); f.operation.mockResolvedValueOnce(detail(removed)); await f.api.read(own.id); expect(f.api.getSnapshot().readerStatus).toBe('changed');
});
it('strict ACK cannot include body, lie about operation, regression, command or replay shape', async () => {
 for (const value of [{ capsule: own, checkedAt: before, commandId: uuid(3), replay: false, text: prose },
  { capsule: own, checkedAt: before, commandId: uuid(4), replay: false }, { capsule: own, checkedAt: before, commandId: uuid(3), replay: 'yes' },
  { capsule: resealed, checkedAt: due, commandId: uuid(3), replay: false }, { capsule: { ...own, authorId: uuid(4) }, checkedAt: before, commandId: uuid(3), replay: true }]) {
  const f = fixture(); await f.load([], before); f.schedule(); f.operation.mockResolvedValueOnce(envelope(value)); await f.api.create(true); expect(f.api.getSnapshot()).toMatchObject({ pending: true, status: 'retry', reader: null });
 }
});
it('responses require private headers, exact envelope and bounded successful JSON', async () => {
 for (const response of [new Response('{}'), new Response('bad', { headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } }),
  envelope({ capsules: [], checkedAt: due, used: 0, capacity: 1 }, 503), envelope(null)]) {
  const f = fixture(); f.operation.mockResolvedValueOnce(response); await f.api.load(); expect(f.api.getSnapshot().error).toBe(true);
 }
});
it('subscriptions unsubscribe and unavailable controller ignores draft/schedule/commands', async () => {
 const f = fixture(), listener = jest.fn(), off = f.api.subscribe(listener); f.api.setDraft('changed'); expect(listener).toHaveBeenCalled(); off(); listener.mockClear();
 f.api.cancelDraft(); expect(listener).not.toHaveBeenCalled(); f.set(null); f.controller.sync(); const rev = f.api.getSnapshot().revision;
 f.api.setDraft('ignored'); f.api.setSchedule('timezone', 'UTC'); f.api.suggestYear(); await f.api.read(own.id); await f.api.create(true); await f.api.load(); expect(f.api.getSnapshot().revision).toBe(rev);
 expect(() => createCapsulesController({ mode: 'synthetic-loopback', baseURL: 'https://example.com' }, f.host, async () => list(), () => uuid(3))).toThrow();
});
it('discovery transport failures are retryable but revoked auth scrubs private state', async () => {
 const f = fixture(); f.discovery.mockRejectedValueOnce(Error('offline')); await f.api.load();
 expect(f.api.getSnapshot().error).toBe(true); expect(f.host.block).not.toHaveBeenCalled();
 const g = fixture(); g.discovery.mockResolvedValueOnce(error('unauthenticated', 401)); await g.api.load();
 expect(g.host.block).toHaveBeenCalledWith('auth_required'); expect(g.api.getSnapshot().draft).toBe('');
});
it('scope rotation while body JSON is pending cannot publish text, including cookie change after operation', async () => {
 const f = fixture(); await f.load([own]); const held = deferred(); f.operation.mockImplementationOnce(() => held.promise);
 const task = f.api.read(own.id); await settle();
 f.set({ generation: 2, identity: { sessionId: 'other', userId: 'other' }, context: { ...context, sessionId: 'other', coupleId: uuid(77) } });
 held.resolve(detail()); await task; expect(f.api.getSnapshot().reader).toBeNull(); expect(f.api.getSnapshot().capsules).toEqual([]);
 const g = fixture(); await g.load([own]); g.operation.mockImplementationOnce(async () => { g.host.getCookie.mockResolvedValue('changed'); return detail(); });
 await g.api.read(own.id); expect(g.host.block).toHaveBeenCalledWith('auth_required'); expect(g.api.getSnapshot().reader).toBeNull();
});
it('screen exit aborts in-flight mutation and clears unknown payload before re-entry', async () => {
 const f = fixture(); await f.load([], before); f.schedule(); const held = deferred(); f.operation.mockImplementationOnce(() => held.promise);
 const task = f.api.create(true); await settle(); const sent = f.operation.mock.calls[1][0];
 expect(sent.signal.aborted).toBe(false); f.api.leaveScreen(); expect(sent.signal.aborted).toBe(true);
 expect(f.api.getSnapshot()).toMatchObject({ pending: false, draft: '', requiresRefresh: true });
 held.resolve(ack()); await task; await f.api.retry(); expect(f.operation).toHaveBeenCalledTimes(2);
 await f.load([own]); expect(f.api.getSnapshot().requiresRefresh).toBe(false); expect(f.api.getSnapshot().draft).toBe('');
});

it.each(['create', 'reseal'] as const)('%s hides confirmed original before request and lost ACK; retry never restores it', async kind => {
 const f = fixture(); await f.load(kind === 'create' ? [] : [own], before);
 f.schedule(kind === 'create' ? schedule : { ...schedule, localDate: '2026-11-13' });
 f.api.setDraft('Submitted sealed original'); const revision = f.api.getSnapshot().revision;
 const held = deferred(); f.operation.mockImplementationOnce(() => held.promise);
 const task = kind === 'create' ? f.api.create(true) : f.api.reseal(own.id, true);
 expect(f.api.getSnapshot().draft).toBe(''); expect(f.api.getSnapshot().revision).toBeGreaterThan(revision);
 await settle(); held.resolve(error('temporarily_unavailable', 503)); await task;
 expect(f.api.getSnapshot()).toMatchObject({ draft: '', pending: true, status: 'retry' });
 const submitted = await f.operation.mock.calls[1][0].clone().json(); expect(submitted.text).toBe('Submitted sealed original');
 f.api.setDraft('Distinct newer draft'); f.api.setSchedule('timezone', 'UTC');
 f.operation.mockResolvedValueOnce(ack(kind === 'create' ? own : resealed, true, uuid(3), due)); await f.api.retry();
 expect(await f.operation.mock.calls[2][0].json()).toEqual(submitted);
 expect(f.api.getSnapshot().draft).toBe('Distinct newer draft'); expect(f.api.getSnapshot().schedule.timezone).toBe('UTC');
});
it.each(['invalid', 'network'] as const)('confirmed original remains absent after %s failure', async failure => {
 const f = fixture(); await f.load([], before); f.schedule(); f.api.setDraft('Original must disappear');
 if (failure === 'invalid') f.operation.mockResolvedValueOnce(error('invalid_request', 400));
 else f.operation.mockRejectedValueOnce(Error('offline'));
 await f.api.create(true); expect(f.api.getSnapshot().draft).toBe('');
 expect(f.api.getSnapshot().pending).toBe(failure === 'network');
});
