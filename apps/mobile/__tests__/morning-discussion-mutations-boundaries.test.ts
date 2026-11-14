import { createHash } from 'node:crypto';
import { createMorningDiscussionMutations, type DiscussionMutationHost, type DiscussionEditor, type DiscussionDelete } from '../src/auth/morning-discussion-mutations';
import { available, message, id, scope } from './morning-discussions.fixture';
import type { V2DiscussionMessage } from '../src/auth/morning-discussion-v2-model';
import type { MorningResult } from '../src/auth/morning-request';
function fixture() {
  let editor: DiscussionEditor = { draft: '', needsReload: false, status: 'idle' }, deletion: DiscussionDelete = { status: 'idle' };
  const token = { generation: 1, identity: { userId: 'provider', sessionId: 'session' }, context: scope };
  const host: DiscussionMutationHost = {
    capture: jest.fn(() => token), current: jest.fn(() => true), busy: jest.fn(() => false),
    find: jest.fn(key => key === message().id ? { slot: available(), message: message() } : null),
    digest: jest.fn(async body => createHash('sha256').update(body).digest('hex')),
    exchange: jest.fn(async (_slot, _method, _id, commandId): Promise<MorningResult> => ({ ok: true, cookie: 'cookie',
      value: { commandId, replay: false, message: { ...message(), version: 2, editedAt: message().createdAt, body: 'edit' } } })),
    parse: jest.fn(raw => raw as V2DiscussionMessage), accept: jest.fn(async next => next),
    publish: jest.fn((e, d) => { editor = e; deletion = d; }),
  };
  const commandId = jest.fn(() => id(900)), feature = createMorningDiscussionMutations(host, commandId);
  return { host, commandId, feature, a: feature.actions, editor: () => editor, deletion: () => deletion };
}
const deleted = (): V2DiscussionMessage => ({ ...message(), version: 2, body: null, editedAt: null, deletedAt: message().createdAt });
test('no target/foreign target/host busy and invalid command never mutate', async () => {
  const f = fixture(); await f.a.saveEdit(); await f.a.reloadEdit(); await f.a.retryDelete(); f.a.setEditDraft('none');
  f.a.beginEdit(id(777)); f.a.beginDelete(id(777)); expect(f.editor().targetId).toBeUndefined();
  jest.mocked(f.host.busy).mockReturnValue(true); f.a.beginEdit(message().id); f.a.beginDelete(message().id);
  jest.mocked(f.host.busy).mockReturnValue(false); f.a.beginEdit(message().id); f.a.beginEdit(message().id);
  f.a.setEditDraft('x'.repeat(8001)); expect(f.editor().draft).toBe(message().body);
  f.a.setEditDraft(''); await f.a.saveEdit(); expect(f.editor().error).toBe('invalid_body');
  f.a.setEditDraft('edit'); f.commandId.mockReturnValue('bad'); await f.a.saveEdit();
  f.a.beginDelete(message().id); await f.a.confirmDelete(f.deletion().confirmation!.token);
  expect(f.host.exchange).not.toHaveBeenCalled();
});
test.each([false, true])('observed revision/terminal invalidates confirmation deleted=%s', deletedFlag => {
  const f = fixture(); f.a.beginDelete(message().id); f.feature.observe(deletedFlag ? deleted() : { ...message(), version: 2, editedAt: message().createdAt });
  expect(f.deletion().confirmation).toBeUndefined(); expect(f.deletion().status).toBe(deletedFlag ? 'deleted' : 'error');
});
test.each(['version_conflict', 'transport_error'])('delete error %s retains retry only for unknown', async error => {
  const f = fixture(); jest.mocked(f.host.exchange).mockResolvedValue({ ok: false, error });
  f.a.beginDelete(message().id); await f.a.confirmDelete(f.deletion().confirmation!.token);
  expect(f.deletion().status).toBe(error === 'version_conflict' ? 'error' : 'unknown');
  expect(f.feature.unresolved()).toBe(error !== 'version_conflict');
  f.a.cancelDelete(); if (error === 'transport_error') expect(f.deletion().status).toBe('unknown');
});
test('delete acceptance may complete without observe callback; malformed acceptance stays unknown', async () => {
  const f = fixture(); jest.mocked(f.host.exchange).mockResolvedValue({ ok: true, cookie: 'cookie', value: { commandId: id(900), replay: false, message: deleted() } });
  f.a.beginDelete(message().id); await f.a.confirmDelete(f.deletion().confirmation!.token); expect(f.deletion().status).toBe('deleted');
  f.feature.reset(); jest.mocked(f.host.accept).mockResolvedValue(null);
  f.a.beginDelete(message().id); await f.a.confirmDelete(f.deletion().confirmation!.token); expect(f.deletion().status).toBe('unknown');
});
test.each(['error', 'malformed', 'foreign', 'acceptFalse', 'throw', 'deleted'])('reload boundary %s preserves private draft', async mode => {
  const f = fixture(); f.a.beginEdit(message().id); f.a.setEditDraft('private');
  const next = mode === 'deleted' ? deleted() : mode === 'foreign' ? { ...message(), id: id(66) } : message();
  jest.mocked(f.host.exchange).mockResolvedValue(mode === 'error' ? { ok: false, error: 'unavailable' }
    : { ok: true, cookie: 'cookie', value: { message: next } });
  if (mode === 'malformed') jest.mocked(f.host.parse).mockReturnValue(null);
  if (mode === 'acceptFalse') jest.mocked(f.host.accept).mockResolvedValue(null);
  if (mode === 'throw') jest.mocked(f.host.exchange).mockRejectedValue(Error('network'));
  await f.a.reloadEdit(); expect(f.editor().draft).toBe('private');
  expect(f.editor().status).toBe(mode === 'deleted' ? 'deleted' : 'error');
  expect(f.editor().needsReload).toBe(true);
});
test.each(['bad', 'reject'])('invalid baseline digest %s refuses send', async mode => {
  const f = fixture();
  if (mode === 'bad') jest.mocked(f.host.digest).mockResolvedValue('bad'); else jest.mocked(f.host.digest).mockRejectedValue(Error('crypto unavailable'));
  f.a.beginEdit(message().id); f.a.setEditDraft('edit'); await f.a.saveEdit(); expect(f.editor().error).toBe('invalid_digest');
  expect(f.host.exchange).not.toHaveBeenCalled();
});
test('suspension removes unedited source but preserves genuinely new private text', () => {
  const f = fixture(); f.a.beginEdit(message().id); f.a.beginDelete(message().id); f.feature.suspend();
  expect(f.editor().draft).toBe(''); expect(f.deletion().confirmation).toBeUndefined();
  f.feature.reset(); f.a.beginEdit(message().id); f.a.setEditDraft('new private'); f.feature.suspend();
  expect(f.editor().draft).toBe('new private'); expect(f.editor().error).toBe('relogin_required');
});
