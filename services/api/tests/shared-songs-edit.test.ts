import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createSharedSong, editSharedSong, listSharedSongs } from '../src/shared-songs.ts';
import { createSharedSongsHandler } from '../src/shared-songs-http.ts';
import { bindSessionAuthority } from '../src/auth-authority.ts';
import { createSyntheticAuthority } from '../src/synthetic-authority.ts';
import { adapter, c1, c2, createFixture, id, identityPrincipal, outsider, principal, u2 } from './fixtures.ts';
let pg: PGlite;
const create = { coupleId: c1, membershipEpoch: 1, commandId: id(3801), title: 'Synthetic original', explanation: 'Synthetic reason' };
let songId: string;
const edit = () => ({ ...create, commandId: id(3802), songId, expectedVersion: 1, title: 'Synthetic edited',
  explanation: 'Synthetic edited reason', musicUrl: 'https://youtu.be/Synthetic123' });
beforeAll(async () => {
  pg = await createFixture();
  for (const file of ['016_shared_songs.sql', '017_shared_song_links.sql', '018_edit_shared_songs.sql'])
    await pg.exec(await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  const result = await createSharedSong(adapter(pg), principal, create);
  if (!result.ok) throw Error('fixture'); songId = result.value.song.id;
});
afterAll(async () => { await pg.close(); });
it('only author edits; version CAS and historical commands return canonical current content', async () => {
  expect(await editSharedSong(adapter(pg), identityPrincipal(u2), edit())).toEqual({ ok: false, error: 'unavailable' });
  expect(await editSharedSong(adapter(pg), principal, edit())).toMatchObject({ ok: true, value: { replay: false,
    song: { id: songId, version: 2, title: edit().title, creatorId: principal.userId, musicUrl: edit().musicUrl } } });
  const newer = { ...edit(), commandId: id(3803), expectedVersion: 2, title: 'Synthetic newest', musicUrl: undefined };
  expect(await editSharedSong(adapter(pg), principal, newer)).toMatchObject({ ok: true, value: { song: { version: 3 } } });
  for (const result of [await editSharedSong(adapter(pg), principal, edit()), await createSharedSong(adapter(pg), principal, create)]) {
    expect(result).toMatchObject({ ok: true, value: { replay: true, song: { version: 3, title: newer.title } } });
    if (!result.ok) throw Error('fixture'); expect(result.value.song).not.toHaveProperty('musicUrl');
  }
  expect(await editSharedSong(adapter(pg), principal, { ...edit(), commandId: id(3804) })).toEqual({ ok: false, error: 'version_conflict' });
  for (const change of [{ title: 'changed' }, { explanation: 'changed' }, { expectedVersion: 2 }, { songId: id(3999) }, { musicUrl: undefined }])
    expect(await editSharedSong(adapter(pg), principal, { ...edit(), ...change })).toEqual({ ok: false, error: 'idempotency_conflict' });
  expect(await createSharedSong(adapter(pg), principal, { ...create, commandId: edit().commandId })).toEqual({ ok: false, error: 'idempotency_conflict' });
  expect(await editSharedSong(adapter(pg), principal, { ...edit(), commandId: create.commandId })).toEqual({ ok: false, error: 'idempotency_conflict' });
  expect((await pg.query('SELECT * FROM shared_song_commands')).rows).toHaveLength(3);
  expect(await listSharedSongs(adapter(pg), identityPrincipal(u2), { coupleId: c1, membershipEpoch: 1 }))
    .toMatchObject({ ok: true, value: { songs: [expect.objectContaining({ version: 3 })] } });
});
it('rejects malformed edits and inaccessible resources before replay', async () => {
  for (const change of [{ songId: 'bad' }, { expectedVersion: 0 }, { expectedVersion: 1.5 }, { expectedVersion: 2147483647 },
    { expectedVersion: '1' }, { extra: true }, { musicUrl: null }, { title: '' }, { explanation: '' }])
    expect(await editSharedSong(adapter(pg), principal, { ...edit(), ...change })).toEqual({ ok: false, error: 'invalid_request' });
  expect(await editSharedSong(adapter(pg), principal, { ...edit(), commandId: id(3899), songId: id(3999) })).toEqual({ ok: false, error: 'unavailable' });
  for (const actor of [identityPrincipal(outsider), { ...principal, userId: 'bad' }, { ...principal, tokenExpiresAt: 1 }])
    expect(await editSharedSong(adapter(pg), actor, edit())).toEqual({ ok: false, error: 'unavailable' });
  expect(await editSharedSong(adapter(pg), principal, { ...edit(), coupleId: c2 })).toEqual({ ok: false, error: 'unavailable' });
  expect(await editSharedSong(adapter(pg), principal, { ...edit(), membershipEpoch: 2 })).toEqual({ ok: false, error: 'stale_membership' });
  expect(await listSharedSongs(adapter(pg), principal, { coupleId: c1, membershipEpoch: 1, musicUrl: undefined }))
    .toEqual({ ok: false, error: 'invalid_request' });
});
it('PATCH is explicit, strict and returns 200 without claiming a new resource', async () => {
  const handler = createSharedSongsHandler(bindSessionAuthority(adapter(pg), createSyntheticAuthority(async () => principal)));
  const body = { command_id: id(3850), membership_epoch: 1, expected_version: 3, title: 'Synthetic HTTP edit', explanation: 'Synthetic HTTP reason' };
  const send = (input: unknown = body, suffix = '', method = 'PATCH', target = songId) => handler(new Request(`http://localhost/v1/couples/${c1}/songs/${target}${suffix}`,
    { method, headers: { authorization: 'Bearer fixture', 'content-type': 'application/json', 'idempotency-key': body.command_id }, ...(method === 'GET' ? {} : { body: JSON.stringify(input) }) }));
  expect((await send()).status).toBe(200);
  expect(await (await send()).json()).toMatchObject({ ok: true, value: { replay: true, song: { version: 4 } } });
  expect((await send({ ...body, expected_version: 2 })).status).toBe(409);
  for (const change of [{ expected_version: undefined }, { explanation: undefined }, { song_id: songId }])
    expect((await send({ ...body, ...change })).status).toBe(400);
  expect((await send(body, '?extra=1')).status).toBe(400);
  expect((await send(body, '', 'PATCH', 'invalid')).status).toBe(400);
  for (const method of ['GET', 'POST', 'DELETE']) expect((await send(body, '', method)).status).toBe(405);
});
it('database preserves identity and immutable snapshots and checks author and content', async () => {
  for (const assignment of ["creator_id='" + u2 + "'", "couple_id='" + c2 + "'", 'membership_epoch=2',
    "created_at='2026-01-01Z'", "command_id='" + id(3999) + "'", "music_url='https://localhost/private'", "explanation=''", "title=''"])
    await expect(pg.query(`UPDATE shared_songs SET version=version+1,${assignment} WHERE id=$1`, [songId])).rejects.toMatchObject({ code: '23514' });
  await expect(pg.query('UPDATE shared_songs SET version=version WHERE id=$1', [songId])).rejects.toMatchObject({ code: '23514' });
  for (const table of ['shared_songs', 'shared_song_commands']) await expect(pg.query(`DELETE FROM ${table}`)).rejects.toMatchObject({ code: '23514' });
  await expect(pg.query('UPDATE shared_song_commands SET expected_version=2')).rejects.toMatchObject({ code: '23514' });
  for (const actor of [principal.userId, u2]) await expect(pg.query(`INSERT INTO shared_song_commands(actor_user_id,command_id,couple_id,membership_epoch,song_id,title,explanation,operation,expected_version)
    VALUES($1,$2,$3,1,$4,'mismatch','mismatch','edit',3)`, [actor, id(3890), c1, songId])).rejects.toMatchObject({ code: '23503' });
  await pg.query("UPDATE couples SET status='closed' WHERE id=$1", [c1]);
  expect(await editSharedSong(adapter(pg), principal, edit())).toEqual({ ok: false, error: 'unavailable' });
});
