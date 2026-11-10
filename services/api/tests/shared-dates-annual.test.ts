import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createSharedDate, listSharedDates } from '../src/shared-dates.ts';
import { createSharedDatesHandler } from '../src/shared-dates-http.ts';
import { bindSessionAuthority } from '../src/auth-authority.ts';
import { createSyntheticAuthority } from '../src/synthetic-authority.ts';
import { adapter, c1, createFixture, id, principal } from './fixtures.ts';
let pg: PGlite;
const scope = { coupleId: c1, membershipEpoch: 1 };
const command = { ...scope, commandId: id(1801), title: 'Synthetic annual date', localDate: '2000-02-29',
  timezone: 'Asia/Tokyo', recurrence: 'annual', leapDayPolicy: 'feb28' };
function db(now = '2027-02-28T00:30:00Z') {
  const source = adapter(pg);
  return bindSessionAuthority({ ...source, now: () => new Date(now) }, { ...source.sessionAuthority, recheck: async () => true });
}
beforeAll(async () => {
  pg = await createFixture();
  for (const file of ['012_shared_dates.sql', '013_annual_shared_dates.sql']) await pg.exec(await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8'));
});
afterAll(async () => { await pg.close(); });
it('requires explicit Feb29 choices and disallows meaningless/unknown policies', async () => {
  for (const change of [{ leapDayPolicy: null }, { leapDayPolicy: undefined }, { leapDayPolicy: 'guess' },
    { recurrence: undefined }, { recurrence: null }, { recurrence: 'weekly' }, { recurrence: 'once' }, { localDate: '2000-03-01' }]) {
    expect(await createSharedDate(db(), principal, { ...command, ...change })).toEqual({ ok: false, error: 'invalid_request' });
  }
  const missing = { ...scope, commandId: command.commandId, title: command.title, localDate: command.localDate, timezone: command.timezone, recurrence: 'annual' };
  expect(await createSharedDate(db(), principal, missing)).toEqual({ ok: false, error: 'invalid_request' });
});
it('binds both recurrence and leap policy; recomputes metadata on unchanged receipt replay', async () => {
  const saved = await createSharedDate(db(), principal, command);
  expect(saved).toMatchObject({ ok: true, value: { date: { recurrence: 'annual', leapDayPolicy: 'feb28', asOfLocalDate: '2027-02-28', nextOccurrence: '2027-02-28' } } });
  for (const change of [{ leapDayPolicy: 'mar1' }, { leapDayPolicy: 'leap_years_only' }, { recurrence: 'once', leapDayPolicy: null }]) {
    expect(await createSharedDate(db(), principal, { ...command, ...change })).toEqual({ ok: false, error: 'idempotency_conflict' });
  }
  expect(await createSharedDate(db('2027-03-01T00:30:00Z'), principal, command)).toMatchObject({ ok: true,
    value: { replay: true, date: { asOfLocalDate: '2027-03-01', nextOccurrence: '2028-02-29' } } });
  expect(await listSharedDates(db('2027-03-01T00:30:00Z'), principal, scope)).toMatchObject({ ok: true,
    value: { dates: [{ nextOccurrence: '2028-02-29' }] } });
});
it('supports each explicit leap policy, century boundaries and exact zoned server dates', async () => {
  let n = 1810;
  for (const [year, policy, next] of [
    ['1900', 'leap_years_only', '1904-02-29'], ['1900', 'feb28', '1900-02-28'], ['1900', 'mar1', '1900-03-01'],
    ['2000', 'leap_years_only', '2000-02-29'], ['2000', 'feb28', '2000-02-29'], ['2000', 'mar1', '2000-02-29'],
    ['2100', 'leap_years_only', '2104-02-29'], ['2100', 'feb28', '2100-02-28'], ['2100', 'mar1', '2100-03-01'],
  ]) {
    expect(await createSharedDate(db(`${year}-02-28T00:30:00Z`), principal,
      { ...command, commandId: id(n++), localDate: '1896-02-29', leapDayPolicy: policy }))
      .toMatchObject({ ok: true, value: { date: { nextOccurrence: next } } });
  }
  for (const [timezone, today] of [['Asia/Tokyo', '2027-02-28'], ['America/Los_Angeles', '2027-02-27']]) {
    expect(await createSharedDate(db(), principal, { ...command, commandId: id(n++), timezone }))
      .toMatchObject({ ok: true, value: { date: { timezone, asOfLocalDate: today } } });
  }
  expect(await createSharedDate(db('9999-12-31T23:30:00Z'), principal, { ...command, commandId: id(n) }))
    .toMatchObject({ ok: true, value: { date: { asOfLocalDate: null, nextOccurrence: null } } });
});
it('keeps legacy once commands equivalent to explicit once/null and rejects client clock hints', async () => {
  const legacy = { ...scope, commandId: id(1850), title: 'Synthetic once', localDate: '2027-02-28', timezone: 'UTC' };
  expect(await createSharedDate(db(), principal, legacy)).toMatchObject({ ok: true, value: { date: {
    recurrence: 'once', leapDayPolicy: null, nextOccurrence: '2027-02-28' } } });
  expect(await createSharedDate(db(), principal, { ...legacy, recurrence: 'once', leapDayPolicy: null })).toMatchObject({ ok: true, value: { replay: true } });
  expect(await createSharedDate(db(), principal, { ...legacy, asOfLocalDate: '2000-01-01' })).toEqual({ ok: false, error: 'invalid_request' });
  expect(await createSharedDate(db('2027-03-01T00:30:00Z'), principal, legacy)).toMatchObject({ ok: true, value: { date: { nextOccurrence: null } } });
});
it('SQL schedule constraints and receipt FK prevent invalid policy and schedule mismatch', async () => {
  for (const [recurrence, policy, localDate] of [['annual', null, '2000-02-29'], ['once', 'feb28', '2000-02-29'],
    ['annual', 'mar1', '2000-03-01'], ['annual', 'unknown', '2000-02-29'], ['weekly', null, '2000-02-29']]) {
    await expect(pg.query(`INSERT INTO shared_dates(couple_id,creator_id,membership_epoch,title,local_date,timezone,created_at,recurrence,leap_day_policy)
      VALUES($1,$2,1,'Synthetic',$3,'UTC','2027-01-01Z',$4,$5)`, [c1, principal.userId, localDate, recurrence, policy])).rejects.toMatchObject({ code: '23514' });
  }
  for (const [recurrence, policy] of [['once', null], ['annual', 'mar1']]) {
    await expect(pg.query(`INSERT INTO shared_date_commands(actor_user_id,command_id,couple_id,membership_epoch,date_id,title,local_date,timezone,recurrence,leap_day_policy)
      SELECT actor_user_id,$1,couple_id,membership_epoch,date_id,title,local_date,timezone,$2,$3 FROM shared_date_commands WHERE command_id=$4`,
    [id(1890), recurrence, policy, command.commandId])).rejects.toMatchObject({ code: '23503' });
  }
});
it('HTTP accepts schedule fields but rejects missing policy and device-derived metadata', async () => {
  const handler = createSharedDatesHandler(bindSessionAuthority(db(), createSyntheticAuthority(async () => principal)));
  const body = { command_id: id(1880), membership_epoch: 1, title: 'Synthetic HTTP annual', local_date: '2000-02-29', timezone: 'UTC', recurrence: 'annual', leap_day_policy: 'mar1' };
  const send = (value: unknown) => handler(new Request(`http://localhost/v1/couples/${c1}/dates`, { method: 'POST',
    headers: { authorization: 'Bearer fixture', 'content-type': 'application/json', 'idempotency-key': body.command_id }, body: JSON.stringify(value) }));
  expect((await send(body)).status).toBe(201);
  expect((await send(body)).status).toBe(200);
  expect((await send({ ...body, leap_day_policy: 'feb28' })).status).toBe(409);
  expect((await send({ ...body, recurrence: 'once', leap_day_policy: null })).status).toBe(409);
  for (const change of [{ leap_day_policy: null }, { leap_day_policy: undefined }, { as_of_local_date: '2000-01-01' }, { recurrence: 'monthly' }]) {
    expect((await send({ ...body, ...change })).status).toBe(400);
  }
});

it('samples server time only after the final authorization recheck, including replay', async () => {
  let now = '2027-02-28T14:59:00Z';
  let checks = 0;
  const source = db();
  const fresh = bindSessionAuthority({ ...source, now: () => new Date(now) }, { ...source.sessionAuthority,
    recheck: async () => { if (++checks === 2) now = '2027-02-28T15:01:00Z'; return true; } });
  expect(await createSharedDate(fresh, principal, command)).toMatchObject({ ok: true, value: { replay: true,
    date: { asOfLocalDate: '2027-03-01', nextOccurrence: '2028-02-29' } } });
  checks = 0; now = '2027-02-28T14:59:00Z';
  const result = await listSharedDates(fresh, principal, scope);
  expect(result.ok).toBe(true);
  if (!result.ok) throw Error('fixture');
  expect(result.value.dates.find(date => date.title === command.title && date.timezone === command.timezone)?.asOfLocalDate).toBe('2027-03-01');
});
