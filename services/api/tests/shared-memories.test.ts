import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createSharedMemory, listSharedMemories } from '../src/shared-memories.ts';
import { createSharedMemoriesHandler } from '../src/shared-memories-http.ts';
import { bindSessionAuthority } from '../src/auth-authority.ts';
import { createSyntheticAuthority } from '../src/synthetic-authority.ts';
import { normalizeMemoryBody } from '../../../packages/domain/memories/text.ts';
import { adapter, c1, c2, createFixture, id, identityPrincipal, outsider, principal, u2, waiting } from './fixtures.ts';
let pg: PGlite;
const scope = { coupleId: c1, membershipEpoch: 1 };
const command = { ...scope, commandId: id(801), title: ' Synthetic e\u0301\r\n memory ', localDate: '2028-02-29', body: 'Synthetic body' };
const db = () => adapter(pg);
beforeAll(async () => { pg = await createFixture(); for (const file of ['012_shared_dates.sql', '015_shared_memories.sql']) await pg.exec(await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8')); });
afterAll(async () => { await pg.close(); });
it('creates once, shares with both partners, preserves calendar labels, and binds all normalized fields', async () => {
  expect(await listSharedMemories(db(), principal, scope)).toEqual({ ok: true, value: { memories: [], limit: 50 } });
  const first = await createSharedMemory(db(), principal, command);
  expect(first).toMatchObject({ ok: true, value: { replay: false, memory: { title: 'Synthetic é memory', localDate: '2028-02-29', body: 'Synthetic body', createdAt: '2026-11-10T00:00:00.000Z' } } });
  if (!first.ok) throw Error('fixture');
  expect(await createSharedMemory(db(), principal, command)).toMatchObject({ ok: true, value: { replay: true, memory: first.value.memory } });
  for (const change of [{ title: 'different' }, { localDate: '2028-03-01' }, { body: 'Changed body' }]) {
    expect(await createSharedMemory(db(), principal, { ...command, ...change })).toEqual({ ok: false, error: 'idempotency_conflict' });
  }
  expect(await listSharedMemories(db(), identityPrincipal(u2), scope)).toMatchObject({ ok: true, value: { memories: [first.value.memory] } });
  const partner = { ...command, commandId: id(802), body: 'Other body' };
  expect(await createSharedMemory(db(), identityPrincipal(u2), partner)).toMatchObject({ ok: true, value: { memory: { localDate: '2028-02-29', body: 'Other body', creatorId: u2 } } });
  expect(await createSharedMemory(db(), identityPrincipal(u2), { ...partner, body: 'Changed body' })).toEqual({ ok: false, error: 'idempotency_conflict' });
  expect(await createSharedMemory(db(), identityPrincipal(u2), partner)).toMatchObject({ ok: true, value: { replay: true } });
  expect((await pg.query('SELECT * FROM shared_memories')).rows).toHaveLength(2);
});
it('rejects malformed input, inactive/foreign scopes and stale sessions after locks', async () => {
  for (const bad of [null, [], {}, { ...command, actorId: u2 }, { ...command, commandId: 'bad' }, { ...command, coupleId: 'bad' }, { ...command, membershipEpoch: 0 }, { ...command, title: '' }, { ...command, body: '' }, { ...command, body: '\ud800' }, { ...command, localDate: '2026-02-30' }]) {
    expect(await createSharedMemory(db(), principal, bad)).toEqual({ ok: false, error: 'invalid_request' });
  }
  expect(await listSharedMemories(db(), principal, command)).toEqual({ ok: false, error: 'invalid_request' });
  for (const [operation, input] of [[createSharedMemory, command], [listSharedMemories, scope]] as const) {
    expect(await operation(db(), { ...principal, userId: 'bad' }, input)).toEqual({ ok: false, error: 'unavailable' });
    for (const coupleId of [c2, waiting, id(999)]) expect(await operation(db(), principal, { ...input, coupleId })).toEqual({ ok: false, error: 'unavailable' });
    expect(await operation(db(), identityPrincipal(outsider), input)).toEqual({ ok: false, error: 'unavailable' });
    expect(await operation(db(), principal, { ...input, membershipEpoch: 2 })).toEqual({ ok: false, error: 'stale_membership' });
    expect(await operation(db(), { ...principal, tokenExpiresAt: 1 }, input)).toEqual({ ok: false, error: 'unavailable' });
    let calls = 0; const source = db();
    expect(await operation(bindSessionAuthority(source, { ...source.sessionAuthority, recheck: async () => ++calls === 1 }), principal, input)).toEqual({ ok: false, error: 'unavailable' });
  }
  const source = db();
  await expect(createSharedMemory(bindSessionAuthority({ ...source, now: () => new Date(NaN) }, { ...source.sessionAuthority, recheck: async () => true }), principal, { ...command, commandId: id(899) })).rejects.toThrow('invalid_server_clock');
  await pg.query('UPDATE couples SET membership_epoch=2 WHERE id=$1', [c1]);
  expect(await createSharedMemory(db(), principal, { ...command, membershipEpoch: 2 })).toEqual({ ok: false, error: 'idempotency_conflict' });
  await pg.query('UPDATE couples SET membership_epoch=1 WHERE id=$1', [c1]);
});
const path = `/v1/couples/${c1}/memories`;
const body = { command_id: id(850), membership_epoch: 1, title: 'Synthetic memory', local_date: '0001-01-01', body: 'Synthetic text' };
const make = (method = 'POST', input: unknown = body, suffix = '', headers: Record<string, string> = {}) => new Request('http://localhost' + path + suffix, {
  method, headers: { authorization: 'Bearer fixture', 'content-type': 'application/json', 'idempotency-key': id(850), ...headers },
  ...(method === 'POST' ? { body: JSON.stringify(input) } : {}),
});
it('enforces HTTP methods/schema/auth and keeps errors redacted', async () => {
  const handler = createSharedMemoriesHandler(bindSessionAuthority(db(), createSyntheticAuthority(async () => principal)));
  expect((await handler(new Request('http://localhost/unknown'))).status).toBe(404);
  expect((await handler(make('DELETE'))).headers.get('allow')).toBe('GET, POST');
  expect((await handler(make('GET', null, '?membership_epoch=1'))).status).toBe(200);
  for (const suffix of ['', '?membership_epoch=0', '?membership_epoch=1&membership_epoch=1', '?membership_epoch=1&actor=x']) expect((await handler(make('GET', null, suffix))).status).toBe(400);
  expect((await handler(make('POST', body, '?x=1'))).status).toBe(400);
  expect((await handler(make('POST', body, '', { 'content-type': 'text/plain' }))).status).toBe(415);
  expect((await handler(new Request('http://localhost' + path, { method: 'POST', headers: { authorization: 'Bearer fixture' }, body: '{}' }))).status).toBe(415);
  for (const input of [null, [], {}, { ...body, command_id: 'bad' }, { ...body, command_id: id(800) }, { ...body, actor: u2 }]) expect((await handler(make('POST', input))).status).toBe(400);
  expect((await handler(new Request('http://localhost' + path, { method: 'POST', headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' }, body: '{' }))).status).toBe(400);
  const saved = await handler(make()); expect(saved.status).toBe(201); expect(saved.headers.get('cache-control')).toBe('no-store');
  expect((await handler(make())).status).toBe(200);
  expect((await handler(make('POST', { ...body, title: 'changed' }))).status).toBe(409);
  expect((await handler(make('POST', { ...body, membership_epoch: 0 }))).status).toBe(400);
  for (const principalValue of [null, { ...principal, userId: 'bad' }]) {
    const denied = createSharedMemoriesHandler(bindSessionAuthority(db(), createSyntheticAuthority(async () => principalValue)));
    expect((await denied(make())).status).toBe(401);
  }
  const foreign = createSharedMemoriesHandler(bindSessionAuthority(db(), createSyntheticAuthority(async () => identityPrincipal(outsider))));
  expect((await foreign(make())).status).toBe(403);
  const wrongSource = createSharedMemoriesHandler({ ...db(), sessionAuthority: { ...db().sessionAuthority, authenticate: async () => ({ ...principal, source: 'better-auth' as const, authUserId: 'synthetic' }) } });
  expect((await wrongSource(make())).status).toBe(401);
  const throws = createSharedMemoriesHandler({ ...db(), sessionAuthority: { ...db().sessionAuthority, authenticate: async () => { throw Error('secret title'); } } });
  expect(await (await throws(make())).json()).toEqual({ ok: false, error: 'temporarily_unavailable' });
});
it('normalizes Unicode with a short body bound and rejects invalid input', () => {
  expect(normalizeMemoryBody('e\u0301\r\nx')).toEqual({ ok: true, text: 'é\nx' });
  expect(normalizeMemoryBody('😀'.repeat(2000)).ok).toBe(true);
  for (const body of [null, '', ' ', '\ud800', '\u0000', 'x'.repeat(8001), '😀'.repeat(2001)]) expect(normalizeMemoryBody(body).ok).toBe(false);
});
it('database forbids mutations and invalid body/date/foreign author', async () => {
  for (const sql of ['UPDATE shared_memories SET title=title', 'DELETE FROM shared_memories']) await expect(pg.query(sql)).rejects.toMatchObject({ code: '23514' });
  for (const [body, day] of [[' ', '2026-01-01'], ['x', '2026-02-29'], ['x'.repeat(2001), '2026-01-01'], ['e\u0301', '2026-01-01'], ['x\r', '2026-01-01']]) {
    await expect(pg.query("INSERT INTO shared_memories(couple_id,creator_id,membership_epoch,command_id,title,body,local_date,created_at) VALUES($1,$2,1,$3,'','body','2026-01-01','2026-01-01Z')", [c1, principal.userId, id(891)])).rejects.toMatchObject({ code: '23514' });
  await expect(pg.query("INSERT INTO shared_memories(couple_id,creator_id,membership_epoch,command_id,title,body,local_date,created_at) VALUES($1,$2,1,$3,'synthetic',$4,$5,'2026-01-01Z')", [c1, principal.userId, id(890), body, day])).rejects.toMatchObject({ code: '23514' });
  }
  await expect(pg.query("INSERT INTO shared_memories(couple_id,creator_id,membership_epoch,command_id,title,body,local_date,created_at) VALUES($1,$2,1,$3,'synthetic','text','2026-01-01','2026-01-01Z')", [c2, principal.userId, id(890)])).rejects.toMatchObject({ code: '23503' });
});
it('caps stable latest-created lists at fifty, not an upcoming-only or complete archive view', async () => {
  for (let n = 0; n < 51; n++) await createSharedMemory(db(), principal, { ...command, commandId: id(900 + n) });
  const result = await listSharedMemories(db(), principal, scope);
  if (!result.ok) throw Error('fixture');
  expect(result.value.memories).toHaveLength(50);
  const ids = result.value.memories.map(date => date.id);
  expect(ids).toEqual([...ids].sort().reverse());
  await pg.query("UPDATE couples SET status='closed' WHERE id=$1", [c1]);
  expect(await listSharedMemories(db(), principal, scope)).toEqual({ ok: false, error: 'unavailable' });
  expect(await createSharedMemory(db(), principal, command)).toEqual({ ok: false, error: 'unavailable' });
});
