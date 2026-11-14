import { createHardQuestionsController } from '../src/auth/hard-questions';
import { ack, context, declined, deferred, detail, envelope, error, fixture, incoming, list, openAck, opened, own, ownOpened, prose, removed, settle, uuid } from './hard-questions-fixtures';
it('never auto-fetches; sealing requires complete manual history and strict normalized bounded draft', async () => {
  const f = fixture(); expect(f.operation).not.toHaveBeenCalled(); await f.api.seal(); expect(f.operation).not.toHaveBeenCalled();
  expect(f.api.getSnapshot().requiresRefresh).toBe(true); await f.load();
  f.api.setDraft(' e\u0301\r\n next '); f.operation.mockResolvedValueOnce(ack()); await f.api.seal();
  const r = f.operation.mock.calls[1][0]; expect(r.method).toBe('POST'); expect(r.url).not.toContain('next');
  expect(await r.json()).toMatchObject({ text: 'é\n next', membership_epoch: 1, command_id: uuid(3) });
  expect(r.headers.get('idempotency-key')).toBe(uuid(3)); expect(r.headers.has('authorization')).toBe(false);
  expect(f.api.getSnapshot().draft).toBe(''); expect(f.api.getSnapshot().checked).toBe(false);
  await f.load([own]); f.api.setDraft('x'.repeat(8001)); await f.api.seal(); expect(f.api.getSnapshot().draft.length).toBe(8000); expect(f.api.getSnapshot().status).toBe('invalid');
  f.api.setDraft('x'); f.command.mockReturnValueOnce('bad'); await f.api.seal(); expect(f.api.getSnapshot().status).toBe('invalid');
});
it('unknown sealing ACK retains immutable command and newer RAM; cancel cannot cancel sent work', async () => {
  const f = fixture(); await f.load(); f.api.setDraft('🦉'.repeat(2000));
  f.operation.mockRejectedValueOnce(Error('offline')); await f.api.seal(); expect(f.api.getSnapshot().pending).toBe(true);
  f.api.cancelDraft(); f.api.setDraft('Synthetic newer unsent draft'); f.operation.mockResolvedValueOnce(ack(own, true));
  await f.api.retry(); expect(f.api.getSnapshot().draft).toBe('Synthetic newer unsent draft');
  const a = await f.operation.mock.calls[1][0].json(), b = await f.operation.mock.calls[2][0].json(); expect(a).toEqual(b); expect(a.text).toBe('🦉'.repeat(2000));
  expect(f.api.getSnapshot().pending).toBe(false); await f.api.retry(); expect(f.operation).toHaveBeenCalledTimes(3);
});
it('author cannot self-open/decline; recipient cannot remove; irreversible actions require explicit confirmation', async () => {
  const f = fixture(); await f.load([own]); f.operation.mockClear(); await f.api.open(own.id, true); await f.api.decline(own.id, true); await f.api.remove(own.id, false);
  expect(f.operation).not.toHaveBeenCalled(); await f.load([incoming]); f.operation.mockClear();
  await f.api.open(incoming.id, false); await f.api.decline(incoming.id, false); await f.api.remove(incoming.id, true); await f.api.read(incoming.id); await f.api.open(uuid(999), true);
  expect(f.operation).not.toHaveBeenCalled();
});
it('confirmed opening returns text immediately; opened text can be explicitly read again without a second transition', async () => {
  const f = fixture(); await f.load([incoming]); f.operation.mockResolvedValueOnce(openAck()); await f.api.open(incoming.id, true);
  const state = f.api.getSnapshot(); expect(state.reader?.text).toBe(prose); expect(state.questions[0]).toEqual(opened); expect(state.checked).toBe(false);
  expect(await f.operation.mock.calls[1][0].json()).toEqual({ membership_epoch: 1, command_id: uuid(3), expected_version: 1, confirm: true });
  f.api.close(); expect(f.api.getSnapshot().reader).toBeNull(); expect(f.api.getSnapshot().questions[0].decisionState).toBe('opened');
  f.operation.mockResolvedValueOnce(detail()); await f.api.read(opened.id); expect(f.api.getSnapshot().reader?.text).toBe(prose);
  const count = f.operation.mock.calls.length; await f.api.open(opened.id, true); await f.api.decline(opened.id, true); expect(f.operation).toHaveBeenCalledTimes(count);
});
it('closing in-flight opening invalidates display but confirms metadata; no other read starts while pending', async () => {
  const f = fixture(); await f.load([incoming]); const response = deferred(); f.operation.mockImplementationOnce(() => response.promise);
  const task = f.api.open(incoming.id, true); await settle(); expect(f.api.getSnapshot().readerStatus).toBe('loading');
  f.api.close(); await f.api.read(incoming.id); expect(f.api.getSnapshot().busy).toBe(true);
  response.resolve(openAck()); await task; expect(f.api.getSnapshot().pending).toBe(false); expect(f.api.getSnapshot().questions[0]).toEqual(opened);
  expect(f.api.getSnapshot().reader).toBeNull(); expect(f.api.getSnapshot().readerStatus).toBe('closed');
  f.operation.mockResolvedValueOnce(detail()); await f.api.read(incoming.id); expect(f.api.getSnapshot().reader?.text).toBe(prose);
});
it('close after unknown opening keeps original command; retry confirms state without reopening its text', async () => {
  const f = fixture(); await f.load([incoming]); f.operation.mockRejectedValueOnce(Error('offline')); await f.api.open(incoming.id, true);
  f.api.close(); f.operation.mockResolvedValueOnce(openAck(opened, true)); await f.api.retry();
  expect(f.api.getSnapshot().status).toBe('saved'); expect(f.api.getSnapshot().reader).toBeNull();
  expect(await f.operation.mock.calls[1][0].json()).toEqual(await f.operation.mock.calls[2][0].json());
});
it('refresh during unknown opening then explicit Close/retry preserves current metadata without showing text', async () => {
  const f=fixture();await f.load([incoming]);f.operation.mockRejectedValueOnce(Error('lost committed ACK'));await f.api.open(incoming.id,true);
  await f.load([opened]);f.api.close();f.operation.mockResolvedValueOnce(openAck(opened,true));await f.api.retry();
  expect(f.api.getSnapshot().pending).toBe(false);expect(f.api.getSnapshot().reader).toBeNull();expect(f.api.getSnapshot().questions[0]).toEqual(opened);
});
it('OpenACK follows latest known metadata and cannot resurrect a known tombstone on retry', async () => {
  const f = fixture(); await f.load([incoming]); f.operation.mockRejectedValueOnce(Error('lost ACK')); await f.api.open(incoming.id, true);
  await f.load([removed]); f.operation.mockResolvedValueOnce(openAck(opened, true)); await f.api.retry();
  expect(f.api.getSnapshot().status).toBe('retry'); expect(f.api.getSnapshot().questions[0]).toEqual(removed); expect(f.api.getSnapshot().reader).toBeNull();
  f.operation.mockResolvedValueOnce(openAck(removed, true)); await f.api.retry(); expect(f.api.getSnapshot().pending).toBe(false); expect(f.api.getSnapshot().reader).toBeNull();
});
it('decline never receives body and own removal preserves consent/erases the local reader', async () => {
  const f = fixture(); await f.load([incoming]); f.operation.mockResolvedValueOnce(ack(declined)); await f.api.decline(incoming.id, true);
  expect(f.api.getSnapshot().reader).toBeNull(); expect(f.api.getSnapshot().questions[0]).toEqual(declined);
  const g = fixture(); await g.load([ownOpened]); g.operation.mockResolvedValueOnce(detail(ownOpened)); await g.api.read(own.id);
  g.operation.mockResolvedValueOnce(ack({ ...ownOpened, contentState: 'removed', version: 3 })); await g.api.remove(own.id, true);
  expect(g.api.getSnapshot().reader).toBeNull(); expect(g.api.getSnapshot().questions[0].decisionState).toBe('opened');
  expect(g.operation.mock.calls[2][0].method).toBe('DELETE');
});
it('close and openB fence late GET detail even when the record/version is unchanged', async () => {
  const f = fixture(); const b = { ...opened, sequence: 2 }; await f.load([own,b]); const a = deferred(); f.operation.mockImplementationOnce(() => a.promise);
  const first = f.api.read(own.id); await settle(); f.operation.mockResolvedValueOnce(detail(b, 'Synthetic B')); await f.api.read(b.id);
  a.resolve(detail(own, 'Synthetic A')); await first; expect(f.api.getSnapshot().reader?.text).toBe('Synthetic B');
  const late = deferred(); f.operation.mockImplementationOnce(() => late.promise); const second = f.api.read(b.id); await settle(); f.api.close(); late.resolve(detail(b)); await second;
  expect(f.api.getSnapshot().reader).toBeNull(); expect(f.api.getSnapshot().readerStatus).toBe('closed');
});
it('newer canonical GET merges metadata, discards body and requires explicit reopening; removed body stays absent', async () => {
  const f = fixture(); await f.load([own]); f.operation.mockResolvedValueOnce(detail(ownOpened)); await f.api.read(own.id);
  expect(f.api.getSnapshot().reader).toBeNull(); expect(f.api.getSnapshot().readerStatus).toBe('changed');
  f.operation.mockResolvedValueOnce(detail(ownOpened)); await f.api.read(own.id); expect(f.api.getSnapshot().reader?.text).toBe(prose);
  const tombstone = { ...ownOpened, contentState: 'removed' as const, version: 3 }; f.operation.mockResolvedValueOnce(detail(tombstone)); await f.api.read(own.id);
  expect(f.api.getSnapshot().questions[0]).toEqual(tombstone); expect(f.api.getSnapshot().reader).toBeNull();
});
it('metadata/body shapes, clocks and byte bounds fail closed without certifying history or opening text', async () => {
  for (const response of [envelope({ questions: [{ ...own, text: prose }], capacity: 100, used: 1, checkedAt: '2026-11-11T00:00:00.000Z' }),
    list([own,own]), list([{ ...own, sequence: 2 }]), list([own], '2020-01-01T00:00:00.000Z'),
    envelope({ questions: [], capacity: 99, used: 0, checkedAt: '2026-11-11T00:00:00.000Z' })]) {
    const f = fixture(); f.operation.mockResolvedValueOnce(response); await f.api.load(); expect(f.api.getSnapshot().error).toBe(true); expect(f.api.getSnapshot().checked).toBe(false);
  }
  for (const response of [openAck(opened, false, ' bad '), openAck(opened, false, ''), openAck(opened, false, 'x'.repeat(32769)),
    envelope({ question: opened, commandId: uuid(3), replay: false, checkedAt: 'bad', text: prose }),
    envelope({ question: declined, commandId: uuid(3), replay: false, checkedAt: '2026-11-11T00:00:00.000Z' }),
    envelope({ question: opened, commandId: uuid(3), replay: false, checkedAt: '2026-11-11T00:00:00.000Z', text: prose, extra: 1 })]) {
    const f = fixture(); await f.load([incoming]); f.operation.mockResolvedValueOnce(response); await f.api.open(incoming.id, true);
    expect(f.api.getSnapshot().status).toBe('retry'); expect(f.api.getSnapshot().reader).toBeNull();
  }
  const f = fixture(); await f.load([own]); f.operation.mockResolvedValueOnce(envelope({ question: own, checkedAt: '2026-11-11T00:00:00.000Z', text: prose, extra: 1 })); await f.api.read(own.id);
  expect(f.api.getSnapshot().readerStatus).toBe('error'); expect(f.api.getSnapshot().reader).toBeNull();
});
it('single ACK may leave gaps but only a complete nonregressing GET certifies all100 history entries', async () => {
  const f = fixture(); await f.load([own]); f.api.setDraft('Synthetic third'); const third = { ...own, id: uuid(10), sequence: 3 };
  f.operation.mockResolvedValueOnce(ack(third)); await f.api.seal(); expect(f.api.getSnapshot().used).toBe(3); expect(f.api.getSnapshot().checked).toBe(false);
  f.operation.mockResolvedValueOnce(list([third,own])); await f.api.load(); expect(f.api.getSnapshot().error).toBe(true);
  const second = { ...own, id: uuid(11), sequence: 2 }; await f.load([third,second,own]); expect(f.api.getSnapshot().checked).toBe(true);
  f.operation.mockResolvedValueOnce(list([third,own])); await f.api.load(); expect(f.api.getSnapshot().questions).toHaveLength(3);
  const cap = fixture(); const hundred = Array.from({ length: 100 }, (_, n) => ({ ...own, id: uuid(300+n), sequence: n+1 })).reverse(); await cap.load(hundred);
  cap.operation.mockClear(); await cap.api.seal(); expect(cap.api.getSnapshot().status).toBe('limit'); expect(cap.operation).not.toHaveBeenCalled();
  cap.operation.mockResolvedValueOnce(detail(hundred[0])); await cap.api.read(hundred[0].id); expect(cap.api.getSnapshot().reader?.text).toBe(prose);
});
it('scope/auth/cookie changes clear all private state and obsolete replies cannot return it', async () => {
  const f = fixture(); await f.load([opened]); const late = deferred(); f.operation.mockImplementationOnce(() => late.promise); const task = f.api.read(opened.id); await settle();
  f.set({ generation: 2, identity: { userId: 'other-provider', sessionId: 'other' }, context: { ...context, membershipEpoch: 2 } }); f.controller.sync(); late.resolve(detail()); await task;
  expect(f.api.getSnapshot().reader).toBeNull(); expect(f.api.getSnapshot().draft).toBe(''); expect(f.api.getSnapshot().questions).toEqual([]);
  f.set(null); f.controller.sync(); expect(f.api.getSnapshot().available).toBe(false); await f.api.load();
  const g = fixture(); await g.load([opened]); g.host.getCookie.mockResolvedValueOnce('synthetic=cookie').mockResolvedValueOnce('changed'); await g.api.read(opened.id);
  expect(g.host.block).toHaveBeenCalledWith('auth_required'); expect(g.api.getSnapshot().available).toBe(false);
  for (const code of [401,403]) { const h = fixture(); h.operation.mockResolvedValueOnce(error('unavailable',code)); await h.api.load(); expect(h.api.getSnapshot().available).toBe(false); }
  const h = fixture(); h.operation.mockResolvedValueOnce(error('stale_membership',409)); await h.api.load(); expect(h.api.getSnapshot().available).toBe(false);
});
it('transport/context/error/conflict branches retain honest unknown outcomes and require explicit refresh', async () => {
  const f = fixture(); f.discovery.mockRejectedValueOnce(Error('offline')); await f.api.load(); expect(f.api.getSnapshot().error).toBe(true);
  f.discovery.mockResolvedValueOnce(error('unauthenticated',401)); await f.api.load(); expect(f.api.getSnapshot().available).toBe(false);
  const changed = fixture(); changed.discovery.mockResolvedValueOnce(envelope({ ...context, membershipEpoch: 2 })); await changed.api.load(); expect(changed.host.refresh).toHaveBeenCalled();
  for (const code of ['version_conflict','idempotency_conflict','capacity_reached']) {
    const g = fixture(); await g.load(); g.operation.mockResolvedValueOnce(error(code,409)); await g.api.seal(); expect(g.api.getSnapshot().requiresRefresh).toBe(true); expect(g.api.getSnapshot().pending).toBe(false);
    const n = g.operation.mock.calls.length; await g.api.seal(); expect(g.operation).toHaveBeenCalledTimes(n);
  }
  for (const status of [400,404,503]) { const g = fixture(); await g.load(); g.operation.mockResolvedValueOnce(error(status===400?'invalid_request':'unavailable',status)); await g.api.seal(); expect(g.api.getSnapshot().status).toBe(status===400?'invalid':'retry'); }
  const missing = fixture(); missing.operation.mockResolvedValueOnce(error('not_found',404)); await missing.api.load(); expect(missing.api.getSnapshot().status).toBe('unavailable');
  expect(() => createHardQuestionsController({ mode: 'synthetic-loopback', baseURL: 'https://remote.invalid' }, fixture().host, async()=>list(),()=>uuid(3))).toThrow();
});
