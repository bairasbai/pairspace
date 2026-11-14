import { createHash } from 'node:crypto';
import { fixture, available, message, envelope, deferred, id } from './morning-discussions.fixture';
import type { V2DiscussionMessage } from '../src/auth/morning-discussion-v2-model';
const digest = async (body: string) => createHash('sha256').update(body).digest('hex');
const setup = () => fixture(digest);
const edited = (version: number, body: string): V2DiscussionMessage => ({ ...message(), version, body,
  editedAt: version === 1 ? null : '2030-01-02T09:00:00.000Z', deletedAt: null });
const tombstone = (): V2DiscussionMessage => ({ ...edited(2, ''), editedAt: null, body: null, deletedAt: '2030-01-02T09:00:00.000Z' });
function ack(value: V2DiscussionMessage) {
  return async (request: Request) => { const command = await request.clone().json();
    return envelope({ commandId: command.command_id, replay: false, message: value }); };
}
const spin = async (test: () => boolean) => { for (let n = 0; n < 100 && !test(); n++) await Promise.resolve(); expect(test()).toBe(true); };
test('own no-op v1, real edit v2, no-op v2 and restoration v3 retain truthful versions', async () => {
  const f = setup(); await f.actions.open(available()); f.actions.beginEdit(message().id);
  const original = message().body!;
  for (const [version, body] of [[1, original], [2, 'new text'], [2, 'new text'], [3, original]] as const) {
    f.actions.setEditDraft(body); f.write.mockImplementationOnce(ack(edited(version, body))); await f.actions.saveEdit();
    expect(f.actions.getSnapshot().editor.status).toBe('saved'); expect(f.actions.getSnapshot().editor.version).toBe(version);
    expect(f.actions.getSnapshot().messages.find(m => m.id === message().id)?.body).toBe(body);
  }
  const expected = await Promise.all(f.write.mock.calls.map(async ([req]) => (await req.clone().json()).expected_version));
  expect(expected).toEqual([1, 1, 2, 2]);
});
test('switching edit target requires explicit cancellation, preserves current private draft', async () => {
  const f = setup(); await f.actions.open(available()); f.actions.beginEdit(message().id); f.actions.setEditDraft('private');
  f.actions.beginEdit(message(2).id); expect(f.actions.getSnapshot().editor.targetId).toBe(message().id);
  expect(f.actions.getSnapshot().editor.draft).toBe('private'); expect(f.actions.getSnapshot().editor.error).toBe('cancel_edit_first');
  f.actions.cancelEdit(); f.actions.beginEdit(message(2).id); expect(f.actions.getSnapshot().editor.targetId).toBe(message(2).id);
  expect(f.write).not.toHaveBeenCalled();
});
test('CAS conflict preserves draft, requires explicit canonical reload before new command', async () => {
  const f = setup(); await f.actions.open(available()); f.actions.beginEdit(message().id); f.actions.setEditDraft('my draft');
  f.write.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: 'version_conflict' }), { status: 409 }));
  await f.actions.saveEdit(); expect(f.actions.getSnapshot().editor.status).toBe('conflict');
  await f.actions.saveEdit(); expect(f.write).toHaveBeenCalledTimes(1);
  f.read.mockImplementationOnce(async request => envelope({ readId: new URL(request.url).searchParams.get('read_id'), message: edited(2, 'other edit') }));
  await f.actions.reloadEdit(); expect(f.actions.getSnapshot().editor.draft).toBe('my draft'); expect(f.actions.getSnapshot().editor.version).toBe(2);
  f.write.mockImplementationOnce(ack(edited(3, 'my draft'))); await f.actions.saveEdit();
  expect(f.actions.getSnapshot().editor.status).toBe('saved');
  const first = await f.write.mock.calls[0][0].clone().json(), second = await f.write.mock.calls[1][0].clone().json();
  expect(second.expected_version).toBe(2); expect(second.command_id).not.toBe(first.command_id);
});
test('delete confirmation exact token stays bound to A after viewing B, cancel sends nothing', async () => {
  const f = setup(); await f.actions.open(available()); f.actions.beginDelete(message().id);
  const canceled = f.actions.getSnapshot().deletion.confirmation!.token; f.actions.cancelDelete(); await f.actions.confirmDelete(canceled);
  expect(f.write).not.toHaveBeenCalled(); f.actions.beginDelete(message().id);
  const chosen = f.actions.getSnapshot().deletion.confirmation!.token;
  await f.actions.open(available(11)); await f.actions.confirmDelete('wrong'); expect(f.write).not.toHaveBeenCalled();
  await f.actions.confirmDelete(chosen); expect(f.write).not.toHaveBeenCalled();
  f.actions.beginDelete(message().id); const fresh = f.actions.getSnapshot().deletion.confirmation!.token;
  f.write.mockImplementationOnce(ack({ ...tombstone(), slotId: id(11) })); await f.actions.confirmDelete(fresh);
  expect(f.write.mock.calls[0][0].url).toContain(`/slots/${id(11)}/`);
  expect(f.write.mock.calls[0][0].method).toBe('DELETE'); expect(f.actions.getSnapshot().slot?.id).toBe(id(11));
});
test('canonical already-deleted response scrubs original, malformed or foreign response does not', async () => {
  for (const invalid of [false, true]) {
    const f = setup(); await f.actions.open(available()); f.actions.beginDelete(message().id);
    f.write.mockImplementationOnce(async request => { const command = await request.json(); return new Response(JSON.stringify({ ok: false,
      error: 'message_deleted', value: { commandId: command.command_id, message: invalid ? { ...tombstone(), id: id(999) } : tombstone() } }), { status: 409 }); });
    await f.actions.confirmDelete(f.actions.getSnapshot().deletion.confirmation!.token);
    const row = f.actions.getSnapshot().messages.find(m => m.id === message().id);
    if (invalid) { expect(row?.body).toBe(message().body); expect(f.actions.getSnapshot().deletion.status).toBe('unknown'); }
    else { expect(row?.body).toBeNull(); expect(f.actions.getSnapshot().deletion.status).toBe('deleted'); }
  }
});
test('unknown edit retries exact command and preserves newer protected draft', async () => {
  const f = setup(); await f.actions.open(available()); f.actions.beginEdit(message().id); f.actions.setEditDraft('submitted');
  f.write.mockRejectedValueOnce(Error('lost response')); await f.actions.saveEdit(); expect(f.actions.getSnapshot().editor.status).toBe('unknown');
  f.actions.setEditDraft('new private text'); f.write.mockImplementationOnce(ack(edited(2, 'submitted'))); await f.actions.retryEdit();
  expect(await f.write.mock.calls[1][0].clone().json()).toEqual(await f.write.mock.calls[0][0].clone().json());
  expect(f.actions.getSnapshot().editor.draft).toBe('new private text'); expect(f.actions.getSnapshot().editor.needsReload).toBe(true);
});
test.each([false, true])('mutation denial old account=%s cannot affect replacement session', async oldAccount => {
  const f = setup(); await f.actions.open(available()); f.actions.beginEdit(message().id); f.actions.setEditDraft('edit');
  const held = deferred(); f.write.mockReturnValueOnce(held.promise); const sending = f.actions.saveEdit(); await spin(() => f.write.mock.calls.length === 1);
  if (oldAccount) f.setCapture(null);
  held.resolve(new Response(JSON.stringify({ ok: false, error: 'unavailable' }), { status: 403 })); await sending;
  if (oldAccount) expect(f.host.block).not.toHaveBeenCalled(); else expect(f.host.block).toHaveBeenCalledWith('access_required');
  expect(f.actions.getSnapshot().editor.draft).toBe('');
});
