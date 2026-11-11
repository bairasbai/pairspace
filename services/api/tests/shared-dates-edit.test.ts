import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createSharedDate, editSharedDate } from '../src/shared-dates.ts';
import { createSharedDatesHandler } from '../src/shared-dates-http.ts';
import { bindSessionAuthority } from '../src/auth-authority.ts';
import { createSyntheticAuthority } from '../src/synthetic-authority.ts';
import { adapter, c1, c2, createFixture, id, identityPrincipal, outsider, principal, u2 } from './fixtures.ts';
let pg: PGlite;
const create = { coupleId: c1, membershipEpoch: 1, commandId: id(2801), title: 'Synthetic original',
  localDate: '2028-02-29', timezone: 'UTC', recurrence: 'annual', leapDayPolicy: 'feb28' };
let dateId: string;
const edit = () => ({ ...create, commandId: id(2802), dateId, expectedVersion: 1, title: 'Synthetic edited',
  timezone: 'Asia/Tokyo', leapDayPolicy: 'mar1' });
beforeAll(async () => {
  pg = await createFixture();
  for (const file of ['012_shared_dates.sql', '013_annual_shared_dates.sql', '014_edit_shared_dates.sql'])
    await pg.exec(await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  const result = await createSharedDate(adapter(pg), principal, create);
  if (!result.ok) throw Error('fixture'); dateId = result.value.date.id;
});
afterAll(async () => { await pg.close(); });
it('either partner edits with version CAS; historical create and edit return current canonical data', async () => {
  const partner = identityPrincipal(u2);
  expect(await editSharedDate(adapter(pg), partner, edit())).toMatchObject({ ok: true, value: { replay: false,
    date: { id: dateId, version: 2, title: 'Synthetic edited', creatorId: principal.userId, leapDayPolicy: 'mar1' } } });
  const newer = { ...edit(), commandId: id(2803), expectedVersion: 2, title: 'Synthetic newest',
    localDate: '2029-03-01', recurrence: 'once', leapDayPolicy: null };
  expect(await editSharedDate(adapter(pg), principal, newer)).toMatchObject({ ok: true, value: { date: { version: 3 } } });
  for (const result of [await editSharedDate(adapter(pg), partner, edit()), await createSharedDate(adapter(pg), principal, create)])
    expect(result).toMatchObject({ ok: true, value: { replay: true, date: { version: 3, title: newer.title, localDate: newer.localDate, recurrence: 'once', leapDayPolicy: null } } });
  expect(await editSharedDate(adapter(pg), partner, { ...edit(), commandId: id(2804) })).toEqual({ ok: false, error: 'version_conflict' });
  for (const change of [{ title: 'changed' }, { expectedVersion: 2 }, { dateId: id(2999) }, { timezone: 'UTC' },
    { localDate: '2032-02-29' }, { leapDayPolicy: 'feb28' }, { recurrence: 'once', leapDayPolicy: null }])
    expect(await editSharedDate(adapter(pg), partner, { ...edit(), ...change })).toEqual({ ok: false, error: 'idempotency_conflict' });
  expect(await createSharedDate(adapter(pg), partner, { ...create, commandId: edit().commandId })).toEqual({ ok: false, error: 'idempotency_conflict' });
  expect(await editSharedDate(adapter(pg), principal, { ...edit(), commandId: create.commandId })).toEqual({ ok: false, error: 'idempotency_conflict' });
  expect((await pg.query('SELECT * FROM shared_date_commands')).rows).toHaveLength(3);
});
it('rejects malformed edits, foreign resources, expired authority and changed epochs before replay', async () => {
  for (const change of [{ dateId: 'bad' }, { expectedVersion: 0 }, { expectedVersion: 1.5 }, { expectedVersion: 2147483647 },
    { expectedVersion: '1' }, { recurrence: undefined }, { leapDayPolicy: null }, { extra: true }])
    expect(await editSharedDate(adapter(pg), principal, { ...edit(), ...change })).toEqual({ ok: false, error: 'invalid_request' });
  expect(await editSharedDate(adapter(pg), principal, { ...edit(), dateId: id(2999) })).toEqual({ ok: false, error: 'unavailable' });
  for (const actor of [identityPrincipal(outsider), { ...principal, userId: 'bad' }, { ...principal, tokenExpiresAt: 1 }])
    expect(await editSharedDate(adapter(pg), actor, edit())).toEqual({ ok: false, error: 'unavailable' });
  expect(await editSharedDate(adapter(pg), principal, { ...edit(), coupleId: c2 })).toEqual({ ok: false, error: 'unavailable' });
  expect(await editSharedDate(adapter(pg), identityPrincipal(u2), { ...edit(), membershipEpoch: 2 })).toEqual({ ok: false, error: 'stale_membership' });
});
it('PATCH is explicit, strict and returns 200 without claiming a new resource', async () => {
  const handler = createSharedDatesHandler(bindSessionAuthority(adapter(pg), createSyntheticAuthority(async () => principal)));
  const body = { command_id: id(2850), membership_epoch: 1, expected_version: 3, title: 'Synthetic HTTP edit',
    local_date: '2030-01-01', timezone: 'UTC', recurrence: 'annual', leap_day_policy: null };
  const send = (input: unknown = body, suffix = '', method = 'PATCH') => handler(new Request(`http://localhost/v1/couples/${c1}/dates/${dateId}${suffix}`,
    { method, headers: { authorization: 'Bearer fixture', 'content-type': 'application/json', 'idempotency-key': body.command_id }, ...(method === 'GET' ? {} : { body: JSON.stringify(input) }) }));
  expect((await send()).status).toBe(200);
  expect(await (await send()).json()).toMatchObject({ ok: true, value: { replay: true, date: { version: 4 } } });
  expect((await send({ ...body, expected_version: 2 })).status).toBe(409);
  for (const change of [{ expected_version: undefined }, { recurrence: undefined }, { leap_day_policy: undefined }, { date_id: dateId }])
    expect((await send({ ...body, ...change })).status).toBe(400);
  expect((await send(body, '?extra=1')).status).toBe(400);
  for (const method of ['GET', 'POST', 'DELETE']) expect((await send(body, '', method)).status).toBe(405);
});
it('database preserves identity, bounds version changes, validates updates and keeps all receipts immutable', async () => {
  for (const assignment of ["creator_id='" + u2 + "'", "couple_id='" + c2 + "'", 'membership_epoch=2',
    "created_at='2026-01-01Z'", "timezone='Mars/Olympus'", "local_date='2029-02-29'", "recurrence='annual',leap_day_policy='mar1'"])
    await expect(pg.query(`UPDATE shared_dates SET version=version+1,${assignment} WHERE id=$1`, [dateId])).rejects.toMatchObject({ code: '23514' });
  await expect(pg.query('UPDATE shared_dates SET version=version WHERE id=$1', [dateId])).rejects.toMatchObject({ code: '23514' });
  for (const table of ['shared_dates', 'shared_date_commands']) await expect(pg.query(`DELETE FROM ${table}`)).rejects.toMatchObject({ code: '23514' });
  await expect(pg.query('UPDATE shared_date_commands SET expected_version=2')).rejects.toMatchObject({ code: '23514' });
  await pg.query("UPDATE couples SET status='closed' WHERE id=$1", [c1]);
  expect(await editSharedDate(adapter(pg), identityPrincipal(u2), edit())).toEqual({ ok: false, error: 'unavailable' });
});
