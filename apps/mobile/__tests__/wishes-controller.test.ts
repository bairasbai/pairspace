import { fixture, ack, envelope, error, wish, uuid, context, settle } from './wishes-fixtures';
it('does not implicitly write; sync is stable, unavailable actions inert, listener cleanup works', async () => {
  const f = fixture(), listener = jest.fn(), stop = f.api.subscribe(listener);
  f.controller.sync(); expect(listener).not.toHaveBeenCalled(); expect(f.operation).not.toHaveBeenCalled();
  f.controller.reset(); stop(); f.controller.reset(); f.api.setDraft('x'); await (f.api.setConsent(true), f.api.create()); await f.api.retry(); await f.api.list();
  expect(listener).toHaveBeenCalledTimes(1); expect(f.operation).not.toHaveBeenCalled();
  f.set(null); f.controller.sync(); expect(f.api.getSnapshot().available).toBe(false);
});
it('keeps immutable create command through unknown ACK and edited draft, blocks duplicate/different actions', async () => {
  const f = fixture(); let release!: (r: Response) => void;
  f.operation.mockReturnValueOnce(new Promise(r => { release = r; }));
  const work = (f.api.setConsent(true), f.api.create()); await settle();
  await (f.api.setConsent(true), f.api.create()); await f.api.retry(); await f.api.list(); await f.api.fulfill(wish.id);
  f.api.setDraft('New draft'); release(error('temporary', 503)); await work;
  expect(f.api.getSnapshot()).toMatchObject({ status: 'retry', pending: { title: wish.title, operation: 'create' } });
  await (f.api.setConsent(true), f.api.create()); expect(f.operation).toHaveBeenCalledTimes(1);
  await f.api.retry(); expect(f.command).toHaveBeenCalledTimes(1);
  expect(await f.operation.mock.calls[1][0].json()).toEqual({ command_id: uuid(3), membership_epoch: 1, title: wish.title, explanation: '' });
  expect(f.api.getSnapshot()).toMatchObject({ status: 'saved', draft: 'New draft', wishes: [wish], pending: null });
  expect(f.operation.mock.calls[0][0].headers.get('Idempotency-Key')).toBe(uuid(3));
});
it('normalizes title, clears only unchanged draft and allows another new command', async () => {
  const f = fixture(); f.api.setDraft('  Shared\n wish  '); await (f.api.setConsent(true), f.api.create());
  expect(f.api.getSnapshot().draft).toBe(''); expect(f.api.getSnapshot().status).toBe('saved');
  f.api.setDraft(wish.title); f.command.mockReturnValue(uuid(4)); f.operation.mockResolvedValue(ack(wish, 1, false, uuid(4)));
  await (f.api.setConsent(true), f.api.create()); expect(f.command).toHaveBeenCalledTimes(2);
});
it('fulfill unknown ACK followed by partner reopen returns current v3, never stale fulfilled v2', async () => {
  const f = fixture(); f.operation.mockResolvedValueOnce(envelope({ wishes: [wish], limit: 50 })); await f.api.list();
  f.operation.mockResolvedValueOnce(error('temporary', 503)); await f.api.fulfill(wish.id);
  expect(f.api.getSnapshot().status).toBe('retry');
  f.operation.mockResolvedValueOnce(ack({ ...wish, state: 'open', version: 3 }, 2, true)); await f.api.retry();
  expect(f.api.getSnapshot()).toMatchObject({ status: 'saved', pending: null, wishes: [{ ...wish, state: 'open', version: 3 }] });
  expect(await f.operation.mock.calls[1][0].json()).toEqual({ command_id: uuid(3), membership_epoch: 1, operation: 'fulfill', expected_version: 1 });
  expect(await f.operation.mock.calls[2][0].json()).toEqual({ command_id: uuid(3), membership_epoch: 1, operation: 'fulfill', expected_version: 1 });
});
it('both members can fulfill and reopen only a displayed wish in the matching state', async () => {
  const f = fixture(); const partnerTask = { ...wish, creatorId: uuid(4) };
  f.operation.mockResolvedValueOnce(envelope({ wishes: [partnerTask], limit: 50 })); await f.api.list();
  await f.api.reopen(wish.id); await f.api.fulfill(uuid(100)); expect(f.command).not.toHaveBeenCalled();
  f.operation.mockResolvedValueOnce(ack({ ...partnerTask, state: 'fulfilled', version: 2 }, 2)); await f.api.fulfill(wish.id);
  expect(f.api.getSnapshot().wishes[0].state).toBe('fulfilled');
  f.operation.mockResolvedValueOnce(ack({ ...partnerTask, state: 'open', version: 3 }, 3)); await f.api.reopen(wish.id);
  expect(f.api.getSnapshot().wishes[0].state).toBe('open');
  expect(await f.operation.mock.calls[2][0].json()).toMatchObject({ operation: 'reopen', expected_version: 2 });
});
it.each(['version_conflict', 'idempotency_conflict'])('requires explicit refresh on %s before making a new command', async code => {
  const f = fixture(); f.operation.mockResolvedValueOnce(error(code, 409)); await (f.api.setConsent(true), f.api.create());
  expect(f.api.getSnapshot()).toMatchObject({ status: 'conflict', pending: null, requiresRefresh: true });
  await (f.api.setConsent(true), f.api.create()); await f.api.retry(); expect(f.operation).toHaveBeenCalledTimes(1);
  f.operation.mockResolvedValueOnce(envelope({ wishes: [], limit: 50 })); await f.api.list();
  expect(f.api.getSnapshot()).toMatchObject({ status: 'idle', requiresRefresh: false, checked: true });
  await (f.api.setConsent(true), f.api.create()); expect(f.command).toHaveBeenCalledTimes(2);
});
it('explicit refresh preserves unresolved command and uses bounded list URL', async () => {
  const f = fixture(); f.operation.mockResolvedValueOnce(error('temporary', 503)); await (f.api.setConsent(true), f.api.create());
  f.operation.mockResolvedValueOnce(envelope({ wishes: [wish], limit: 50 })); await f.api.list();
  expect(f.api.getSnapshot().status).toBe('retry'); await f.api.retry(); expect(f.command).toHaveBeenCalledTimes(1);
  expect(f.operation.mock.calls[1][0].url).toContain('/wishes?membership_epoch=1');
});
it('cancel scrubs draft during save without undoing submitted command or reviving old draft', async () => {
  const f = fixture(); let release!: (r: Response) => void;
  f.operation.mockReturnValueOnce(new Promise(r => { release = r; }));
  const work = (f.api.setConsent(true), f.api.create()); await settle(); f.api.cancel(); f.api.setDraft('Later draft');
  release(ack()); await work; expect(f.api.getSnapshot()).toMatchObject({ draft: 'Later draft', status: 'saved' });
});
it('cancel invalidates late list and permits a new request without old finally changing busy state', async () => {
  const f = fixture(); let release!: (r: Response) => void;
  f.operation.mockReturnValueOnce(new Promise(r => { release = r; })); const work = f.api.list(); await settle();
  f.api.cancel(); expect(f.api.getSnapshot()).toMatchObject({ busy: false, draft: '' });
  f.operation.mockResolvedValueOnce(envelope({ wishes: [], limit: 50 })); await f.api.list();
  release(envelope({ wishes: [wish], limit: 50 })); await work; expect(f.api.getSnapshot().wishes).toEqual([]);
});
it.each([401, 403, 409])('scrubs access denial %s', async status => {
  const f = fixture(); f.operation.mockResolvedValue(error('stale_membership', status)); await (f.api.setConsent(true), f.api.create());
  expect(f.host.block).toHaveBeenCalledWith('access_required'); expect(f.api.getSnapshot()).toMatchObject({ available: false, draft: '', wishes: [], pending: null });
});
it('rejects invalid request, distinguishes unavailable and unknown errors', async () => {
  const f = fixture(); f.operation.mockResolvedValueOnce(error('invalid_request', 400)); await (f.api.setConsent(true), f.api.create());
  expect(f.api.getSnapshot()).toMatchObject({ status: 'invalid', pending: null });
  f.operation.mockResolvedValueOnce(error('not_found', 404)); await f.api.list(); expect(f.api.getSnapshot().status).toBe('unavailable');
  f.operation.mockResolvedValueOnce(error('not_found', 404)); await (f.api.setConsent(true), f.api.create()); expect(f.api.getSnapshot().status).toBe('retry');
  f.operation.mockResolvedValueOnce(error('other_conflict', 409)); await f.api.retry(); expect(f.api.getSnapshot().status).toBe('retry');
});
it.each(['', ' '.repeat(10), 'x'.repeat(201), '\u0000', '\uD800'])('rejects invalid draft %p without request', async draft => {
  const f = fixture(); f.api.setDraft(draft); await (f.api.setConsent(true), f.api.create()); expect(f.api.getSnapshot().status).toBe('invalid'); expect(f.operation).not.toHaveBeenCalled();
});
it('rejects invalid command IDs and bounds draft RAM', async () => {
  const f = fixture(); f.command.mockReturnValue('invalid'); await (f.api.setConsent(true), f.api.create()); expect(f.api.getSnapshot().status).toBe('invalid');
  f.api.setDraft('x'.repeat(2000)); expect(f.api.getSnapshot().draft).toHaveLength(1600);
});
it.each([401, 403, 500])('preflight %s does not mutate', async status => {
  const f = fixture(); f.discovery.mockResolvedValue(error('unavailable', status)); await (f.api.setConsent(true), f.api.create());
  expect(f.operation).not.toHaveBeenCalled(); expect(f.api.getSnapshot().status).toBe(status === 500 ? 'retry' : 'idle');
});
it('preflight changed pair refreshes host, clears pending, never replays into new pair', async () => {
  const f = fixture(); f.discovery.mockResolvedValue(envelope({ ...context, coupleId: uuid(22) })); await (f.api.setConsent(true), f.api.create());
  expect(f.host.refresh).toHaveBeenCalled(); expect(f.operation).not.toHaveBeenCalled(); expect(f.api.getSnapshot().available).toBe(false);
});
it.each(['cookie', 'discovery', 'operation', 'body'])('drops late %s after session invalidation', async point => {
  const f = fixture(); let release!: () => void; const wait = new Promise<void>(r => { release = r; });
  if (point === 'cookie') f.host.getCookie.mockImplementationOnce(async () => { await wait; return 'synthetic=cookie'; });
  if (point === 'discovery') f.discovery.mockImplementationOnce(async () => { await wait; return envelope(context); });
  if (point === 'operation') f.operation.mockImplementationOnce(async () => { await wait; return ack(); });
  if (point === 'body') {
    const response = new Response(new ReadableStream({ async start(controller) {
      await wait; controller.enqueue(new TextEncoder().encode(JSON.stringify({ ok: true, value: { wish, commandId: uuid(3), appliedVersion: 1, replay: false } }))); controller.close();
    } })); f.operation.mockResolvedValueOnce(response);
  }
  const work = (f.api.setConsent(true), f.api.create()); await settle(); f.set(null); f.controller.reset(); release(); await work;
  expect(f.api.getSnapshot()).toMatchObject({ available: false, wishes: [], draft: '', pending: null });
});
it.each([2, 3, 4])('scrubs changed credentials at check %s', async at => {
  const f = fixture(); let n = 0; f.host.getCookie.mockImplementation(async () => ++n >= at ? 'changed' : 'synthetic=cookie');
  await (f.api.setConsent(true), f.api.create()); expect(f.host.block).toHaveBeenCalledWith('auth_required'); expect(f.api.getSnapshot().available).toBe(false);
});
