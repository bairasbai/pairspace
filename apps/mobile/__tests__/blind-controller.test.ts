import { fixture, ack, round, envelope, error, uuid, context, settle } from './blind-fixtures';
it('opens only explicitly, confirms only after consent; immutable submission and reveal', async () => {
  const f = fixture(), notify = jest.fn(), unsubscribe = f.api.subscribe(notify);
  f.controller.sync(); expect(f.operation).not.toHaveBeenCalled(); await f.api.submit();
  await f.api.open(); expect(f.api.getSnapshot().round).toEqual(round);
  await f.api.submit(); expect(f.operation).toHaveBeenCalledTimes(1);
  f.api.setConsent(true); f.operation.mockResolvedValueOnce(ack({ ...round, ownAnswer: 'Small joy' }));
  await f.api.submit(); expect(f.api.getSnapshot()).toMatchObject({ draft: '', consent: false, pending: null });
  f.api.setDraft('changed'); f.api.setConsent(true); await f.api.submit();
  expect(f.operation).toHaveBeenCalledTimes(2);
  f.operation.mockResolvedValueOnce(envelope({ round: { ...round, ownAnswer: 'Small joy', partnerAnswer: 'A walk', revealed: true } }));
  await f.api.read(); expect(f.api.getSnapshot().round?.partnerAnswer).toBe('A walk');
  unsubscribe(); f.controller.reset(); expect(notify).toHaveBeenCalled();
});
it('keeps exact unknown-ACK command, never changes submitted draft on retry', async () => {
  const f = fixture(); await f.api.open(); f.api.setConsent(true);
  f.operation.mockResolvedValueOnce(error('temporary', 503)); await f.api.submit();
  f.api.setDraft('Different'); f.api.setConsent(true); await f.api.open(); await f.api.submit();
  expect(f.api.getSnapshot()).toMatchObject({ draft: 'Small joy', pending: 'answer', status: 'retry' });
  f.operation.mockResolvedValueOnce(ack({ ...round, ownAnswer: 'Small joy' }, true)); await f.api.retry();
  expect(await f.operation.mock.calls[1][0].json()).toEqual(await f.operation.mock.calls[2][0].json());
  expect(f.operation.mock.calls[2][0].url).toContain('/blind-round/' + round.id + '/answer');
});
it('blocks duplicate in-flight and scrubs lifecycle', async () => {
  const f = fixture(); let release!: (r: Response) => void;
  f.operation.mockReturnValueOnce(new Promise(r => { release = r; }));
  const work = f.api.open(); await settle(); await f.api.open(); await f.api.read(); await f.api.retry();
  f.controller.reset(); release(ack()); await work; f.api.setDraft('ignored'); await f.api.open();
  expect(f.api.getSnapshot()).toMatchObject({ available: false, round: null, draft: '' });
  f.set(null); f.controller.sync(); expect(f.operation).toHaveBeenCalledTimes(1);
});
it.each(['already_submitted', 'idempotency_conflict'])('conflict %s requires explicit refresh', async code => {
  const f = fixture(); f.operation.mockResolvedValueOnce(error(code, 409)); await f.api.open();
  expect(f.api.getSnapshot().requiresRefresh).toBe(true); await f.api.open(); await f.api.retry();
  f.operation.mockResolvedValueOnce(envelope({ round })); await f.api.read(); expect(f.api.getSnapshot().requiresRefresh).toBe(false);
});
it.each([401,403,409])('access denial %s scrubs', async status => {
  const f = fixture(); f.operation.mockResolvedValueOnce(error('stale_membership', status)); await f.api.open();
  expect(f.host.block).toHaveBeenCalledWith('access_required'); expect(f.api.getSnapshot().draft).toBe('');
});
it.each([401,403,500])('preflight %s prevents mutation', async status => {
  const f = fixture(); f.discovery.mockResolvedValueOnce(error('unavailable',status)); await f.api.open(); expect(f.operation).not.toHaveBeenCalled();
});
it('rejects bad ids, answer, clears consent on edit, bounds draft, handles error statuses', async () => {
  const f = fixture(); f.command.mockReturnValueOnce('bad'); await f.api.open(); expect(f.api.getSnapshot().status).toBe('invalid');
  await f.api.open(); f.api.setDraft(' '); f.api.setConsent(true); await f.api.submit(); expect(f.api.getSnapshot().status).toBe('invalid');
  f.api.setDraft('x'.repeat(5000)); expect(f.api.getSnapshot().draft).toHaveLength(4000); expect(f.api.getSnapshot().consent).toBe(false);
  f.operation.mockResolvedValueOnce(error('invalid_request',400)); await f.api.open(); expect(f.api.getSnapshot().pending).toBeNull();
  f.operation.mockResolvedValueOnce(error('not_found',404)); await f.api.read(); expect(f.api.getSnapshot().error).toBe(true);
  f.operation.mockResolvedValueOnce(error('not_found',404)); await f.api.open(); expect(f.api.getSnapshot().status).toBe('retry');
});
it('changed pair or cookie scrubs before mutation', async () => {
  const f = fixture(); f.discovery.mockResolvedValueOnce(envelope({ ...context, coupleId: uuid(99) })); await f.api.open();
  expect(f.host.refresh).toHaveBeenCalled(); expect(f.operation).not.toHaveBeenCalled();
  const g = fixture(); g.host.getCookie.mockResolvedValueOnce('a').mockResolvedValue('b'); await g.api.open(); expect(g.host.block).toHaveBeenCalled();
});
it.each(['cookie','discovery','operation','body'])('late %s cannot resurrect body', async point => {
  const f = fixture(); let resolve!: (r: never) => void;
  const delayed = new Promise<never>(r => { resolve = r; });
  if (point === 'cookie') f.host.getCookie.mockReturnValueOnce(delayed);
  if (point === 'discovery') f.discovery.mockReturnValueOnce(delayed);
  if (point === 'operation') f.operation.mockReturnValueOnce(delayed);
  if (point === 'body') f.operation.mockResolvedValueOnce({ status: 200, headers: new Headers(), text: () => delayed } as unknown as Response);
  const work = f.api.open(); await settle(); f.controller.reset();
  resolve((point === 'cookie' ? 'cookie' : point === 'body' ? JSON.stringify({ ok:true,value:{round} }) : ack()) as never);
  await work; expect(f.api.getSnapshot().round).toBeNull();
});
it.each([null, {}, { ...round, partnerAnswer: 'secret' }, { ...round, revealed: true }, { ...round, ownAnswer: ' bad ' }, { ...round, questionId: 'bad' }])('rejects invalid mutation round %p', async value => {
  const f = fixture(); f.operation.mockResolvedValueOnce(ack(value)); await f.api.open(); expect(f.api.getSnapshot().status).toBe('retry');
});
it('rejects malformed response and read retraction, allows empty read', async () => {
  const f = fixture(); f.operation.mockResolvedValueOnce(envelope({ round: null })); await f.api.read(); expect(f.api.getSnapshot().checked).toBe(true);
  f.operation.mockResolvedValueOnce(new Response('{}')); await f.api.read(); expect(f.api.getSnapshot().error).toBe(true);
  await f.api.open(); f.operation.mockResolvedValueOnce(envelope({ round: null })); await f.api.read(); expect(f.api.getSnapshot().round).toEqual(round);
  f.operation.mockResolvedValueOnce(ack(round, false, uuid(99))); await f.api.open(); expect(f.api.getSnapshot().status).toBe('retry');
});
