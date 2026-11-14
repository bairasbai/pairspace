import type { V2DiscussionMessage } from '../src/auth/morning-discussion-v2-model';
import { available, deferred, envelope, fixture, id, message, scope, sha } from './morning-discussions.fixture';
const edited = (body = 'edited', version = 2): V2DiscussionMessage => ({ ...message(), body, version, editedAt: message().createdAt });
const dead = (): V2DiscussionMessage => ({ ...edited(), body: null, version: 3, deletedAt: message().createdAt });
const page = (request: Request, messages: V2DiscussionMessage[]) => envelope({ readId: new URL(request.url).searchParams.get('read_id'),
  slotId: id(10), messages, hasPrevious: false, hasNext: false, previousCursor: null, nextCursor: null });
function hashGate() {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let started = false;
  const digest = jest.fn(async (body: string) => { if (body === 'held') { started = true; await held; } return sha(body); });
  return { digest, release, started: () => started };
}
it('delayed digest after logout cannot populate a new account or change its state', async () => {
  const gate = hashGate(), f = fixture(gate.digest);
  f.read.mockImplementationOnce(async r => page(r, [edited('held')]));
  const reading = f.actions.open(available()); while (!gate.started()) await Promise.resolve();
  f.setCapture(null);
  f.setCapture({ generation: 2, identity: { userId: 'new', sessionId: 'session' }, context: scope });
  gate.release(); await reading;
  expect(f.actions.getSnapshot()).toMatchObject({ available: true, messages: [], draft: '', editor: { status: 'idle' } });
});
it('delayed digest rechecks cookie before any cache commit or publication', async () => {
  const gate = hashGate(), f = fixture(gate.digest);
  f.read.mockImplementationOnce(async r => page(r, [edited('held')]));
  const reading = f.actions.open(available()); while (!gate.started()) await Promise.resolve();
  f.host.getCookie.mockResolvedValue('other-session'); gate.release(); await reading;
  expect(f.host.block).toHaveBeenCalledWith('auth_required');
  expect(f.actions.getSnapshot().messages).toEqual([]);
});
it('held read hashing cannot replace a newer navigation', async () => {
  const gate = hashGate(), f = fixture(gate.digest);
  f.read.mockImplementationOnce(async r => page(r, [edited('held')]));
  const reading = f.actions.open(available()); while (!gate.started()) await Promise.resolve();
  await f.actions.open(available(11)); f.actions.setDraft('new context');
  gate.release(); await reading;
  expect(f.actions.getSnapshot()).toMatchObject({ slot: { id: id(11) }, draft: 'new context', busy: false });
  expect(f.actions.getSnapshot().messages.every(m => m.slotId === id(11))).toBe(true);
});
it('observed tombstone immediately scrubs unchanged pending edit and late live ACK cannot resurrect it', async () => {
  const f = fixture(); await f.actions.open(available()); f.actions.beginEdit(message().id); f.actions.setEditDraft('submitted');
  const held = deferred(); f.write.mockImplementationOnce(() => held.promise);
  const saving = f.actions.saveEdit(); while (!f.write.mock.calls.length) await Promise.resolve();
  const snapshots: string[] = [];
  const unsubscribe = f.actions.subscribe(() => snapshots.push(JSON.stringify(f.actions.getSnapshot())));
  f.read.mockImplementationOnce(async r => page(r, [dead()])); await f.actions.last();
  unsubscribe();
  for (const snapshot of snapshots.filter(value => value.includes('\"deletedAt\":\"'))) {
    expect(snapshot).not.toContain('submitted');
    expect(snapshot).not.toContain('Answer 1\\nSecond line');
  }
  expect(f.actions.getSnapshot().editor).toMatchObject({ draft: '', status: 'deleted', needsReload: true });
  await f.actions.retryEdit(); expect(f.write).toHaveBeenCalledTimes(1);
  const command = await f.write.mock.calls[0][0].clone().json();
  held.resolve(envelope({ commandId: command.command_id, replay: false, message: edited('submitted') })); await saving;
  expect(f.actions.getSnapshot().messages[0]).toEqual(dead());
  expect(f.actions.getSnapshot().history?.messages[0]).toEqual(dead());
  expect(JSON.stringify(f.actions.getSnapshot())).not.toContain('submitted');
});
it('delete preserves genuinely newer private edit text but blocks saving it', async () => {
  const f = fixture(); await f.actions.open(available()); f.actions.beginEdit(message().id);
  f.actions.setEditDraft('private newer');
  f.read.mockImplementationOnce(async r => page(r, [dead()])); await f.actions.first();
  expect(f.actions.getSnapshot().editor).toMatchObject({ status: 'deleted', draft: 'private newer', needsReload: true });
  await f.actions.saveEdit(); expect(f.write).not.toHaveBeenCalled();
});
it('lost create receipt can return canonical edited or deleted message, never original-body equality for v2', async () => {
  const f = fixture(); await f.actions.open(available()); f.actions.setDraft('original create');
  f.write.mockRejectedValueOnce(Error('lost')); await f.actions.send(); f.actions.setDraft('new private');
  f.write.mockImplementationOnce(async r => { const input = await r.clone().json(); return envelope({ commandId: input.command_id, replay: true,
    message: { ...edited('remote edit'), id: id(4000), seq: 72, clientId: input.command_id } }); });
  await f.actions.retry(); expect(f.actions.getSnapshot()).toMatchObject({ pendingId: undefined, draft: 'new private', status: 'sent' });
  f.write.mockRejectedValueOnce(Error('lost')); await f.actions.send();
  f.write.mockImplementationOnce(async r => { const input = await r.clone().json(); return envelope({ commandId: input.command_id, replay: true,
    message: { ...dead(), id: id(4001), seq: 73, clientId: input.command_id } }); });
  await f.actions.retry(); expect(f.actions.getSnapshot()).toMatchObject({ pendingId: undefined, draft: '' });
});
it('terminal observed in another response wins during a delayed live edit digest', async () => {
  const gate = hashGate(), f = fixture(gate.digest);
  await f.actions.open(available()); f.actions.beginEdit(message().id); f.actions.setEditDraft('submitted');
  f.write.mockImplementationOnce(async r => { const input = await r.clone().json(); return envelope({ commandId: input.command_id, replay: true, message: edited('held') }); });
  const saving = f.actions.saveEdit(); while (!gate.started()) await Promise.resolve();
  f.read.mockImplementationOnce(async r => page(r, [dead()])); await f.actions.last();
  gate.release(); await saving;
  expect(f.actions.getSnapshot().messages[0]).toEqual(dead());
  expect(f.actions.getSnapshot().editor.status).toBe('deleted');
});
it('terminal knowledge survives leaving the window and rejects uppercase alias wire IDs', async () => {
  const f = fixture(); f.read.mockImplementationOnce(async r => page(r, [dead()])); await f.actions.open(available());
  await f.actions.open(available(11));
  f.read.mockImplementationOnce(async r => page(r, [{ ...edited('stale'), version: 50 }])); await f.actions.open(available());
  expect(f.actions.getSnapshot().messages).toEqual([dead()]);
  f.read.mockImplementationOnce(async r => page(r, [{ ...edited(), id: 'AAAAAAAA-0000-4000-8000-000000000001' }])); await f.actions.first();
  expect(f.actions.getSnapshot().error).toBe('invalid_response');
  expect(f.actions.getSnapshot().messages).toEqual([dead()]);
});
for (const terminal of [false, true]) {
  it(`500 ${terminal ? 'terminal' : 'edited'} identities remain bounded; 501 suspends, preserves private draft and blocks actions`, async () => {
    const f = fixture();
    await f.actions.open(available()); f.actions.setDraft('unrelated private');
    for (let start = 1; start <= 500; start += 30) {
      const rows = Array.from({ length: Math.min(30, 501 - start) }, (_, index): V2DiscussionMessage => ({
        ...message(start + index), version: terminal ? 3 : 2, body: terminal ? null : `edited ${start + index}`,
        editedAt: message().createdAt, deletedAt: terminal ? message().createdAt : null,
      }));
      f.read.mockImplementationOnce(async r => page(r, rows)); await f.actions.first();
      expect(f.actions.getSnapshot().suspended).not.toBe(true);
    }
    f.read.mockImplementationOnce(async r => page(r, [{ ...message(501), version: terminal ? 3 : 2,
      body: terminal ? null : '501', editedAt: message().createdAt, deletedAt: terminal ? message().createdAt : null }]));
    await f.actions.first();
    expect(f.actions.getSnapshot()).toMatchObject({ suspended: true, messages: [], history: null, draft: 'unrelated private' });
    const count = f.read.mock.calls.length;
    await f.actions.first(); await f.actions.send();
    expect(f.read).toHaveBeenCalledTimes(count); expect(f.write).not.toHaveBeenCalled();
    f.setCapture(null); expect(f.actions.getSnapshot().suspended).toBeUndefined();
  });
}
it('crypto rejection fails closed without falsely claiming a memory limit and an obsolete error is ignored', async () => {
  let reject!: (reason: Error) => void;
  let started = false;
  const digest = async (body: string) => body === 'fail' ? new Promise<string>((_, fail) => { started = true; reject = fail; }) : sha(body);
  const f = fixture(digest);
  f.read.mockImplementationOnce(async r => page(r, [edited('fail')]));
  const old = f.actions.open(available()); while (!started) await Promise.resolve();
  await f.actions.open(available(11)); f.actions.setDraft('B'); reject(Error('crypto offline')); await old;
  expect(f.actions.getSnapshot()).toMatchObject({ slot: { id: id(11) }, draft: 'B', error: undefined });
  f.read.mockImplementationOnce(async r => page(r, [edited('fail')])); started = false;
  const current = f.actions.open(available()); while (!started) await Promise.resolve();
  reject(Error('crypto offline')); await current;
  expect(f.actions.getSnapshot().error).toBe('invalid_response'); expect(f.actions.getSnapshot().suspended).not.toBe(true);
});
it('fresh canonical detail with wrong read nonce cannot grant an editor version', async () => {
  const f = fixture(); await f.actions.open(available()); f.actions.beginEdit(message().id); f.actions.setEditDraft('mine');
  f.read.mockResolvedValueOnce(envelope({ readId: id(999), message: edited() }));
  await f.actions.reloadEdit();
  expect(f.actions.getSnapshot().editor).toMatchObject({ draft: 'mine', version: 1, needsReload: true, error: 'invalid_response' });
});
it('reload adopts fresh canonical text only for unchanged prefill, preserving intentional private edits', async () => {
  const f = fixture(); await f.actions.open(available()); f.actions.beginEdit(message().id);
  const detail = (r: Request) => envelope({ readId: new URL(r.url).searchParams.get('read_id'), message: edited('other device') });
  f.read.mockImplementationOnce(async r => detail(r)); await f.actions.reloadEdit();
  expect(f.actions.getSnapshot().editor).toMatchObject({ draft: 'other device', version: 2, needsReload: false, draftPreserved: false });
  f.actions.setEditDraft('intentional mine');
  f.read.mockImplementationOnce(async r => detail(r)); await f.actions.reloadEdit();
  expect(f.actions.getSnapshot().editor).toMatchObject({ draft: 'intentional mine', version: 2, needsReload: false, draftPreserved: true });
});
it('typing during a held reload preserves the new private revision', async () => {
  const f = fixture(); await f.actions.open(available()); f.actions.beginEdit(message().id);
  const held = deferred(); f.read.mockImplementationOnce(() => held.promise);
  const reloading = f.actions.reloadEdit(); while (f.read.mock.calls.length < 2) await Promise.resolve();
  f.actions.setEditDraft('typed while loading');
  held.resolve(envelope({ readId: new URL(f.read.mock.calls[1][0].url).searchParams.get('read_id'), message: edited('fresh') }));
  await reloading;
  expect(f.actions.getSnapshot().editor).toMatchObject({ draft: 'typed while loading', version: 2, draftPreserved: true, needsReload: false });
});
it('terminal pending-create replay preserves a newer draft under B and clears only exact original A', async () => {
  const f = fixture(); await f.actions.open(available()); f.actions.setDraft('submitted A');
  f.write.mockRejectedValueOnce(Error('lost')); await f.actions.send();
  await f.actions.open(available(11)); f.actions.setDraft('new B');
  f.write.mockImplementationOnce(async r => { const input = await r.clone().json(); return envelope({ commandId: input.command_id, replay: true,
    message: { ...dead(), id: id(4001), seq: 73, clientId: input.command_id } }); });
  await f.actions.retry();
  expect(f.actions.getSnapshot()).toMatchObject({ slot: { id: id(11) }, draft: 'new B', pendingId: undefined });
  expect(f.actions.getSnapshot().savedDraftSlots.map(slot => slot.id)).toEqual([id(11)]);
  await f.actions.open(available()); f.actions.setDraft('A submitted again');
  f.write.mockRejectedValueOnce(Error('lost')); await f.actions.send(); f.actions.setDraft('genuinely newer A');
  f.write.mockImplementationOnce(async r => { const input = await r.clone().json(); return envelope({ commandId: input.command_id, replay: true,
    message: { ...dead(), id: id(4002), seq: 74, clientId: input.command_id } }); });
  await f.actions.retry(); expect(f.actions.getSnapshot().draft).toBe('genuinely newer A');
});
it('501st terminal pending-create result hides the exact submitted composer without evicting safety facts', async () => {
  const f = fixture();
  await f.actions.open(available());
  for (let start = 1; start <= 500; start += 30) {
    const rows = Array.from({ length: Math.min(30, 501 - start) }, (_, index): V2DiscussionMessage => ({
      ...message(start + index), version: 2, body: null, deletedAt: message().createdAt,
    }));
    f.read.mockImplementationOnce(async r => page(r, rows)); await f.actions.first();
  }
  f.actions.setDraft('submitted hidden by terminal'); f.write.mockRejectedValueOnce(Error('lost')); await f.actions.send();
  f.write.mockImplementationOnce(async r => { const input = await r.clone().json(); return envelope({ commandId: input.command_id, replay: true,
    message: { ...message(501), version: 2, body: null, deletedAt: message().createdAt, clientId: input.command_id } }); });
  await f.actions.retry();
  expect(f.actions.getSnapshot()).toMatchObject({ suspended: true, draft: '', messages: [], history: null, pendingId: id(3000) });
  expect(JSON.stringify(f.actions.getSnapshot())).not.toContain('submitted hidden');
});
it('missing targets are not editable and a same-scope sync preserves current private state', async () => {
  const f = fixture(); await f.actions.open(available()); f.actions.setDraft('private');
  f.feature.sync(); f.actions.beginEdit(id(9999)); f.actions.beginDelete(id(9999));
  expect(f.actions.getSnapshot()).toMatchObject({ draft: 'private', editor: { status: 'idle' }, deletion: { status: 'idle' } });
});
it('create replay hashing denied by changed cookie does not publish canonical text or a success', async () => {
  const gate = hashGate(), f = fixture(gate.digest);
  await f.actions.open(available()); f.actions.setDraft('initial');
  f.write.mockImplementationOnce(async r => { const input = await r.clone().json(); return envelope({ commandId: input.command_id, replay: true,
    message: { ...edited('held'), id: id(4000), seq: 72, clientId: input.command_id } }); });
  const sending = f.actions.send(); while (!gate.started()) await Promise.resolve();
  f.host.getCookie.mockResolvedValue('replaced'); gate.release(); await sending;
  expect(f.host.block).toHaveBeenCalledWith('auth_required');
  expect(f.actions.getSnapshot()).toMatchObject({ available: false, messages: [], draft: '' });
});
it('explicit delete does not confuse a genuine unsent edit draft with submitted edit text', async () => {
  const f = fixture(); await f.actions.open(available()); f.actions.beginEdit(message().id);
  f.actions.setEditDraft('private never submitted edit'); f.actions.beginDelete(message().id);
  f.write.mockImplementationOnce(async r => { const input = await r.clone().json(); return envelope({ commandId: input.command_id,
    replay: false, message: { ...message(), body: null, version: 2, deletedAt: message().createdAt } }); });
  await f.actions.confirmDelete(f.actions.getSnapshot().deletion.confirmation!.token);
  expect(f.actions.getSnapshot().editor).toMatchObject({ draft: 'private never submitted edit', status: 'deleted', needsReload: true });
  expect(f.actions.getSnapshot().deletion.status).toBe('deleted');
  await f.actions.saveEdit(); expect(f.write).toHaveBeenCalledTimes(1);
});
