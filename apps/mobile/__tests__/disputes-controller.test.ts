import { createDisputesController } from '../src/auth/disputes';
import { ack, before, condition, context, deferred, detail, due, envelope, error, fixture, incoming, joined, own, prose, removed, resolved, settle, uuid } from './disputes-fixtures';
it('idle makes no requests; canonical confirmed create is POST with exact body, protected headers and immediate draft scrub', async () => {
 const f = fixture(); expect(f.operation).not.toHaveBeenCalled(); await f.api.create(false); await f.api.create('true' as unknown as boolean);
 expect(f.operation).not.toHaveBeenCalled(); await f.api.create(true); expect(f.api.getSnapshot().requiresRefresh).toBe(true);
 await f.load(); f.schedule(); f.api.setClaim(' e\u0301\r\nnext '); f.api.setCondition('   ');
 const held = deferred(); f.operation.mockImplementationOnce(() => held.promise);
 const task = f.api.create(true); expect(f.api.getSnapshot().draftClaim).toBe(''); expect(f.api.getSnapshot().draftCondition).toBe('');
 await settle(); const request = f.operation.mock.calls[1][0]; expect(request.method).toBe('POST');
 expect(await request.json()).toEqual({ claim: 'é\nnext', condition: null, judge_date: own.judgeDate, timezone: own.timezone, confirm: true, membership_epoch: 1, command_id: uuid(3) });
 expect(request.headers.get('idempotency-key')).toBe(uuid(3)); expect(request.headers.get('cookie')).toBe('synthetic=cookie');
 expect(request.credentials).toBe('omit'); expect(request.redirect).toBe('error'); expect(request.cache).toBe('no-store');
 held.resolve(ack()); await task; expect(f.api.getSnapshot()).toMatchObject({ status: 'saved', pending: false, checked: false });
 expect(Object.isFrozen(f.api.getSnapshot().disputes[0])).toBe(true);
});
it('form validation and bounds fail closed without private requests', async () => {
 const f = fixture(); await f.load(); await f.api.create(true); expect(f.api.getSnapshot().status).toBe('invalid'); f.schedule();
 for (const claim of ['', 'x'.repeat(2001), 'a\rb']) { f.api.setClaim(claim); await f.api.create(true); expect(f.api.getSnapshot().status).toBe('invalid'); }
 f.api.setClaim(prose); f.api.setCondition('x'.repeat(501)); await f.api.create(true); expect(f.api.getSnapshot().status).toBe('invalid');
 f.api.setCondition(''); f.api.setJudgeDate('2026-11-10'); await f.api.create(true); expect(f.api.getSnapshot().status).toBe('invalid');
 f.schedule(); f.command.mockReturnValueOnce('bad'); await f.api.create(true); expect(f.operation).toHaveBeenCalledTimes(1);
 f.api.setClaim('x'.repeat(9000)); f.api.setCondition('x'.repeat(3000)); f.api.setTimezone('x'.repeat(110)); f.api.setJudgeDate('x'.repeat(20));
 expect(f.api.getSnapshot()).toMatchObject({ draftClaim: 'x'.repeat(8000), draftCondition: 'x'.repeat(2000), timezone: 'x'.repeat(100), judgeDate: 'x'.repeat(10) });
});
it('lost ACK retains exact mounted retry payload, never restores original terms, and preserves newer form', async () => {
 const f = fixture(); await f.load(); f.schedule(); f.operation.mockRejectedValueOnce(Error('lost ACK')); await f.api.create(true);
 expect(f.api.getSnapshot()).toMatchObject({ pending: true, status: 'retry', draftClaim: '', draftCondition: '' });
 f.api.setClaim('New draft'); f.api.setCondition('New condition'); f.api.setTimezone('UTC');
 f.operation.mockResolvedValueOnce(ack(removed, true, uuid(3), due)); await f.api.retry();
 expect(await f.operation.mock.calls[1][0].json()).toEqual(await f.operation.mock.calls[2][0].json());
 expect(f.api.getSnapshot()).toMatchObject({ pending: false, status: 'saved', draftClaim: 'New draft', draftCondition: 'New condition', timezone: 'UTC', reader: null });
 expect(f.api.getSnapshot().disputes).toEqual([removed]); await f.api.retry(); expect(f.operation).toHaveBeenCalledTimes(3);
});
it('join requires explicitly read current terms and confirmation, not a list, loading, error or closed reader', async () => {
 const f = fixture(); await f.load([incoming]); await f.api.join(incoming.id, true); expect(f.operation).toHaveBeenCalledTimes(1);
 f.operation.mockRejectedValueOnce(Error('offline')); await f.api.read(incoming.id); await f.api.join(incoming.id, true); expect(f.operation).toHaveBeenCalledTimes(2);
 const held = deferred(); f.operation.mockImplementationOnce(() => held.promise); const reading = f.api.read(incoming.id); await settle();
 await f.api.join(incoming.id, true); expect(f.operation).toHaveBeenCalledTimes(3);
 held.resolve(detail(incoming)); await reading; expect(f.api.getSnapshot().reader?.generation).toBe(f.api.getSnapshot().generation);
 f.api.close(); await f.api.join(incoming.id, true); expect(f.operation).toHaveBeenCalledTimes(3);
 await f.read(incoming); await f.api.join(incoming.id, false); expect(f.operation).toHaveBeenCalledTimes(4);
 const accepted = { ...incoming, joinedAt: before, version: 2, decisionState: 'joined' as const };
 f.operation.mockResolvedValueOnce(ack(accepted)); await f.api.join(incoming.id, true);
 expect(f.api.getSnapshot().status).toBe('saved'); expect(f.api.getSnapshot().reader).toBeNull();
 const request = f.operation.mock.calls[4][0]; expect(request.url).toContain('/' + incoming.id + '/join');
 expect(await request.json()).toEqual({ membership_epoch: 1, command_id: uuid(3), confirm: true, expected_version: 1 });
});
it('roles, server local date and terminal states gate actions; declined means no winner', async () => {
 const f = fixture(); await f.load([own]); await f.read(); await f.api.join(own.id, true); expect(f.operation).toHaveBeenCalledTimes(2);
 await f.api.decline(own.id, true); expect(f.api.getSnapshot().status).toBe('conflict');
 const g = fixture(); await g.load([incoming], due); await g.read(incoming, due); await g.api.join(incoming.id, true); expect(g.api.getSnapshot().status).toBe('not_due');
 const declined = { ...incoming, declinedAt: due, decisionState: 'declined' as const, version: 2 };
 g.operation.mockResolvedValueOnce(ack(declined, false, uuid(3), due)); await g.api.decline(incoming.id, true); expect(g.api.getSnapshot().status).toBe('saved');
 expect(g.api.getSnapshot().disputes[0]).toMatchObject({ winnerId: null, resolvedAt: null });
 await g.api.remove(incoming.id, true); expect(g.api.getSnapshot().status).toBe('conflict');
});
it('explicit draw resolve after due uses CAS and preserved resolver; author deletion has no terms', async () => {
 const f = fixture(); await f.load([joined]); await f.read(joined); await f.api.resolve(joined.id, null, true); expect(f.api.getSnapshot().status).toBe('not_due');
 await f.load([joined], due); await f.read(joined, due); f.operation.mockResolvedValueOnce(ack(resolved, false, uuid(3), due)); await f.api.resolve(joined.id, null, true);
 expect(f.api.getSnapshot().status).toBe('saved'); expect(await f.operation.mock.calls[4][0].json()).toEqual({ membership_epoch: 1, command_id: uuid(3), expected_version: 2, confirm: true, winner_id: null });
 const gone = { ...resolved, contentState: 'removed' as const, removedAt: due, version: 4 };
 f.operation.mockResolvedValueOnce(ack(gone, false, uuid(3), due)); await f.api.remove(own.id, true);
 expect(f.api.getSnapshot().status).toBe('saved'); expect(f.operation.mock.calls[5][0].method).toBe('DELETE');
 expect(await f.operation.mock.calls[5][0].json()).not.toHaveProperty('claim');
});
it('replayed join may return later terminal current metadata without opening terms', async () => {
 const f = fixture(); await f.load([incoming]); await f.read(incoming);
 f.operation.mockRejectedValueOnce(Error('lost ACK')); await f.api.join(incoming.id, true);
 const gone = { ...incoming, joinedAt: before, declinedAt: due, removedAt: due, version: 4, decisionState: 'declined' as const, contentState: 'removed' as const };
 f.operation.mockResolvedValueOnce(ack(gone, true, uuid(3), due)); await f.api.retry();
 expect(f.api.getSnapshot()).toMatchObject({ status: 'saved', reader: null, pending: false });
});
it('leaving aborts and scrubs all state including uncertain private payload; late completion cannot repopulate', async () => {
 for (const reading of [false, true]) {
  const f = fixture(); await f.load(reading ? [own] : []); f.schedule(); const held = deferred(); f.operation.mockImplementationOnce(() => held.promise);
  const task = reading ? f.api.read(own.id) : f.api.create(true); await settle(); const request = f.operation.mock.calls[1][0];
  const generation = f.api.getSnapshot().generation; f.api.leaveScreen(); expect(request.signal.aborted).toBe(true);
  held.resolve(reading ? detail() : ack()); await task; expect(f.api.getSnapshot()).toMatchObject({ draftClaim: '', draftCondition: '', reader: null, pending: false, disputes: [], requiresRefresh: true });
  expect(f.api.getSnapshot().generation).toBeGreaterThan(generation); await f.api.retry(); expect(f.operation).toHaveBeenCalledTimes(2);
 }
});
it('scope change or logout while awaiting invalidates late response and private reader', async () => {
 const f = fixture(); await f.load([own]); const held = deferred(); f.operation.mockImplementationOnce(() => held.promise);
 const task = f.api.read(own.id); await settle(); f.set(null); f.controller.sync(); held.resolve(detail()); await task;
 expect(f.api.getSnapshot()).toMatchObject({ available: false, reader: null, disputes: [], draftClaim: '' });
 f.api.setClaim('ignored'); f.api.setCondition('ignored'); f.api.setJudgeDate('ignored'); f.api.setTimezone('ignored');
 expect(f.api.getSnapshot().draftClaim).toBe(''); await f.api.create(true); await f.api.read(own.id);
});
it('same-session cookie replacement and context mismatch fail closed before private operation', async () => {
 const f = fixture(); f.host.getCookie.mockResolvedValueOnce('first').mockResolvedValueOnce('second'); await f.api.refresh();
 expect(f.host.block).toHaveBeenCalledWith('auth_required'); expect(f.operation).not.toHaveBeenCalled();
 const g = fixture(); g.discovery.mockResolvedValueOnce(envelope({ ...context, membershipEpoch: 2 })); await g.api.refresh();
 expect(g.host.refresh).toHaveBeenCalled(); expect(g.operation).not.toHaveBeenCalled();
});
it.each([401, 403])('access failure %s clears scope', async status => {
 const f = fixture(); f.operation.mockResolvedValueOnce(error('unavailable', status)); await f.api.refresh(); expect(f.host.block).toHaveBeenCalledWith('access_required'); expect(f.api.getSnapshot().available).toBe(false);
});
it.each(['version_conflict', 'idempotency_conflict', 'capacity_reached', 'not_due'])('known rejection %s forbids hidden retries until refresh', async code => {
 const f = fixture(); await f.load(); f.schedule(); f.operation.mockResolvedValueOnce(error(code, 409)); await f.api.create(true);
 expect(f.api.getSnapshot()).toMatchObject({ pending: false, requiresRefresh: true, error: true }); await f.api.retry(); expect(f.operation).toHaveBeenCalledTimes(2);
});
it('invalid request clears pending, 404 preserves unknown command, stale membership resets', async () => {
 const f = fixture(); await f.load(); f.schedule(); f.operation.mockResolvedValueOnce(error('invalid_request', 400)); await f.api.create(true); expect(f.api.getSnapshot().status).toBe('invalid');
 f.api.setClaim('New distinct claim'); f.operation.mockResolvedValueOnce(error('not_found', 404)); await f.api.create(true); expect(f.api.getSnapshot()).toMatchObject({ pending: true, status: 'retry' });
 f.operation.mockResolvedValueOnce(error('stale_membership', 409)); await f.api.retry(); expect(f.host.block).toHaveBeenCalledWith('access_required');
 const g = fixture(); g.operation.mockResolvedValueOnce(error('not_found', 404)); await g.api.refresh(); expect(g.api.getSnapshot().status).toBe('unavailable');
});
it('list rejects text injection, foreign scope, duplicates, omissions, capacity and clock rollback', async () => {
 for (const value of [ { disputes: [own], checkedAt: before, used: 1, capacity: 1 }, { disputes: [own, own], checkedAt: due, used: 2, capacity: 100 },
  { disputes: [{ ...own, claim: prose }], checkedAt: due, used: 1, capacity: 100 }, { disputes: [{ ...own, coupleId: uuid(99) }], checkedAt: due, used: 1, capacity: 100 },
  { disputes: [own], checkedAt: before, used: 1, capacity: 100 }, { disputes: [], checkedAt: due, used: 0, capacity: 100 } ]) {
  const f = fixture(); await f.load([own], due); f.operation.mockResolvedValueOnce(envelope(value)); await f.api.refresh(); expect(f.api.getSnapshot().error).toBe(true); expect(f.api.getSnapshot().disputes).toEqual([own]);
 }
});
it('explicit read rejects malformed or wrong body and never shows newer version automatically', async () => {
 for (const value of [{ dispute: own, checkedAt: before }, { dispute: own, checkedAt: before, claim: ' noncanonical ', condition },
  { dispute: own, checkedAt: before, claim: prose, condition: '' }, { dispute: own, checkedAt: before, claim: prose, condition, extra: true },
  { dispute: { ...own, id: uuid(99) }, checkedAt: before, claim: prose, condition }]) {
  const f = fixture(); await f.load([own]); f.operation.mockResolvedValueOnce(envelope(value)); await f.api.read(own.id);
  expect(f.api.getSnapshot().readerStatus).toBe('error'); expect(f.api.getSnapshot().reader).toBeNull();
 }
 const f = fixture(); await f.load([own]); f.operation.mockResolvedValueOnce(detail(joined)); await f.api.read(own.id);
 expect(f.api.getSnapshot().readerStatus).toBe('changed'); expect(f.api.getSnapshot().reader).toBeNull();
});
it('ACK rejects wrong command, injected terms, wrong schedule, impossible progression and non-replay later state', async () => {
 for (const value of [{ dispute: own, checkedAt: before, commandId: uuid(99), replay: false },
  { dispute: { ...own, claim: prose }, checkedAt: before, commandId: uuid(3), replay: false },
  { dispute: { ...own, judgeDate: '2026-11-12' }, checkedAt: before, commandId: uuid(3), replay: false },
  { dispute: joined, checkedAt: before, commandId: uuid(3), replay: false }]) {
  const f = fixture(); await f.load(); f.schedule(); f.operation.mockResolvedValueOnce(envelope(value)); await f.api.create(true);
  expect(f.api.getSnapshot()).toMatchObject({ pending: true, status: 'retry', reader: null });
 }
});
it('close cancels late reads, unchanged refresh preserves reader, changed metadata clears it', async () => {
 const f = fixture(); await f.load([own]); const held = deferred(); f.operation.mockImplementationOnce(() => held.promise);
 const task = f.api.read(own.id); await settle(); f.api.close(); held.resolve(detail()); await task; expect(f.api.getSnapshot().reader).toBeNull();
 await f.read(); await f.load([own]); expect(f.api.getSnapshot().reader?.claim).toBe(prose);
 await f.load([removed], due); expect(f.api.getSnapshot().reader).toBeNull();
});
it('configuration snapshot is copied, unavailable setters and unknown reads do not send', async () => {
 const f = fixture(); const config = { mode: 'synthetic-loopback' as const, baseURL: 'http://127.0.0.1:8787' }, request = jest.fn(async () => envelope(context));
 const c = createDisputesController(config, f.host, request, f.command); config.baseURL = 'https://foreign.invalid';
 await c.actions.refresh(); expect(request).not.toHaveBeenCalled(); c.sync(); await c.actions.read(uuid(99)); expect(request).not.toHaveBeenCalled();
 await c.actions.refresh(); expect(request.mock.calls.length).toBeGreaterThan(0);
});
it('context authentication failure resets while transport failure stays retryable', async () => {
 const f = fixture(); f.discovery.mockResolvedValueOnce(error('unauthenticated', 401)); await f.api.refresh();
 expect(f.host.block).toHaveBeenCalledWith('auth_required'); expect(f.api.getSnapshot().available).toBe(false);
 const g = fixture(); g.discovery.mockRejectedValueOnce(Error('offline')); await g.api.refresh();
 expect(g.host.block).not.toHaveBeenCalled(); expect(g.api.getSnapshot().error).toBe(true); expect(g.operation).not.toHaveBeenCalled();
});
it('scope change during response body await discards body rather than granting consent', async () => {
 const f = fixture(); await f.load([incoming]); const held = deferred();
 const response = detail(incoming); const original = response.body!; let release!: () => void;
 const pause = new Promise<void>(resolve => { release = resolve; });
 const stream = new ReadableStream<Uint8Array>({ async start(controller) {
   const reader = original.getReader(); const chunk = await reader.read(); await pause;
   if (chunk.value) controller.enqueue(chunk.value); controller.close(); reader.releaseLock();
 } });
 f.operation.mockImplementationOnce(() => held.promise); const task = f.api.read(incoming.id); await settle();
 held.resolve(new Response(stream, { headers: response.headers })); await settle();
 f.set(null); release(); await task; expect(f.api.getSnapshot()).toMatchObject({ available: false, reader: null });
});
it('cookie changes after private HTTP response or after body completion reset private scope', async () => {
 for (const changedCall of [3, 4]) {
  const f = fixture(); await f.load([own]); let calls = 0;
  f.host.getCookie.mockImplementation(async () => ++calls < changedCall ? 'synthetic=cookie' : 'replacement=cookie');
  f.operation.mockResolvedValueOnce(detail()); await f.api.read(own.id);
  expect(f.host.block).toHaveBeenCalledWith('auth_required'); expect(f.api.getSnapshot()).toMatchObject({ available: false, reader: null, disputes: [] });
 }
});
it('unexpected caching and oversized detail fail closed; read 404 exposes no reader', async () => {
 const f = fixture(); await f.load([own]);
 f.operation.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, value: { dispute: own, claim: prose, condition, checkedAt: before } })));
 await f.api.read(own.id); expect(f.api.getSnapshot().readerStatus).toBe('error');
 f.operation.mockResolvedValueOnce(detail(own, 'x'.repeat(40000))); await f.api.read(own.id); expect(f.api.getSnapshot().reader).toBeNull();
 f.operation.mockResolvedValueOnce(error('not_found', 404)); await f.api.read(own.id); expect(f.api.getSnapshot().readerStatus).toBe('error');
});
it('refresh retains mounted unknown retry but cannot exceed lifetime capacity', async () => {
 const f = fixture(); await f.load(); f.schedule(); f.operation.mockRejectedValueOnce(Error('lost ACK')); await f.api.create(true);
 await f.load(); expect(f.api.getSnapshot()).toMatchObject({ pending: true, status: 'retry' });
 const g = fixture(); await g.load(Array.from({ length: 100 }, (_, n) => ({ ...own, id: uuid(100 + n) })));
 g.schedule(); await g.api.create(true); expect(g.api.getSnapshot().status).toBe('limit'); expect(g.operation).toHaveBeenCalledTimes(1);
});

it('resolve requires exact current explicitly opened terms, never metadata-only, closed, failed or stale reader', async () => {
 const f = fixture(); await f.load([joined], due);
 await f.api.resolve(joined.id, null, true); expect(f.operation).toHaveBeenCalledTimes(1);
 f.operation.mockRejectedValueOnce(Error('offline')); await f.api.read(joined.id);
 await f.api.resolve(joined.id, null, true); expect(f.operation).toHaveBeenCalledTimes(2);
 const held = deferred(); f.operation.mockImplementationOnce(() => held.promise); const reading = f.api.read(joined.id); await settle();
 await f.api.resolve(joined.id, null, true); expect(f.operation).toHaveBeenCalledTimes(3);
 held.resolve(detail(joined, prose, due)); await reading; f.api.close();
 await f.api.resolve(joined.id, null, true); expect(f.operation).toHaveBeenCalledTimes(3);
 await f.read(joined, due);
 const other = { ...joined, id: uuid(20) }; await f.load([joined, other], due); await f.read(other, due);
 await f.api.resolve(joined.id, null, true); expect(f.operation).toHaveBeenCalledTimes(6);
 await f.read(joined, due); await f.load([resolved, other], due);
 await f.api.resolve(joined.id, null, true); expect(f.operation).toHaveBeenCalledTimes(8);
 expect(f.api.getSnapshot().reader).toBeNull();
 f.api.leaveScreen(); await f.load([joined], due);
 await f.api.resolve(joined.id, null, true); expect(f.operation).toHaveBeenCalledTimes(9);
});
