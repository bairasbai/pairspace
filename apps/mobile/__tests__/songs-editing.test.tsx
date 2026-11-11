import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { SongsPanel } from '../src/auth/SongsPanel';
import { songsCopy } from '../src/auth/songsCopy';
import { fixture, ack, envelope, error, song, uuid, settle, context } from './songs-fixtures';
const link = 'https://youtu.be/synthetic';
async function editing(withLink = false) {
  const f = fixture(); f.operation.mockResolvedValueOnce(envelope({ songs: [{ ...song, ...(withLink ? { musicUrl: link } : {}) }], limit: 50 }));
  await f.api.list(); f.api.cancel(); f.api.beginEdit(song.id); return f;
}
it('selects only after explicit clearing and requires renewed consent before a versioned edit', async () => {
  const f = await editing(); expect(f.api.getSnapshot()).toMatchObject({ editing: { id: song.id, version: 1 }, consent: false });
  await f.api.create(); expect(f.operation).toHaveBeenCalledTimes(1); expect(f.api.getSnapshot().status).toBe('invalid');
  f.api.setConsent(true); f.api.setDraft('Edited'); expect(f.api.getSnapshot().consent).toBe(false);
  f.api.setExplanation('My corrected explanation'); f.api.setMusicUrl(link); f.api.setConsent(true);
  f.operation.mockResolvedValueOnce(ack({ ...song, version: 2, title: 'Edited', explanation: 'My corrected explanation', musicUrl: link }));
  await f.api.create(); const request = f.operation.mock.calls[1][0];
  expect(request.method).toBe('PATCH'); expect(request.url).toContain('/songs/' + song.id);
  expect(await request.json()).toEqual({ command_id: uuid(3), membership_epoch: 1, expected_version: 1,
    title: 'Edited', explanation: 'My corrected explanation', music_url: link });
  expect(f.api.getSnapshot()).toMatchObject({ status: 'saved', editing: null, draft: '', consent: false, songs: [{ version: 2 }] });
});
it('removes an existing link using an absent field, preserving the old snapshot until save', async () => {
  const f = await editing(true); expect(f.api.getSnapshot().musicUrl).toBe(link);
  f.api.setMusicUrl(''); f.api.setConsent(true); f.operation.mockResolvedValueOnce(ack({ ...song, version: 2 }));
  await f.api.create(); expect(await f.operation.mock.calls[1][0].json()).not.toHaveProperty('music_url');
  expect(f.api.getSnapshot().songs[0]).not.toHaveProperty('musicUrl');
});
it('keeps the immutable edit target and all content through lost ACK, clear, retype, refresh and retry', async () => {
  const f = await editing(true); f.api.setDraft('First'); f.api.setConsent(true);
  f.operation.mockResolvedValueOnce(error('temporary', 503)); await f.api.create();
  expect(f.api.getSnapshot()).toMatchObject({ draft: 'First', musicUrl: link, status: 'retry', pending: { editing: { id: song.id, version: 1 }, title: 'First' } });
  f.api.cancel(); f.api.beginEdit(song.id); expect(f.api.getSnapshot().editing).toBeNull();
  f.api.setDraft('Later draft'); f.api.setExplanation('Later explanation'); f.api.setMusicUrl('https://youtu.be/later');
  f.operation.mockResolvedValueOnce(envelope({ songs: [{ ...song, version: 4, title: 'Latest' }], limit: 50 })); await f.api.list();
  f.operation.mockResolvedValueOnce(ack({ ...song, title: 'A subsequent edit', version: 3 }, true)); await f.api.retry();
  expect(await f.operation.mock.calls[3][0].json()).toEqual(await f.operation.mock.calls[1][0].json());
  expect(f.api.getSnapshot()).toMatchObject({ draft: 'Later draft', explanation: 'Later explanation', musicUrl: 'https://youtu.be/later',
    editing: null, pending: null, status: 'saved', songs: [{ version: 4, title: 'Latest' }] });
});
it('accepts old create retry with current canonical content rather than recreating its original payload', async () => {
  const f = fixture(); f.operation.mockResolvedValueOnce(error('temporary', 503)); await f.api.create();
  f.operation.mockResolvedValueOnce(ack({ ...song, version: 3, title: 'Edited since creation', musicUrl: link }, true)); await f.api.retry();
  expect(f.api.getSnapshot()).toMatchObject({ status: 'saved', songs: [{ version: 3, title: 'Edited since creation', musicUrl: link }] });
});
it('keeps conflicted edits private and requires refresh plus explicit discard/reselection, never rebases', async () => {
  const f = await editing(); f.api.setDraft('My draft'); f.api.setConsent(true);
  f.operation.mockResolvedValueOnce(error('version_conflict', 409)); await f.api.create();
  f.api.beginEdit(song.id); expect(f.api.getSnapshot()).toMatchObject({ draft: 'My draft', consent: false, requiresRefresh: true });
  f.operation.mockResolvedValueOnce(envelope({ songs: [{ ...song, version: 2, title: 'Other device' }], limit: 50 })); await f.api.list();
  f.api.beginEdit(song.id); expect(f.api.getSnapshot()).toMatchObject({ draft: 'My draft', editing: { version: 1 } });
  f.api.setConsent(true); await f.api.create(); expect(f.api.getSnapshot().status).toBe('conflict');
  f.operation.mockResolvedValueOnce(envelope({ songs: [{ ...song, version: 2, title: 'Other device' }], limit: 50 })); await f.api.list();
  f.api.cancel(); f.api.beginEdit(song.id); expect(f.api.getSnapshot()).toMatchObject({ draft: 'Other device', editing: { version: 2 }, consent: false });
});
it.each([
  { version: 1 }, { id: uuid(90), version: 2 }, { version: 3 }, { version: 2, title: 'Wrong' },
  { version: 2, creatorId: uuid(7) }, { version: 2, explanation: 'Wrong' }, { version: 2, musicUrl: link },
])('rejects mismatched non-replay ACK %p', async change => {
  const f = await editing(); f.api.setConsent(true); f.operation.mockResolvedValueOnce(ack({ ...song, ...change })); await f.api.create();
  expect(f.api.getSnapshot()).toMatchObject({ status: 'retry', draft: song.title });
});
it('rejects mismatched same-version historical replay rather than accepting forged content', async () => {
  const f = await editing(); f.api.setConsent(true);
  f.operation.mockResolvedValueOnce(ack({ ...song, version: 2, title: 'Different' }, true)); await f.api.create();
  expect(f.api.getSnapshot().status).toBe('retry');
});
it.each([undefined, 0, -1, 1.5, '1', 2147483648])('rejects invalid song version %p', async version => {
  const f = fixture(); f.operation.mockResolvedValueOnce(ack({ ...song, version })); await f.api.create();
  expect(f.api.getSnapshot().status).toBe('retry');
});
it('never overwrites unsent drafts or permits partner, missing or exhausted-version selection', async () => {
  const f = fixture(); f.operation.mockResolvedValueOnce(envelope({ songs: [song], limit: 50 })); await f.api.list();
  f.api.beginEdit(song.id); expect(f.api.getSnapshot().editing).toBeNull();
  f.api.cancel(); f.api.setExplanation('Only explanation'); f.api.beginEdit(song.id); expect(f.api.getSnapshot().editing).toBeNull();
  f.api.cancel(); f.api.setMusicUrl(link); f.api.beginEdit(song.id); expect(f.api.getSnapshot().editing).toBeNull();
  f.api.cancel(); f.api.beginEdit(uuid(90)); expect(f.api.getSnapshot().editing).toBeNull();
  f.operation.mockResolvedValueOnce(envelope({ songs: [{ ...song, creatorId: uuid(7) }], limit: 50 })); await f.api.list();
  f.api.beginEdit(song.id); expect(f.api.getSnapshot().editing).toBeNull();
  f.operation.mockResolvedValueOnce(envelope({ songs: [{ ...song, version: 2147483647 }], limit: 50 })); await f.api.list();
  f.api.beginEdit(song.id); expect(f.api.getSnapshot().editing).toBeNull();
  f.controller.reset(); f.api.beginEdit(song.id); expect(f.api.getSnapshot().editing).toBeNull();
});
it.each(['generation', 'epoch', 'session', 'user', 'pair'] as const)('isolates delayed edit ACK across %s change', async change => {
  const f = await editing(); f.api.setConsent(true); let release!: (value: Response) => void;
  f.operation.mockReturnValueOnce(new Promise(r => { release = r; })); const work = f.api.create(); await settle();
  f.api.beginEdit(song.id);
  const changed = { ...context, ...(change === 'epoch' ? { membershipEpoch: 2 } : change === 'session' ? { sessionId: 'next' }
    : change === 'user' ? { userId: uuid(71) } : change === 'pair' ? { coupleId: uuid(72) } : {}) };
  f.set({ generation: change === 'generation' ? 2 : 1, identity: { sessionId: changed.sessionId, userId: 'provider' }, context: changed });
  f.controller.sync(); f.api.setDraft('New context'); release(ack({ ...song, version: 2 })); await work;
  expect(f.api.getSnapshot()).toMatchObject({ draft: 'New context', songs: [], editing: null, pending: null, busy: false });
});
it('preserves a clear-and-retype edit draft through delayed successful ACK', async () => {
  const f = await editing(); f.api.setConsent(true); let release!: (value: Response) => void;
  f.operation.mockReturnValueOnce(new Promise(r => { release = r; })); const work = f.api.create(); await settle();
  f.api.cancel(); f.api.setDraft(song.title); f.api.setExplanation(song.explanation);
  release(ack({ ...song, version: 2 })); await work;
  expect(f.api.getSnapshot()).toMatchObject({ draft: song.title, explanation: song.explanation, editing: null, pending: null, status: 'saved' });
});
it.each(['ru', 'en'] as const)('renders author-only edit and explicit changes confirmation in %s', async locale => {
  const f = await editing(), t = songsCopy[locale];
  const props = { locale, view: f.api.getSnapshot(), onEdit: f.api.beginEdit, onDraft: f.api.setDraft,
    onExplanation: f.api.setExplanation, onMusicUrl: f.api.setMusicUrl, onConsent: f.api.setConsent,
    onCreate: () => { void f.api.create(); }, onRetry: () => { void f.api.retry(); }, onList: () => { void f.api.list(); }, onCancel: f.api.cancel };
  const ui = render(<SongsPanel {...props} />);
  expect(screen.getByText(t.editRule)).toBeTruthy(); expect(screen.getByText(t.cancelHint)).toBeTruthy();
  fireEvent.press(screen.getByText(t.saveEdit)); expect(f.operation).toHaveBeenCalledTimes(1);
  fireEvent.press(screen.getByLabelText(t.consent)); ui.rerender(<SongsPanel {...props} view={f.api.getSnapshot()} />);
  f.operation.mockResolvedValueOnce(error('temporary', 503));
  await act(async () => { fireEvent.press(screen.getByText(t.saveEdit)); });
  ui.rerender(<SongsPanel {...props} view={f.api.getSnapshot()} />); expect(screen.getAllByText(new RegExp(song.id)).length).toBeGreaterThan(0);
  fireEvent.press(screen.getByText(t.cancel)); ui.rerender(<SongsPanel {...props} view={f.api.getSnapshot()} />);
  f.operation.mockResolvedValueOnce(ack({ ...song, version: 2 }));
  await act(async () => { fireEvent.press(screen.getByText(t.again)); });
  ui.rerender(<SongsPanel {...props} view={f.api.getSnapshot()} />);
  fireEvent.press(screen.getByText(t.edit)); expect(f.api.getSnapshot().editing?.version).toBe(2);
  ui.rerender(<SongsPanel {...props} view={{ ...f.api.getSnapshot(), songs: [{ ...song, creatorId: uuid(7) }] }} />);
  expect(screen.queryByText(t.edit)).toBeNull(); ui.unmount();
});
