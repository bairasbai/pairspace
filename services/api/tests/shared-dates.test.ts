import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createSharedDate, listSharedDates } from '../src/shared-dates.ts';
import { createSharedDatesHandler } from '../src/shared-dates-http.ts';
import { bindSessionAuthority } from '../src/auth-authority.ts';
import { createSyntheticAuthority } from '../src/synthetic-authority.ts';
import { isLocalDate, validatedTimezone } from '../../../packages/domain/dates/calendar.ts';
import { adapter, c1, c2, createFixture, id, identityPrincipal, outsider, principal, u2, waiting } from './fixtures.ts';
let pg: PGlite;
const scope = { coupleId: c1, membershipEpoch: 1 };
const command = { ...scope, commandId: id(801), title: ' Synthetic e\u0301\r\n date ', localDate: '2028-02-29', timezone: 'Asia/Tokyo' };
const db = () => adapter(pg);
beforeAll(async () => { pg = await createFixture(); await pg.exec(await readFile(new URL('../migrations/012_shared_dates.sql', import.meta.url), 'utf8')); });
afterAll(async () => { await pg.close(); });
it('validates real bounded Gregorian days and IANA aliases without converting to instants', () => {
  for (const value of ['0001-01-01', '9999-12-31', '2028-02-29', '2000-02-29', '2026-04-30']) expect(isLocalDate(value)).toBe(true);
  for (const value of [null, 1, '', '0000-01-01', '10000-01-01', '2026-00-01', '2026-13-01', '2026-01-00', '2026-04-31', '1900-02-29', '2026-02-29', '2026-1-01', '2026-01-01T00:00:00Z']) expect(isLocalDate(value)).toBe(false);
  expect(validatedTimezone('US/Pacific')).toBe('US/Pacific');
  expect(validatedTimezone('asia/tokyo')).toBe('asia/tokyo');
  expect(validatedTimezone('Etc/UTC')).toBe('Etc/UTC');
  for (const zone of [null, 1, '', '+09:00', '-0800', ' Asia/Tokyo', 'x'.repeat(101), 'Mars/Olympus']) expect(validatedTimezone(zone)).toBeNull();
});
it('creates once, shares with both partners, preserves calendar labels, and binds all normalized fields', async () => {
  expect(await listSharedDates(db(), principal, scope)).toEqual({ ok: true, value: { dates: [], limit: 50 } });
  const first = await createSharedDate(db(), principal, command);
  expect(first).toMatchObject({ ok: true, value: { replay: false, date: { title: 'Synthetic é date', localDate: '2028-02-29', timezone: 'Asia/Tokyo', createdAt: '2026-11-10T00:00:00.000Z' } } });
  if (!first.ok) throw Error('fixture');
  expect(await createSharedDate(db(), principal, command)).toMatchObject({ ok: true, value: { replay: true, date: first.value.date } });
  for (const change of [{ title: 'different' }, { localDate: '2028-03-01' }, { timezone: 'America/Los_Angeles' }]) {
    expect(await createSharedDate(db(), principal, { ...command, ...change })).toEqual({ ok: false, error: 'idempotency_conflict' });
  }
  expect(await listSharedDates(db(), identityPrincipal(u2), scope)).toMatchObject({ ok: true, value: { dates: [first.value.date] } });
  const partner = { ...command, commandId: id(802), timezone: 'US/Pacific' };
  expect(await createSharedDate(db(), identityPrincipal(u2), partner)).toMatchObject({ ok: true, value: { date: { localDate: '2028-02-29', timezone: 'US/Pacific', creatorId: u2 } } });
  expect(await createSharedDate(db(), identityPrincipal(u2), { ...partner, timezone: 'America/Los_Angeles' })).toEqual({ ok: false, error: 'idempotency_conflict' });
  expect(await createSharedDate(db(), identityPrincipal(u2), partner)).toMatchObject({ ok: true, value: { replay: true } });
  expect((await pg.query('SELECT * FROM shared_date_commands')).rows).toHaveLength(2);
});
it('rejects malformed input, inactive/foreign scopes and stale sessions after locks', async () => {
  for (const bad of [null, [], {}, { ...command, actorId: u2 }, { ...command, commandId: 'bad' }, { ...command, coupleId: 'bad' }, { ...command, membershipEpoch: 0 }, { ...command, title: '' }, { ...command, timezone: 'bad' }, { ...command, timezone: 'asia/tokyo' }, { ...command, localDate: '2026-02-30' }]) {
    expect(await createSharedDate(db(), principal, bad)).toEqual({ ok: false, error: 'invalid_request' });
  }
  expect(await listSharedDates(db(), principal, command)).toEqual({ ok: false, error: 'invalid_request' });
  for (const [operation, input] of [[createSharedDate, command], [listSharedDates, scope]] as const) {
    expect(await operation(db(), { ...principal, userId: 'bad' }, input)).toEqual({ ok: false, error: 'unavailable' });
    for (const coupleId of [c2, waiting, id(999)]) expect(await operation(db(), principal, { ...input, coupleId })).toEqual({ ok: false, error: 'unavailable' });
    expect(await operation(db(), identityPrincipal(outsider), input)).toEqual({ ok: false, error: 'unavailable' });
    expect(await operation(db(), principal, { ...input, membershipEpoch: 2 })).toEqual({ ok: false, error: 'stale_membership' });
    expect(await operation(db(), { ...principal, tokenExpiresAt: 1 }, input)).toEqual({ ok: false, error: 'unavailable' });
    let calls = 0; const source = db();
    expect(await operation(bindSessionAuthority(source, { ...source.sessionAuthority, recheck: async () => ++calls === 1 }), principal, input)).toEqual({ ok: false, error: 'unavailable' });
  }
  const source = db();
  await expect(createSharedDate(bindSessionAuthority({ ...source, now: () => new Date(NaN) }, { ...source.sessionAuthority, recheck: async () => true }), principal, { ...command, commandId: id(899) })).rejects.toThrow('invalid_server_clock');
  await pg.query('UPDATE couples SET membership_epoch=2 WHERE id=$1', [c1]);
  expect(await createSharedDate(db(), principal, { ...command, membershipEpoch: 2 })).toEqual({ ok: false, error: 'idempotency_conflict' });
  await pg.query('UPDATE couples SET membership_epoch=1 WHERE id=$1', [c1]);
});
const path = `/v1/couples/${c1}/dates`;
const body = { command_id: id(850), membership_epoch: 1, title: 'Synthetic date', local_date: '0001-01-01', timezone: 'UTC' };
const make = (method = 'POST', input: unknown = body, suffix = '', headers: Record<string, string> = {}) => new Request('http://localhost' + path + suffix, {
  method, headers: { authorization: 'Bearer fixture', 'content-type': 'application/json', 'idempotency-key': id(850), ...headers },
  ...(method === 'POST' ? { body: JSON.stringify(input) } : {}),
});
it('enforces HTTP methods/schema/auth and keeps errors redacted', async () => {
  const handler = createSharedDatesHandler(bindSessionAuthority(db(), createSyntheticAuthority(async () => principal)));
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
    const denied = createSharedDatesHandler(bindSessionAuthority(db(), createSyntheticAuthority(async () => principalValue)));
    expect((await denied(make())).status).toBe(401);
  }
  const foreign = createSharedDatesHandler(bindSessionAuthority(db(), createSyntheticAuthority(async () => identityPrincipal(outsider))));
  expect((await foreign(make())).status).toBe(403);
  const wrongSource = createSharedDatesHandler({ ...db(), sessionAuthority: { ...db().sessionAuthority, authenticate: async () => ({ ...principal, source: 'better-auth' as const, authUserId: 'synthetic' }) } });
  expect((await wrongSource(make())).status).toBe(401);
  const throws = createSharedDatesHandler({ ...db(), sessionAuthority: { ...db().sessionAuthority, authenticate: async () => { throw Error('secret title'); } } });
  expect(await (await throws(make())).json()).toEqual({ ok: false, error: 'temporarily_unavailable' });
});
it('database forbids mutations, invalid calendars/zones, cross-pair receipts and fractional timestamps', async () => {
  for (const sql of ['UPDATE shared_date_commands SET title=title', 'DELETE FROM shared_date_commands', 'UPDATE shared_dates SET title=title', 'DELETE FROM shared_dates']) await expect(pg.query(sql)).rejects.toMatchObject({ code: '23514' });
  for (const localDate of ['bad', '0000-01-01', '2026-00-01', '2026-13-01', '2026-02-00', '2026-02-29', '1900-02-29']) {
    await expect(pg.query("INSERT INTO shared_dates(couple_id,creator_id,membership_epoch,title,local_date,timezone,created_at) VALUES($1,$2,1,'synthetic',$3,'UTC','2026-01-01Z')", [c1, principal.userId, localDate])).rejects.toMatchObject({ code: '23514' });
  }
  await expect(pg.query("INSERT INTO shared_dates(couple_id,creator_id,membership_epoch,title,local_date,timezone,created_at) VALUES($1,$2,1,'synthetic','2026-01-01','Mars/Olympus','2026-01-01Z')", [c1, principal.userId])).rejects.toMatchObject({ code: '23514' });
  await expect(pg.query("INSERT INTO shared_dates(couple_id,creator_id,membership_epoch,title,local_date,timezone,created_at) VALUES($1,$2,1,'synthetic','2026-01-01','UTC','2026-01-01 00:00:00.000001Z')", [c1, principal.userId])).rejects.toMatchObject({ code: '23514' });
  await expect(pg.query('INSERT INTO shared_date_commands SELECT actor_user_id,$1,$2,membership_epoch,date_id,title,local_date,timezone FROM shared_date_commands LIMIT 1', [id(890), c2])).rejects.toMatchObject({ code: '23503' });
});
it('caps stable latest-created lists at fifty, not an upcoming-only or complete archive view', async () => {
  for (let n = 0; n < 51; n++) await createSharedDate(db(), principal, { ...command, commandId: id(900 + n) });
  const result = await listSharedDates(db(), principal, scope);
  if (!result.ok) throw Error('fixture');
  expect(result.value.dates).toHaveLength(50);
  const ids = result.value.dates.map(date => date.id);
  expect(ids).toEqual([...ids].sort().reverse());
  await pg.query("UPDATE couples SET status='closed' WHERE id=$1", [c1]);
  expect(await listSharedDates(db(), principal, scope)).toEqual({ ok: false, error: 'unavailable' });
  expect(await createSharedDate(db(), principal, command)).toEqual({ ok: false, error: 'unavailable' });
});
