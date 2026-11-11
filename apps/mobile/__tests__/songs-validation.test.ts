import { normalizeTaskTitle } from '../../../packages/domain/tasks/title';
import { fixture, ack, envelope, song, uuid, context } from './songs-fixtures';
import { validSong, sameSongContext, songOrder } from '../src/auth/songs-state';
it.each(['id', 'creatorId', 'coupleId', 'membershipEpoch', 'title', 'explanation', 'createdAt'])('rejects invalid song %s', async field => {
  const f = fixture(); f.operation.mockResolvedValue(ack({ ...song, [field]: 'bad' })); await f.api.create();
  expect(f.api.getSnapshot()).toMatchObject({ status: 'retry', error: true });
});
it.each([null, [], {}, { ok: false }, { ok: true, value: null }, { ok: true, value: { song } }])('rejects malformed envelope %p', async explanation => {
  const f = fixture(); f.operation.mockResolvedValue(new Response(JSON.stringify(explanation))); await f.api.create(); expect(f.api.getSnapshot().status).toBe('retry');
});
it.each([
  { song: { ...song, createdAt: 123 } }, { song: { ...song, title: ' unnormalized ' } },
  { song: { ...song, creatorId: uuid(4) } }, { song: { ...song, title: 'Different' } },
  { song: { ...song, localDate: '2028-03-01' } }, { song: { ...song, explanation: 'Different explanation' } },
  { commandId: uuid(8) }, { replay: 'true' }, { song: { ...song, extra: true } },
])('rejects mismatched ACK %p', async changes => {
  const f = fixture(); f.operation.mockResolvedValue(envelope({ song, commandId: uuid(3), replay: false, ...changes }));
  await f.api.create(); expect(f.api.getSnapshot().status).toBe('retry');
});
it('rejects malformed JSON', async () => {
  const f = fixture(); f.operation.mockResolvedValueOnce(new Response('no JSON')); await f.api.create();
  expect(f.api.getSnapshot().status).toBe('retry');
});
it.each([
  { songs: null, limit: 50 }, { songs: [], limit: 51 }, { songs: [null], limit: 50 },
  { songs: [song, song], limit: 50 }, { songs: Array(51).fill(song), limit: 50 },
  { songs: [{ ...song, coupleId: uuid(22) }], limit: 50 },
  { songs: [song, { ...song, id: uuid(10) }], limit: 50 },
  { songs: [song, { ...song, id: uuid(8), createdAt: '2026-11-11T00:00:00.000Z' }], limit: 50 },
])('rejects malformed, unsorted, foreign or unbounded list %p', async value => {
  const f = fixture(); f.operation.mockResolvedValue(envelope(value)); await f.api.list();
  expect(f.api.getSnapshot()).toMatchObject({ error: true, checked: false, songs: [] });
});
it('keeps list bounded and sorted after ACK, including ID tie breaking', async () => {
  const f = fixture(); const songs = Array.from({ length: 50 }, (_, i) => ({ ...song, id: uuid(100 - i) }));
  f.operation.mockResolvedValueOnce(envelope({ songs, limit: 50 })); await f.api.list();
  f.operation.mockResolvedValueOnce(ack({ ...song, createdAt: '2026-11-11T00:00:00.000Z' }));
  await f.api.create(); expect(f.api.getSnapshot().songs).toHaveLength(50); expect(f.api.getSnapshot().songs[0].id).toBe(song.id);
});
it('validates pure state boundaries and deterministic comparator', () => {
  expect(validSong(song, { ...context, state: 'waiting_partner' })).toBe(false);
  expect(sameSongContext(context, { ...context, userId: uuid(8) })).toBe(false);
  expect(sameSongContext(context, { ...context, state: 'waiting_partner' })).toBe(false);
  expect(songOrder(song, song)).toBe(0);
  expect(songOrder(song, { ...song, id: uuid(8) })).toBe(-1);
  expect(songOrder(song, { ...song, createdAt: '2026-11-09T00:00:00.000Z' })).toBe(-1);
});
it('normalizes domain Unicode titles and enforces every input boundary on mobile', () => {
  expect(normalizeTaskTitle(null)).toEqual({ ok: false });
  expect(normalizeTaskTitle('x'.repeat(1601))).toEqual({ ok: false });
  expect(normalizeTaskTitle('\t Cafe\u0301\n together  ')).toEqual({ ok: true, text: 'Café together' });
  expect(normalizeTaskTitle('😀'.repeat(200))).toEqual({ ok: true, text: '😀'.repeat(200) });
  expect(normalizeTaskTitle('\u200B')).toEqual({ ok: false });
});
it.each([
  { ok: true, value: { song, replay: false, commandId: uuid(3) }, extra: true },
  { ok: true, value: { song, replay: false, commandId: uuid(3), extra: true } },
])('rejects extra envelope fields %p', async explanation => {
  const f = fixture(); f.operation.mockResolvedValue(new Response(JSON.stringify(explanation))); await f.api.create();
  expect(f.api.getSnapshot().status).toBe('retry');
});
it('rejects an oversized list response', async () => {
  const f = fixture(); f.operation.mockResolvedValue(new Response('x'.repeat(1048577))); await f.api.list();
  expect(f.api.getSnapshot()).toMatchObject({ checked: false, error: true });
});
it('publishes normalized Unicode explanation', async () => {
  const f = fixture(); const normalized = { ...song, title: 'Café', explanation: ' Café\n😀 ' };
  f.api.setDraft(' Cafe\u0301 '); f.api.setExplanation(' Cafe\u0301\r\n😀 '); f.api.setConsent(true);
  f.operation.mockResolvedValueOnce(ack(normalized)); await f.api.create();
  expect(await f.operation.mock.calls[0][0].json()).toMatchObject({ title: normalized.title, explanation: normalized.explanation });
  expect(f.api.getSnapshot()).toMatchObject({ status: 'saved', songs: [normalized] });
});
