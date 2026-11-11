import { fixture, ack, envelope, error, song, uuid, context, settle } from './songs-fixtures';
it('does not implicitly write; sync is stable, unavailable actions inert, listener cleanup works', async () => {
  const f = fixture(), listener = jest.fn(), stop = f.api.subscribe(listener);
  f.controller.sync(); expect(listener).not.toHaveBeenCalled(); expect(f.operation).not.toHaveBeenCalled();
  f.controller.reset(); stop(); f.controller.reset(); f.api.setDraft('x'); await f.api.create(); await f.api.retry(); await f.api.list();
  expect(listener).toHaveBeenCalledTimes(1); expect(f.operation).not.toHaveBeenCalled();
  f.set(null); f.controller.sync(); expect(f.api.getSnapshot().available).toBe(false);
});
it('keeps immutable create command through unknown ACK and edited draft, blocks duplicate/different actions', async () => {
  const f = fixture(); let release!: (r: Response) => void;
  f.operation.mockReturnValueOnce(new Promise(r => { release = r; }));
  const work = f.api.create(); await settle();
  await f.api.create(); await f.api.retry(); await f.api.list();
  f.api.setDraft('New draft'); release(error('temporary', 503)); await work;
  expect(f.api.getSnapshot()).toMatchObject({ status: 'retry', pending: { title: song.title } });
  await f.api.create(); expect(f.operation).toHaveBeenCalledTimes(1);
  await f.api.retry(); expect(f.command).toHaveBeenCalledTimes(1);
  expect(await f.operation.mock.calls[1][0].json()).toEqual({ command_id: uuid(3), membership_epoch: 1, title: song.title, explanation: song.explanation });
  expect(f.api.getSnapshot()).toMatchObject({ status: 'saved', draft: 'New draft', songs: [song], pending: null });
  expect(f.operation.mock.calls[0][0].headers.get('Idempotency-Key')).toBe(uuid(3));
});
it('normalizes title, clears only unchanged draft and allows another new command', async () => {
  const f = fixture(); f.api.setDraft('  Shared\n song  '); f.api.setConsent(true); await f.api.create();
  expect(f.api.getSnapshot().draft).toBe(''); expect(f.api.getSnapshot().status).toBe('saved');
  f.api.setDraft(song.title); f.api.setExplanation(song.explanation); f.api.setConsent(true); f.command.mockReturnValue(uuid(4)); f.operation.mockResolvedValue(ack(song, false, uuid(4)));
  f.api.setConsent(true); await f.api.create(); expect(f.command).toHaveBeenCalledTimes(2);
});
it.each(['idempotency_conflict'])('requires explicit refresh on %s before making a new command', async code => {
  const f = fixture(); f.operation.mockResolvedValueOnce(error(code, 409)); await f.api.create();
  expect(f.api.getSnapshot()).toMatchObject({ status: 'conflict', pending: null, requiresRefresh: true });
  await f.api.create(); await f.api.retry(); expect(f.operation).toHaveBeenCalledTimes(1);
  f.operation.mockResolvedValueOnce(envelope({ songs: [], limit: 50 })); await f.api.list();
  expect(f.api.getSnapshot()).toMatchObject({ status: 'idle', requiresRefresh: false, checked: true });
  f.api.setConsent(true); await f.api.create(); expect(f.command).toHaveBeenCalledTimes(2);
});
it('explicit refresh preserves unresolved command and uses bounded list URL', async () => {
  const f = fixture(); f.operation.mockResolvedValueOnce(error('temporary', 503)); await f.api.create();
  f.operation.mockResolvedValueOnce(envelope({ songs: [song], limit: 50 })); await f.api.list();
  expect(f.api.getSnapshot().status).toBe('retry'); await f.api.retry(); expect(f.command).toHaveBeenCalledTimes(1);
  expect(f.operation.mock.calls[1][0].url).toContain('/songs?membership_epoch=1');
});
it('cancel scrubs draft during save without undoing submitted command or reviving old draft', async () => {
  const f = fixture(); let release!: (r: Response) => void;
  f.operation.mockReturnValueOnce(new Promise(r => { release = r; }));
  const work = f.api.create(); await settle(); f.api.cancel(); f.api.setDraft('Later draft');
  release(ack()); await work; expect(f.api.getSnapshot()).toMatchObject({ draft: 'Later draft', status: 'saved' });
});
it('cancel invalidates late list and permits a new request without old finally changing busy state', async () => {
  const f = fixture(); let release!: (r: Response) => void;
  f.operation.mockReturnValueOnce(new Promise(r => { release = r; })); const work = f.api.list(); await settle();
  f.api.cancel(); expect(f.api.getSnapshot()).toMatchObject({ busy: false, draft: '' });
  f.operation.mockResolvedValueOnce(envelope({ songs: [], limit: 50 })); await f.api.list();
  release(envelope({ songs: [song], limit: 50 })); await work; expect(f.api.getSnapshot().songs).toEqual([]);
});
it.each([401, 403, 409])('scrubs access denial %s', async status => {
  const f = fixture(); f.operation.mockResolvedValue(error('stale_membership', status)); await f.api.create();
  expect(f.host.block).toHaveBeenCalledWith('access_required'); expect(f.api.getSnapshot()).toMatchObject({ available: false, draft: '', songs: [], pending: null });
});
it('rejects invalid request, distinguishes unavailable and unknown errors', async () => {
  const f = fixture(); f.operation.mockResolvedValueOnce(error('invalid_request', 400)); await f.api.create();
  expect(f.api.getSnapshot()).toMatchObject({ status: 'invalid', pending: null });
  f.operation.mockResolvedValueOnce(error('not_found', 404)); await f.api.list(); expect(f.api.getSnapshot().status).toBe('unavailable');
  f.operation.mockResolvedValueOnce(error('not_found', 404)); f.api.setConsent(true); await f.api.create(); expect(f.api.getSnapshot().status).toBe('retry');
  f.operation.mockResolvedValueOnce(error('other_conflict', 409)); await f.api.retry(); expect(f.api.getSnapshot().status).toBe('retry');
});
it.each(['', ' '.repeat(10), 'x'.repeat(201), '\u0000', '\uD800'])('rejects invalid draft %p without request', async draft => {
  const f = fixture(); f.api.setDraft(draft); f.api.setConsent(true); await f.api.create(); expect(f.api.getSnapshot().status).toBe('invalid'); expect(f.operation).not.toHaveBeenCalled();
});
it('rejects invalid command IDs and bounds draft RAM', async () => {
  const f = fixture(); f.command.mockReturnValue('invalid'); await f.api.create(); expect(f.api.getSnapshot().status).toBe('invalid');
  f.api.setDraft('x'.repeat(1000)); expect(f.api.getSnapshot().draft).toHaveLength(800);
});
it.each([401, 403, 500])('preflight %s does not mutate', async status => {
  const f = fixture(); f.discovery.mockResolvedValue(error('unavailable', status)); await f.api.create();
  expect(f.operation).not.toHaveBeenCalled(); expect(f.api.getSnapshot().status).toBe(status === 500 ? 'retry' : 'idle');
});
it('preflight changed pair refreshes host, clears pending, never replays into new pair', async () => {
  const f = fixture(); f.discovery.mockResolvedValue(envelope({ ...context, coupleId: uuid(22) })); await f.api.create();
  expect(f.host.refresh).toHaveBeenCalled(); expect(f.operation).not.toHaveBeenCalled(); expect(f.api.getSnapshot().available).toBe(false);
});
it.each(['cookie', 'discovery', 'operation', 'explanation'])('drops late %s after session invalidation', async point => {
  const f = fixture(); let release!: () => void; const wait = new Promise<void>(r => { release = r; });
  if (point === 'cookie') f.host.getCookie.mockImplementationOnce(async () => { await wait; return 'synthetic=cookie'; });
  if (point === 'discovery') f.discovery.mockImplementationOnce(async () => { await wait; return envelope(context); });
  if (point === 'operation') f.operation.mockImplementationOnce(async () => { await wait; return ack(); });
  if (point === 'explanation') {
    const response = new Response(new ReadableStream({ async start(controller) {
      await wait; controller.enqueue(new TextEncoder().encode(JSON.stringify({ ok: true, value: { song, commandId: uuid(3), replay: false } }))); controller.close();
    } })); f.operation.mockResolvedValueOnce(response);
  }
  const work = f.api.create(); await settle(); f.set(null); f.controller.reset(); release(); await work;
  expect(f.api.getSnapshot()).toMatchObject({ available: false, songs: [], draft: '', pending: null });
});
it.each([2, 3, 4])('scrubs changed credentials at check %s', async at => {
  const f = fixture(); let n = 0; f.host.getCookie.mockImplementation(async () => ++n >= at ? 'changed' : 'synthetic=cookie');
  await f.api.create(); expect(f.host.block).toHaveBeenCalledWith('auth_required'); expect(f.api.getSnapshot().available).toBe(false);
});
it('requires renewed explicit consent after every draft change, never sends on typing or checkbox', async () => {
  const f = fixture(); f.api.setConsent(false); await f.api.create(); expect(f.operation).not.toHaveBeenCalled();
  for (const change of [() => f.api.setDraft(song.title), () => f.api.setExplanation(song.explanation)]) {
    f.api.setConsent(true); change(); expect(f.api.getSnapshot().consent).toBe(false); await f.api.create();
  }
  expect(f.operation).not.toHaveBeenCalled(); f.api.setConsent(true); await f.api.create(); expect(f.operation).toHaveBeenCalledTimes(1);
});
it.each(['', '\u0000', '\uD800', 'x'.repeat(2001)])('rejects invalid song explanation %p', async explanation => {
  const f = fixture(); f.api.setExplanation(explanation); f.api.setConsent(true); await f.api.create();
  expect(f.api.getSnapshot().status).toBe('invalid'); expect(f.operation).not.toHaveBeenCalled();
});
it('bounds explanation RAM and ignores edits when unavailable', () => {
  const f = fixture(); f.api.setExplanation('x'.repeat(9000)); expect(f.api.getSnapshot().explanation).toHaveLength(8000);
  f.controller.reset(); f.api.setExplanation('hidden'); f.api.setConsent(true);
  expect(f.api.getSnapshot()).toMatchObject({ explanation: '', consent: false });
});
it.each(['userId', 'coupleId', 'membershipEpoch', 'sessionId'] as const)('invalidates pending write across changed %s', async field => {
  const f = fixture(); let release!: (r: Response) => void;
  f.operation.mockReturnValueOnce(new Promise(r => { release = r; })); const work = f.api.create(); await settle();
  const changed = { ...context, [field]: field === 'membershipEpoch' ? 2 : uuid(33) };
  f.set({ generation: 1, identity: { sessionId: 'session', userId: 'provider' }, context: changed }); f.controller.sync();
  f.api.setDraft('New pair draft'); release(ack()); await work;
  expect(f.api.getSnapshot()).toMatchObject({ draft: 'New pair draft', songs: [], pending: null, busy: false });
});
it('retains same command through a committed replay, never revives cleared draft', async () => {
  const f = fixture(); f.operation.mockRejectedValueOnce(new Error('lost ACK')); await f.api.create();
  f.api.cancel(); f.operation.mockResolvedValueOnce(ack(song, true)); await f.api.retry();
  expect(f.command).toHaveBeenCalledTimes(1); expect(f.api.getSnapshot()).toMatchObject({ draft: '', explanation: '', status: 'saved', songs: [song] });
});
it.each(['explanation', 'clearAndRetype'] as const)('preserves newer %s generation after old ACK', async kind => {
  const f = fixture(); let release!: (r: Response) => void;
  f.operation.mockReturnValueOnce(new Promise(r => { release = r; })); const work = f.api.create(); await settle();
  if (kind === 'explanation') f.api.setExplanation('New explanation');
  if (kind === 'clearAndRetype') {
    f.api.cancel(); f.api.setDraft(song.title); f.api.setExplanation(song.explanation);
  }
  const draft = f.api.getSnapshot(); release(ack()); await work;
  expect(f.api.getSnapshot()).toMatchObject({ draft: draft.draft, explanation: draft.explanation, consent: false, status: 'saved' });
});

it('canonicalizes generated UUID spelling before binding immutable receipt', async () => {
  const f = fixture(), id = 'abcdefab-abcd-4abc-8abc-abcdefabcdef';
  f.command.mockReturnValue(id.toUpperCase()); f.operation.mockResolvedValueOnce(ack(song, false, id));
  await f.api.create();
  expect(f.operation.mock.calls[0][0].headers.get('Idempotency-Key')).toBe(id);
  expect(f.api.getSnapshot().status).toBe('saved');
});
