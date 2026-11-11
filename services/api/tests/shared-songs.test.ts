import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createSharedSong, listSharedSongs } from '../src/shared-songs.ts';
import { createSharedSongsHandler } from '../src/shared-songs-http.ts';
import { bindSessionAuthority } from '../src/auth-authority.ts';
import { createSyntheticAuthority } from '../src/synthetic-authority.ts';
import { normalizeSongExplanation } from '../../../packages/domain/songs/text.ts';
import { adapter, c1, c2, createFixture, id, identityPrincipal, outsider, principal, u2, waiting } from './fixtures.ts';
let pg: PGlite;
const scope = { coupleId: c1, membershipEpoch: 1 };
const command = { ...scope, commandId: id(801), title: ' Synthetic e\u0301\r\n song ', explanation: 'Synthetic explanation' };
const db = () => adapter(pg);
beforeAll(async () => { pg = await createFixture(); for (const file of ['016_shared_songs.sql']) await pg.exec(await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8')); });
afterAll(async () => { await pg.close(); });
it('creates once, shares with both partners, binds all normalized fields', async () => {
  expect(await listSharedSongs(db(), principal, scope)).toEqual({ ok: true, value: { songs: [], limit: 50 } });
  const first = await createSharedSong(db(), principal, command);
  expect(first).toMatchObject({ ok: true, value: { replay: false, song: { title: 'Synthetic é song', explanation: 'Synthetic explanation', createdAt: '2026-11-10T00:00:00.000Z' } } });
  if (!first.ok) throw Error('fixture');
  expect(await createSharedSong(db(), principal, command)).toMatchObject({ ok: true, value: { replay: true, song: first.value.song } });
  for (const change of [{ title: 'different' }, { explanation: 'Changed explanation' }]) {
    expect(await createSharedSong(db(), principal, { ...command, ...change })).toEqual({ ok: false, error: 'idempotency_conflict' });
  }
  expect(await listSharedSongs(db(), identityPrincipal(u2), scope)).toMatchObject({ ok: true, value: { songs: [first.value.song] } });
  const partner = { ...command, commandId: id(802), explanation: 'Other explanation' };
  expect(await createSharedSong(db(), identityPrincipal(u2), partner)).toMatchObject({ ok: true, value: { song: { explanation: 'Other explanation', creatorId: u2 } } });
  expect(await createSharedSong(db(), identityPrincipal(u2), { ...partner, explanation: 'Changed explanation' })).toEqual({ ok: false, error: 'idempotency_conflict' });
  expect(await createSharedSong(db(), identityPrincipal(u2), partner)).toMatchObject({ ok: true, value: { replay: true } });
  expect((await pg.query('SELECT * FROM shared_songs')).rows).toHaveLength(2);
});
it('rejects malformed input, inactive/foreign scopes and stale sessions after locks', async () => {
  for (const bad of [null, [], {}, { ...command, actorId: u2 }, { ...command, commandId: 'bad' }, { ...command, coupleId: 'bad' }, { ...command, membershipEpoch: 0 }, { ...command, title: '' }, { ...command, explanation: '' }, { ...command, explanation: '\ud800' }, { ...command, musicUrl: 'https://example.invalid' }]) {
    expect(await createSharedSong(db(), principal, bad)).toEqual({ ok: false, error: 'invalid_request' });
  }
  expect(await listSharedSongs(db(), principal, command)).toEqual({ ok: false, error: 'invalid_request' });
  for (const [operation, input] of [[createSharedSong, command], [listSharedSongs, scope]] as const) {
    expect(await operation(db(), { ...principal, userId: 'bad' }, input)).toEqual({ ok: false, error: 'unavailable' });
    for (const coupleId of [c2, waiting, id(999)]) expect(await operation(db(), principal, { ...input, coupleId })).toEqual({ ok: false, error: 'unavailable' });
    expect(await operation(db(), identityPrincipal(outsider), input)).toEqual({ ok: false, error: 'unavailable' });
    expect(await operation(db(), principal, { ...input, membershipEpoch: 2 })).toEqual({ ok: false, error: 'stale_membership' });
    expect(await operation(db(), { ...principal, tokenExpiresAt: 1 }, input)).toEqual({ ok: false, error: 'unavailable' });
    let calls = 0; const source = db();
    expect(await operation(bindSessionAuthority(source, { ...source.sessionAuthority, recheck: async () => ++calls === 1 }), principal, input)).toEqual({ ok: false, error: 'unavailable' });
  }
  const source = db();
  await expect(createSharedSong(bindSessionAuthority({ ...source, now: () => new Date(NaN) }, { ...source.sessionAuthority, recheck: async () => true }), principal, { ...command, commandId: id(899) })).rejects.toThrow('invalid_server_clock');
  await pg.query('UPDATE couples SET membership_epoch=2 WHERE id=$1', [c1]);
  expect(await createSharedSong(db(), principal, { ...command, membershipEpoch: 2 })).toEqual({ ok: false, error: 'idempotency_conflict' });
  await pg.query('UPDATE couples SET membership_epoch=1 WHERE id=$1', [c1]);
});
const path = `/v1/couples/${c1}/songs`;
const explanation = { command_id: id(850), membership_epoch: 1, title: 'Synthetic song', explanation: 'Synthetic text' };
const make = (method = 'POST', input: unknown = explanation, suffix = '', headers: Record<string, string> = {}) => new Request('http://localhost' + path + suffix, {
  method, headers: { authorization: 'Bearer fixture', 'content-type': 'application/json', 'idempotency-key': id(850), ...headers },
  ...(method === 'POST' ? { body: JSON.stringify(input) } : {}),
});
it('enforces HTTP methods/schema/auth and keeps errors redacted', async () => {
  const handler = createSharedSongsHandler(bindSessionAuthority(db(), createSyntheticAuthority(async () => principal)));
  expect((await handler(new Request('http://localhost/unknown'))).status).toBe(404);
  expect((await handler(make('DELETE'))).headers.get('allow')).toBe('GET, POST');
  expect((await handler(make('GET', null, '?membership_epoch=1'))).status).toBe(200);
  for (const suffix of ['', '?membership_epoch=0', '?membership_epoch=1&membership_epoch=1', '?membership_epoch=1&actor=x']) expect((await handler(make('GET', null, suffix))).status).toBe(400);
  expect((await handler(make('POST', explanation, '?x=1'))).status).toBe(400);
  expect((await handler(make('POST', explanation, '', { 'content-type': 'text/plain' }))).status).toBe(415);
  expect((await handler(new Request('http://localhost' + path, { method: 'POST', headers: { authorization: 'Bearer fixture' }, body: '{}' }))).status).toBe(415);
  for (const input of [null, [], {}, { ...explanation, command_id: 'bad' }, { ...explanation, command_id: id(800) }, { ...explanation, actor: u2 }]) expect((await handler(make('POST', input))).status).toBe(400);
  expect((await handler(new Request('http://localhost' + path, { method: 'POST', headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' }, body: '{' }))).status).toBe(400);
  const saved = await handler(make()); expect(saved.status).toBe(201); expect(saved.headers.get('cache-control')).toBe('no-store');
  expect((await handler(make())).status).toBe(200);
  expect((await handler(make('POST', { ...explanation, title: 'changed' }))).status).toBe(409);
  expect((await handler(make('POST', { ...explanation, membership_epoch: 0 }))).status).toBe(400);
  for (const principalValue of [null, { ...principal, userId: 'bad' }]) {
    const denied = createSharedSongsHandler(bindSessionAuthority(db(), createSyntheticAuthority(async () => principalValue)));
    expect((await denied(make())).status).toBe(401);
  }
  const foreign = createSharedSongsHandler(bindSessionAuthority(db(), createSyntheticAuthority(async () => identityPrincipal(outsider))));
  expect((await foreign(make())).status).toBe(403);
  const wrongSource = createSharedSongsHandler({ ...db(), sessionAuthority: { ...db().sessionAuthority, authenticate: async () => ({ ...principal, source: 'better-auth' as const, authUserId: 'synthetic' }) } });
  expect((await wrongSource(make())).status).toBe(401);
  const throws = createSharedSongsHandler({ ...db(), sessionAuthority: { ...db().sessionAuthority, authenticate: async () => { throw Error('secret title'); } } });
  expect(await (await throws(make())).json()).toEqual({ ok: false, error: 'temporarily_unavailable' });
});
it('normalizes Unicode with a short explanation bound and rejects invalid input', () => {
  expect(normalizeSongExplanation('e\u0301\r\nx')).toEqual({ ok: true, text: 'é\nx' });
  expect(normalizeSongExplanation('😀'.repeat(2000)).ok).toBe(true);
  for (const explanation of [null, '', ' ', '\ud800', '\u0000', 'x'.repeat(8001), '😀'.repeat(2001)]) expect(normalizeSongExplanation(explanation).ok).toBe(false);
});
it('database forbids mutations and invalid explanation/title/foreign author', async () => {
  for (const sql of ['UPDATE shared_songs SET title=title', 'DELETE FROM shared_songs']) await expect(pg.query(sql)).rejects.toMatchObject({ code: '23514' });
  for (const explanation of [' ', 'x'.repeat(2001), 'e\u0301', 'x\r']) {
    await expect(pg.query("INSERT INTO shared_songs(couple_id,creator_id,membership_epoch,command_id,title,explanation,created_at) VALUES($1,$2,1,$3,'synthetic',$4,'2026-01-01Z')", [c1, principal.userId, id(890), explanation])).rejects.toMatchObject({ code: '23514' });
  }
  for (const title of ['', 'e\u0301', ' x', 'x  y', 'x\n', 'x'.repeat(201)]) {
    await expect(pg.query("INSERT INTO shared_songs(couple_id,creator_id,membership_epoch,command_id,title,explanation,created_at) VALUES($1,$2,1,$3,$4,'synthetic','2026-01-01Z')", [c1, principal.userId, id(891), title])).rejects.toMatchObject({ code: '23514' });
  }
  await expect(pg.query("INSERT INTO shared_songs(couple_id,creator_id,membership_epoch,command_id,title,explanation,created_at) VALUES($1,$2,1,$3,'synthetic','text','2026-01-01Z')", [c2, principal.userId, id(890)])).rejects.toMatchObject({ code: '23503' });
});
it('caps stable latest-created lists at fifty, not a complete archive', async () => {
  for (let n = 0; n < 51; n++) await createSharedSong(db(), principal, { ...command, commandId: id(900 + n) });
  const result = await listSharedSongs(db(), principal, scope);
  if (!result.ok) throw Error('fixture');
  expect(result.value.songs).toHaveLength(50);
  const ids = result.value.songs.map(song => song.id);
  expect(ids).toEqual([...ids].sort().reverse());
  await pg.query("UPDATE couples SET status='closed' WHERE id=$1", [c1]);
  expect(await listSharedSongs(db(), principal, scope)).toEqual({ ok: false, error: 'unavailable' });
  expect(await createSharedSong(db(), principal, command)).toEqual({ ok: false, error: 'unavailable' });
});
