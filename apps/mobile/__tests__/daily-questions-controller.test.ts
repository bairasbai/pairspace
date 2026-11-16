import { createDailyQuestionsController } from '../src/auth/daily-questions';
import { ack, context, deferred, detail, edited, entry, envelope, error, fixture, history, later, own, page, partner,
 prose, removed, settle, slot, start, today, tomorrow, uuid } from './daily-questions-fixtures';
it('idle/skip/draft never fetch or unlock; confirmed creation sends immutable canonical text and expected server day', async () => {
 const f = fixture(); expect(f.operation).not.toHaveBeenCalled(); await f.api.create(true); await f.api.create(false); await f.api.loadMore();
 expect(f.operation).not.toHaveBeenCalled(); await f.refresh([entry([partner])]);
 await f.api.read(partner.id); f.api.cancelDraft(); await f.api.read(partner.id); expect(f.operation).toHaveBeenCalledTimes(1);
 f.api.setDraft(' e\u0301\r\n next '); await f.api.create(false); expect(f.operation).toHaveBeenCalledTimes(1);
 const revision = f.api.getSnapshot().revision;
 f.operation.mockResolvedValueOnce(ack()); const task = f.api.create(true); expect(f.api.getSnapshot().draft).toBe(''); await task;
 const request = f.operation.mock.calls[1][0]; expect(request.method).toBe('POST'); expect(await request.json()).toEqual({ membership_epoch: 1, command_id: uuid(3), confirm: true, expected_day: slot.day, text: 'é\n next' });
 expect(request.headers.get('idempotency-key')).toBe(uuid(3)); expect(request.headers.get('cookie')).toBe('synthetic=cookie');
 expect(request.credentials).toBe('omit'); expect(request.redirect).toBe('error'); expect(request.cache).toBe('no-store'); expect(request.headers.has('authorization')).toBe(false);
 expect(f.api.getSnapshot().revision).toBeGreaterThan(revision); expect(f.api.getSnapshot().reader).toBeNull(); expect(f.operation).toHaveBeenCalledTimes(2);
 f.operation.mockResolvedValueOnce(detail(partner)); await f.api.read(partner.id); expect(f.api.getSnapshot().reader?.text).toBe(prose);
 expect(Object.isFrozen(f.api.getSnapshot().slots[0].slot.participantIds)).toBe(true);
});
it('lost ACK does not unlock today; immutable retry after midnight stays on original slot and preserves distinct new draft', async () => {
 const f = fixture(); await f.refresh([entry([partner])]); f.operation.mockRejectedValueOnce(Error('lost ACK')); await f.api.create(true);
 expect(f.api.getSnapshot()).toMatchObject({ pending: true, status: 'retry', draft: '' });
 await f.api.read(partner.id); expect(f.operation).toHaveBeenCalledTimes(2);
 f.api.setDraft('Distinct newer unsent answer'); f.operation.mockResolvedValueOnce(ack(edited, true, uuid(3), tomorrow)); await f.api.retry();
 expect(await f.operation.mock.calls[1][0].clone().json()).toEqual(await f.operation.mock.calls[2][0].json());
 expect(f.api.getSnapshot().slots[0].slot.day).toBe(slot.day); expect(f.api.getSnapshot().draft).toBe('Distinct newer unsent answer');
 expect(f.api.getSnapshot().pending).toBe(false); expect(f.api.getSnapshot().reader).toBeNull(); await f.api.retry(); expect(f.operation).toHaveBeenCalledTimes(3);
});
it('rewrite requires explicit same-version own read, sends PUT CAS, never seeds draft from returned body', async () => {
 const f = fixture(); await f.refresh([entry()]); f.api.setDraft('New replacement'); await f.api.rewrite(own.id, true); expect(f.operation).toHaveBeenCalledTimes(1);
 f.operation.mockResolvedValueOnce(detail()); await f.api.read(own.id); expect(f.api.getSnapshot().draft).toBe('New replacement');
 await f.api.rewrite(own.id, false); expect(f.operation).toHaveBeenCalledTimes(2);
 f.operation.mockResolvedValueOnce(ack(edited, false, uuid(3), later)); await f.api.rewrite(own.id, true);
 expect(f.operation.mock.calls[2][0].method).toBe('PUT'); expect(await f.operation.mock.calls[2][0].json()).toEqual({ membership_epoch: 1, command_id: uuid(3), expected_version: 1, confirm: true, text: 'New replacement' });
 expect(f.api.getSnapshot().reader).toBeNull(); expect(f.api.getSnapshot().draft).toBe('');
 f.operation.mockResolvedValueOnce(detail(partner, prose, later)); await f.api.read(partner.id); f.api.setDraft('Cannot rewrite partner');
 await f.api.rewrite(partner.id, true); expect(f.api.getSnapshot().status).toBe('conflict'); expect(f.operation).toHaveBeenCalledTimes(4);
});
it('confirmed removal immediately closes partner reader, uncertain outcome never restores it or sends new command', async () => {
 const f = fixture(); await f.refresh([entry()]); f.operation.mockResolvedValueOnce(detail(partner)); await f.api.read(partner.id);
 const held = deferred(); f.operation.mockImplementationOnce(() => held.promise); const task = f.api.remove(own.id, true);
 expect(f.api.getSnapshot().reader).toBeNull(); await settle(); held.reject(Error('unknown deletion')); await task;
 expect(f.api.getSnapshot()).toMatchObject({ pending: true, reader: null, status: 'retry' });
 f.operation.mockResolvedValueOnce(ack(removed, true, uuid(3), later)); await f.api.retry();
 expect(f.operation.mock.calls[2][0].method).toBe('DELETE'); expect(await f.operation.mock.calls[2][0].json()).toEqual(await f.operation.mock.calls[3][0].json());
 const calls = f.operation.mock.calls.length; await f.api.read(partner.id); await f.api.remove(own.id, true); await f.api.create(true); expect(f.operation).toHaveBeenCalledTimes(calls);
 await f.refresh([entry([removed, partner])], tomorrow); f.operation.mockResolvedValueOnce(detail(partner, prose, tomorrow)); await f.api.read(partner.id);
 expect(f.api.getSnapshot().reader?.text).toBe(prose);
});
it('full newest-page metadata includes tombstones and prevents recreation; unconfirmed invalid drafts never submit', async () => {
 const f = fixture(); await f.refresh([entry([removed, partner])], later); await f.api.create(true); expect(f.operation).toHaveBeenCalledTimes(1);
 const g = fixture(); await g.refresh();
 for (const invalid of ['', 'a\rb', '🦉'.repeat(2001)]) { g.api.setDraft(invalid); await g.api.create(true); expect(g.api.getSnapshot().status).toBe('invalid'); }
 g.api.setDraft('x'.repeat(8001)); expect(g.api.getSnapshot().draft.length).toBe(8000); g.api.setDraft('Synthetic'); g.command.mockReturnValueOnce('bad'); await g.api.create(true); expect(g.operation).toHaveBeenCalledTimes(1);
 await g.api.remove(uuid(999), true); await g.api.rewrite(uuid(999), true); await g.api.read(uuid(999)); expect(g.operation).toHaveBeenCalledTimes(1);
});
it('history keyset preserves loaded tombstones and older-page completeness cannot authorize today create', async () => {
 const f = fixture(), all = history(101); await f.refresh(all.slice(0, 100), start, true);
 f.operation.mockResolvedValueOnce(page(all.slice(100))); await f.api.loadMore();
 expect(f.operation.mock.calls[1][0].url).toContain('before_day=' + all[99].slot.day); expect(f.api.getSnapshot().slots).toHaveLength(101);
 expect(f.api.getSnapshot().checked).toBe(false); await f.api.create(true); expect(f.api.getSnapshot().requiresRefresh).toBe(true);
 await f.api.loadMore(); expect(f.operation).toHaveBeenCalledTimes(2);
 const changed = { ...all[0], answers: [{ ...all[0].answers[0], contentState: 'removed' as const, removedAt: start, version: 2 }] };
 await f.refresh([changed, ...all.slice(1, 100)], start, true); expect(f.api.getSnapshot().slots).toHaveLength(101);
 expect(f.api.getSnapshot().slots[0].answers[0].contentState).toBe('removed');
});
it.each(['success', 'failure'] as const)('background/unmount clears unknown payload and fences late %s', async result => {
 const f = fixture(); await f.refresh(); const held = deferred(); f.operation.mockImplementationOnce(() => held.promise);
 const task = f.api.create(true); await settle(); const sent = f.operation.mock.calls[1][0]; f.api.leaveScreen(); expect(sent.signal.aborted).toBe(true);
 expect(f.api.getSnapshot()).toMatchObject({ pending: false, draft: '', reader: null, slots: [], requiresRefresh: true });
 if (result === 'success') held.resolve(ack()); else held.reject(Error('late failure'));
 await task; await f.api.retry(); expect(f.operation).toHaveBeenCalledTimes(2); expect(f.api.getSnapshot().slots).toEqual([]);
 await f.refresh([entry([own])]); expect(f.api.getSnapshot().pending).toBe(false); expect(f.api.getSnapshot().draft).toBe('');
});
it('close fences late body and permits another explicit read; logout/rotated scope clears all data', async () => {
 const f = fixture(); await f.refresh([entry()]); const held = deferred(); f.operation.mockImplementationOnce(() => held.promise);
 const task = f.api.read(partner.id); await settle(); expect(f.api.getSnapshot().readerStatus).toBe('loading'); f.api.close(); held.resolve(detail(partner)); await task;
 expect(f.api.getSnapshot().reader).toBeNull(); expect(f.api.getSnapshot().readerStatus).toBe('closed');
 f.operation.mockResolvedValueOnce(detail()); await f.api.read(own.id); expect(f.api.getSnapshot().reader?.text).toBe(prose);
 f.set(null); f.controller.sync(); expect(f.api.getSnapshot()).toMatchObject({ available: false, reader: null, draft: '', slots: [] });
 f.api.setDraft('Ignored'); await f.api.refresh(); await f.api.read(own.id); expect(f.api.getSnapshot().draft).toBe('');
});
it('scope rotation during response drops old metadata and body, and unchanged sync does not reset', async () => {
 const f = fixture(); await f.refresh([entry()]); const generation = f.api.getSnapshot().generation; f.controller.sync(); expect(f.api.getSnapshot().generation).toBe(generation);
 const held = deferred(); f.operation.mockImplementationOnce(() => held.promise); const task = f.api.read(own.id); await settle();
 f.set({ generation: 2, identity: { sessionId: 'new', userId: 'new' }, context: { ...context, sessionId: 'new', coupleId: uuid(77) } });
 held.resolve(detail()); await task; expect(f.api.getSnapshot().slots).toEqual([]); expect(f.api.getSnapshot().reader).toBeNull(); expect(f.api.getSnapshot().generation).toBeGreaterThan(generation);
});
it('cookie changes before operation or after response scrub scope and reject stale provider content', async () => {
 const f = fixture(); f.host.getCookie.mockResolvedValueOnce('first').mockResolvedValueOnce('second'); await f.api.refresh(); expect(f.host.block).toHaveBeenCalledWith('auth_required'); expect(f.operation).not.toHaveBeenCalled();
 const g = fixture(); await g.refresh([entry()]); g.operation.mockImplementationOnce(async () => { g.host.getCookie.mockResolvedValue('changed'); return detail(); }); await g.api.read(own.id);
 expect(g.host.block).toHaveBeenCalledWith('auth_required'); expect(g.api.getSnapshot().reader).toBeNull();
});
it('context mismatch refreshes host; discovery transport retry differs from unauthenticated scrub', async () => {
 const f = fixture(); f.discovery.mockResolvedValueOnce(envelope({ ...context, membershipEpoch: 2 })); await f.api.refresh(); expect(f.host.refresh).toHaveBeenCalled(); expect(f.operation).not.toHaveBeenCalled();
 const g = fixture(); g.discovery.mockRejectedValueOnce(Error('offline')); await g.api.refresh(); expect(g.api.getSnapshot().error).toBe(true); expect(g.host.block).not.toHaveBeenCalled();
 const h = fixture(); h.discovery.mockResolvedValueOnce(error('unauthenticated', 401)); await h.api.refresh(); expect(h.host.block).toHaveBeenCalledWith('auth_required');
});
it.each(['version_conflict', 'idempotency_conflict', 'day_changed'])('known %s rejection drops command and requires newest metadata', async code => {
 const f = fixture(); await f.refresh(); f.operation.mockResolvedValueOnce(error(code, 409)); await f.api.create(true);
 expect(f.api.getSnapshot()).toMatchObject({ pending: false, requiresRefresh: true, status: 'conflict', draft: '' }); await f.api.retry(); expect(f.operation).toHaveBeenCalledTimes(2);
});
it('invalid request requires refresh, stale membership/auth scrub, unavailable reads do not claim logout', async () => {
 const f = fixture(); await f.refresh(); f.operation.mockResolvedValueOnce(error('invalid_request', 400)); await f.api.create(true); expect(f.api.getSnapshot()).toMatchObject({ status: 'invalid', requiresRefresh: true, pending: false });
 const g = fixture(); g.operation.mockResolvedValueOnce(error('stale_membership', 409)); await g.api.refresh(); expect(g.host.block).toHaveBeenCalledWith('access_required');
 const h = fixture(); h.operation.mockResolvedValueOnce(error('unauthenticated', 401)); await h.api.refresh(); expect(h.host.block).toHaveBeenCalledWith('auth_required');
 for (const status of [403, 404]) { const k = fixture(); await k.refresh([entry()]); k.operation.mockResolvedValueOnce(error('unavailable', status)); await k.api.read(own.id); expect(k.api.getSnapshot()).toMatchObject({ reader: null, readerStatus: 'error', requiresRefresh: true }); expect(k.host.block).not.toHaveBeenCalled(); }
});
it('unknown 403 mutation outcome retains identical retry; no private data accepted without cache headers/exact envelope', async () => {
 const f = fixture(); await f.refresh(); f.operation.mockResolvedValueOnce(error('unavailable', 403)); await f.api.create(true); expect(f.api.getSnapshot()).toMatchObject({ pending: true, status: 'retry' });
 for (const response of [new Response('{}'), new Response('bad', { headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } }), envelope(null), envelope({}, 503)]) {
  const g = fixture(); g.operation.mockResolvedValueOnce(response); await g.api.refresh(); expect(g.api.getSnapshot().error).toBe(true);
 }
});
it('corrupt ACK, forged create history or text-bearing metadata cannot unlock or replace immutable retry', async () => {
 for (const value of [{ slot, answer: own, commandId: uuid(3), replay: false, checkedAt: start, text: prose },
  { slot, answer: own, commandId: uuid(4), replay: false, checkedAt: start }, { slot, answer: edited, commandId: uuid(3), replay: false, checkedAt: later },
  { slot, answer: partner, commandId: uuid(3), replay: true, checkedAt: start }, { slot: { ...slot, promptEN: 'forged' }, answer: own, commandId: uuid(3), replay: true, checkedAt: start }]) {
  const f = fixture(); await f.refresh(); f.operation.mockResolvedValueOnce(envelope(value)); await f.api.create(true); expect(f.api.getSnapshot()).toMatchObject({ pending: true, slots: [], reader: null, status: 'retry' });
 }
});
it('corrupt read, missing target or same-ID revision jump keeps text closed and updates only sound metadata', async () => {
 for (const value of [{ slot, answer: own, checkedAt: start, text: ' invalid ' }, { slot, answer: own, checkedAt: start, text: prose, body: prose },
  { slot, answer: { ...own, id: uuid(99) }, checkedAt: start, text: prose }, { slot, answer: own, checkedAt: '2026-11-10T11:59:59.999Z', text: prose }]) {
  const f = fixture(); await f.refresh([entry()]); f.operation.mockResolvedValueOnce(envelope(value)); await f.api.read(own.id); expect(f.api.getSnapshot().readerStatus).toBe('error'); expect(f.api.getSnapshot().reader).toBeNull();
 }
 const f = fixture(); await f.refresh([entry()]); f.operation.mockResolvedValueOnce(detail(edited, prose, later)); await f.api.read(own.id); expect(f.api.getSnapshot().readerStatus).toBe('changed'); expect(f.api.getSnapshot().slots[0].answers.find(a => a.id === own.id)?.version).toBe(2);
 const g = fixture(); await g.refresh([entry()]); g.operation.mockResolvedValueOnce(envelope({ slot, answer: own, checkedAt: start })); await g.api.read(own.id); expect(g.api.getSnapshot().readerStatus).toBe('changed');
});
it('page rollback, missing known tombstone or injected private metadata fail closed without losing prior history', async () => {
 for (const response of [page([], later), page([entry([own, partner])], later), envelope({ slots: [entry([removed, partner])], today: today(later), checkedAt: later, hasMore: false, nextBeforeDay: null, text: prose })]) {
  const f = fixture(); await f.refresh([entry([removed, partner])], later); f.operation.mockResolvedValueOnce(response); await f.api.refresh(); expect(f.api.getSnapshot().error).toBe(true); expect(f.api.getSnapshot().slots[0].answers[0].contentState).toBe('removed');
 }
});
it('subscription/unsubscribe and invalid configuration behave without side effects', () => {
 const f = fixture(), listener = jest.fn(), off = f.api.subscribe(listener); f.api.setDraft('New'); expect(listener).toHaveBeenCalled(); off(); listener.mockClear(); f.api.cancelDraft(); expect(listener).not.toHaveBeenCalled();
 expect(() => createDailyQuestionsController({ mode: 'synthetic-loopback', baseURL: 'https://example.com' }, f.host, async () => page(), () => uuid(3))).toThrow();
});
it('published reader metadata is deeply frozen so callers cannot forge a different matching-version read', async () => {
 const f = fixture(); await f.refresh([entry()]); f.operation.mockResolvedValueOnce(detail()); await f.api.read(own.id);
 const reader = f.api.getSnapshot().reader!;
 expect(Object.isFrozen(reader)).toBe(true); expect(Object.isFrozen(reader.answer)).toBe(true);
 expect(Object.isFrozen(reader.slot)).toBe(true); expect(Object.isFrozen(reader.slot.participantIds)).toBe(true);
 expect(Reflect.set(reader.answer, 'id', partner.id)).toBe(false);
 expect(Reflect.set(reader.slot.participantIds, '0', partner.authorId)).toBe(false);
 expect(f.api.getSnapshot().reader?.answer.id).toBe(own.id);
});
it('first-create ACK cannot silently replace the confirmed descriptor timezone even if the slot itself validates', async () => {
 const f = fixture(); await f.refresh();
 f.operation.mockResolvedValueOnce(ack(own, false, uuid(3), start, { ...slot, timezone: 'Europe/Moscow' }));
 await f.api.create(true); expect(f.api.getSnapshot()).toMatchObject({ pending: true, status: 'retry', slots: [], reader: null });
});

it('empty older page with another timezone fails closed without replacing retained descriptor or tombstones', async () => {
 const f = fixture(), entries = history(); await f.refresh(entries, start, true);
 const before = f.api.getSnapshot();
 f.operation.mockResolvedValueOnce(envelope({ slots: [], today: { ...today(start), timezone: 'Europe/Moscow' },
  checkedAt: start, hasMore: false, nextBeforeDay: null }));
 await f.api.loadMore();
 expect(f.api.getSnapshot()).toMatchObject({ error: true, reader: null });
 expect(f.api.getSnapshot().today).toEqual(before.today);
 expect(f.api.getSnapshot().slots).toEqual(before.slots);
 expect(f.api.getSnapshot().nextBeforeDay).toBe(before.nextBeforeDay);
});
