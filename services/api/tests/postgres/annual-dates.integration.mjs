import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { datesFixture, datesHarness } from './shared-dates-fixture.mjs';
import { createFixture } from './fixture.mjs';
import { account } from './profile-fixture.mjs';
import { createSharedDate, listSharedDates } from '../../src/shared-dates.ts';

const scope = x => ({ coupleId: x.pairA, membershipEpoch: 1 });
const command = (x, extra = {}) => ({ ...scope(x), commandId: randomUUID(), title: 'Synthetic annual date',
  localDate: '1896-02-29', timezone: 'UTC', recurrence: 'annual', leapDayPolicy: 'leap_years_only', ...extra });
const fixed = (db, instant) => ({ ...db, now: () => new Date(instant) });
const value = async response => (await response.json()).value;

// The pure calendar result is independently asserted against literal Gregorian expectations.
// Session/provider verification still uses real PostgreSQL clocks, never the fixture's calendar clock.
test('annual dates PostgreSQL: three explicit Feb29 policies at Gregorian 1900/2000/2100 boundaries', async () => {
  const x = await datesFixture();
  try {
    const db = x.f.database(), actor = await x.principal(0);
    for (const [asOf, expected] of [
      ['1900-02-28', ['1904-02-29', '1900-02-28', '1900-03-01']],
      ['1900-03-01', ['1904-02-29', '1901-02-28', '1900-03-01']],
      ['2000-02-28', ['2000-02-29', '2000-02-29', '2000-02-29']],
      ['2000-02-29', ['2000-02-29', '2000-02-29', '2000-02-29']],
      ['2000-03-01', ['2004-02-29', '2001-02-28', '2001-03-01']],
      ['2100-02-28', ['2104-02-29', '2100-02-28', '2100-03-01']],
      ['2100-03-01', ['2104-02-29', '2101-02-28', '2100-03-01']],
    ]) {
      for (const [i, policy] of ['leap_years_only', 'feb28', 'mar1'].entries()) {
        const result = await createSharedDate(fixed(db, `${asOf}T12:00:00.000Z`), actor, command(x, { leapDayPolicy: policy }));
        assert.equal(result.ok, true); const date = result.value.date;
        assert.equal(date.asOfLocalDate, asOf); assert.equal(date.nextOccurrence, expected[i]);
        assert.equal(date.localDate, '1896-02-29'); assert.equal(date.recurrence, 'annual'); assert.equal(date.leapDayPolicy, policy);
      }
    }
  } finally { await x.f.close(); }
});

test('annual dates PostgreSQL: inclusive same day, future anchor, December rollover and honest upper bounds', async () => {
  const x = await datesFixture();
  try {
    const db = x.f.database(), actor = await x.principal(0);
    for (const [localDate, recurrence, leapDayPolicy, asOf, expected] of [
      ['2020-12-31', 'annual', null, '2026-12-31', '2026-12-31'],
      ['2020-12-31', 'annual', null, '2027-01-01', '2027-12-31'],
      ['2032-02-29', 'annual', 'feb28', '2030-01-01', '2032-02-29'],
      ['2032-12-31', 'annual', null, '2026-01-01', '2032-12-31'],
      ['2026-11-10', 'once', null, '2026-11-10', '2026-11-10'],
      ['2026-11-10', 'once', null, '2026-11-11', null],
      ['9996-02-29', 'annual', 'leap_years_only', '9997-01-01', null],
      ['9996-02-29', 'annual', 'feb28', '9999-02-28', '9999-02-28'],
      ['9996-02-29', 'annual', 'mar1', '9999-03-02', null],
      ['0001-01-01', 'annual', null, '9999-12-31', null],
      ['9999-12-31', 'annual', null, '9999-12-31', '9999-12-31'],
    ]) {
      const result = await createSharedDate(fixed(db, `${asOf}T12:00:00.000Z`), actor,
        command(x, { localDate, recurrence, leapDayPolicy }));
      assert.equal(result.ok, true); assert.equal(result.value.date.nextOccurrence, expected);
    }
    const ordinary = await createSharedDate(db, actor, command(x)); assert.equal(ordinary.ok, true);
    const outside = await listSharedDates(fixed(db, '+010000-01-01T12:00:00.000Z'), actor, scope(x));
    assert.equal(outside.ok, true);
    for (const date of outside.value.dates) { assert.equal(date.asOfLocalDate, null); assert.equal(date.nextOccurrence, null); }
  } finally { await x.f.close(); }
});

test('annual dates PostgreSQL: exact zoned server today, DST calendar labels and fresh replay/list metadata', async () => {
  const x = await datesFixture();
  try {
    const db = x.f.database(), actor = await x.principal(0), partner = await x.principal(1);
    for (const [zone, asOf, next] of [['Asia/Tokyo', '2026-01-01', '2026-01-01'], ['America/Los_Angeles', '2025-12-31', '2026-01-01']]) {
      const original = command(x, { localDate: '2020-01-01', leapDayPolicy: null, timezone: zone });
      const created = await createSharedDate(fixed(db, '2026-01-01T00:30:00.000Z'), actor, original);
      assert.equal(created.ok, true); assert.equal(created.value.date.asOfLocalDate, asOf); assert.equal(created.value.date.nextOccurrence, next);
      const replay = await createSharedDate(fixed(db, '2026-01-02T12:00:00.000Z'), actor, original);
      assert.equal(replay.ok, true); assert.equal(replay.value.replay, true); assert.equal(replay.value.date.id, created.value.date.id);
      assert.equal(replay.value.date.createdAt, created.value.date.createdAt); assert.equal(replay.value.date.nextOccurrence, '2027-01-01');
      assert.equal(replay.value.date.asOfLocalDate, '2026-01-02'); assert.equal(replay.value.date.timezone, zone);
    }
    for (const day of ['2026-03-08', '2026-11-01']) {
      const result = await createSharedDate(fixed(db, `${day}T12:00:00.000Z`), actor,
        command(x, { localDate: day, leapDayPolicy: null, timezone: 'America/Los_Angeles' }));
      assert.equal(result.ok, true); assert.equal(result.value.date.nextOccurrence, day); assert.equal(result.value.date.asOfLocalDate, day);
    }
    const listing = await listSharedDates(fixed(db, '2027-01-01T00:30:00.000Z'), partner, scope(x));
    assert.equal(listing.ok, true);
    for (const date of listing.value.dates) assert.equal(date.asOfLocalDate, date.timezone === 'Asia/Tokyo' ? '2027-01-01' : '2026-12-31');
    // Client-supplied clocks are not an accepted input on either wire command.
    assert.equal((await x.create(0, 'Synthetic spoof', randomUUID(), x.pairA, 1, { as_of_local_date: '1900-01-01' })).status, 400);
    assert.equal((await x.raw(0, `${x.path()}?membership_epoch=1&today=1900-01-01`)).status, 400);
  } finally { await x.f.close(); }
});

test('annual dates PostgreSQL: explicit policy validation and unknown ACK preserve complete immutable schedule', async () => {
  const x = await datesFixture(); let server;
  try {
    for (const extra of [{ recurrence: 'annual' }, { recurrence: 'annual', leap_day_policy: null },
      { recurrence: 'annual', leap_day_policy: 'nearest' }, { recurrence: 'once', leap_day_policy: 'feb28' },
      { recurrence: 'annual', leap_day_policy: 'feb28', local_date: '2028-03-01' }, { recurrence: 'weekly', leap_day_policy: null }]) {
      assert.equal((await x.create(0, 'Synthetic invalid policy', randomUUID(), x.pairA, 1, extra)).status, 400);
    }
    server = await datesHarness(x.f); const cookie = await x.connections[0].getCookie();
    const body = { command_id: randomUUID(), membership_epoch: 1, title: 'Synthetic annual unknown ACK',
      local_date: '2028-02-29', timezone: 'US/Pacific', recurrence: 'annual', leap_day_policy: 'feb28' };
    await assert.rejects(server.request(cookie, x.path(), body), /fetch failed/);
    const replay = await server.request(cookie, x.path(), body); assert.equal(replay.status, 200);
    const saved = await value(replay); assert.equal(saved.replay, true); assert.equal(saved.date.leapDayPolicy, 'feb28');
    for (const changed of [{ leap_day_policy: 'mar1' }, { recurrence: 'once', leap_day_policy: null },
      { timezone: 'America/Los_Angeles' }]) {
      assert.equal((await x.post(0, x.path(), { ...body, ...changed })).status, 409);
    }
    const legacy = await value(await x.create(0)); assert.equal(legacy.date.recurrence, 'once'); assert.equal(legacy.date.leapDayPolicy, null);
    assert.equal((await x.f.domainPool.query('SELECT count(*)::int n FROM outbox_events')).rows[0].n, 0);
  } finally { await server?.close(); await x.f.close(); }
});

test('annual dates PostgreSQL: direct SQL constrains policy and binds nullable schedule into receipt identity', async () => {
  const x = await datesFixture();
  try {
    const sql = `INSERT INTO shared_dates(couple_id,creator_id,membership_epoch,title,local_date,timezone,created_at,recurrence,leap_day_policy)
      VALUES($1,$2,1,'Synthetic SQL','2028-02-29','UTC',clock_timestamp()::timestamptz(3),$3,$4)`;
    for (const fields of [['annual', null], ['annual', 'nearest'], ['once', 'feb28'], ['weekly', null]]) {
      await assert.rejects(x.f.domainPool.query(sql, [x.pairA, x.usersA[0], ...fields]), { code: '23514' });
    }
    const saved = await value(await x.create(0, 'Synthetic receipt', randomUUID(), x.pairA, 1,
      { timezone: 'UTC', recurrence: 'annual', leap_day_policy: 'feb28' }));
    const receipt = `INSERT INTO shared_date_commands(actor_user_id,command_id,couple_id,membership_epoch,date_id,title,local_date,timezone,recurrence,leap_day_policy)
      VALUES($1,$2,$3,1,$4,'Synthetic receipt','2028-02-29','UTC',$5,$6)`;
    for (const [recurrence, policy] of [['once', null], ['annual', 'mar1']]) {
      await assert.rejects(x.f.domainPool.query(receipt, [x.usersA[0], randomUUID(), x.pairA, saved.date.id, recurrence, policy]), { code: '23503' });
    }
    for (const table of ['shared_dates', 'shared_date_commands']) {
      await assert.rejects(x.f.domainPool.query(`UPDATE ${table} SET leap_day_policy='mar1'`), { code: '23514' });
    }
  } finally { await x.f.close(); }
});

// Apply 013 to actual pre-013 retained rows and receipts, rather than only an empty schema.
test('annual dates PostgreSQL: additive migration preserves legacy rows, receipts and immutable replay', async () => {
  const f = await createFixture({ skipAnnualDatesMigration: true });
  try {
    const pair = randomUUID(), identities = [await account(f, 0), await account(f, 1)];
    const users = await f.provision(identities.map(identity => identity.user.id), pair);
    const inserted = await f.domainPool.query(`INSERT INTO shared_dates(couple_id,creator_id,membership_epoch,title,local_date,timezone,created_at)
      VALUES($1,$2,1,'Synthetic legacy','2028-02-29','UTC','2026-11-10T00:00:00.000Z') RETURNING id`, [pair, users[0]]);
    const id = inserted.rows[0].id, commandId = randomUUID();
    await f.domainPool.query(`INSERT INTO shared_date_commands(actor_user_id,command_id,couple_id,membership_epoch,date_id,title,local_date,timezone)
      VALUES($1,$2,$3,1,$4,'Synthetic legacy','2028-02-29','UTC')`, [users[0], commandId, pair, id]);
    await f.domainPool.query(await readFile(new URL('../../migrations/013_annual_shared_dates.sql', import.meta.url), 'utf8'));
    for (const table of ['shared_dates', 'shared_date_commands']) {
      const rows = (await f.domainPool.query(`SELECT recurrence,leap_day_policy FROM ${table}`)).rows;
      assert.deepEqual(rows, [{ recurrence: 'once', leap_day_policy: null }]);
      await assert.rejects(f.domainPool.query(`UPDATE ${table} SET recurrence='annual'`), { code: '23514' });
    }
    assert.equal((await f.domainPool.query('SELECT date_id FROM shared_date_commands WHERE command_id=$1', [commandId])).rows[0].date_id, id);
    const session = (await f.domainPool.query('SELECT id,"expiresAt" FROM "session" WHERE "userId"=$1', [identities[0].user.id])).rows[0];
    const principal = { source: 'better-auth', userId: users[0], authUserId: identities[0].user.id,
      sessionId: session.id, tokenExpiresAt: Math.floor(session.expiresAt.getTime() / 1000) };
    const replay = await createSharedDate(f.database(), principal, { coupleId: pair, membershipEpoch: 1,
      commandId, title: 'Synthetic legacy', localDate: '2028-02-29', timezone: 'UTC' });
    assert.equal(replay.ok, true); assert.equal(replay.value.replay, true); assert.equal(replay.value.date.id, id);
    assert.equal(replay.value.date.recurrence, 'once'); assert.equal(replay.value.date.leapDayPolicy, null);
    assert.equal(replay.value.date.createdAt, '2026-11-10T00:00:00.000Z');

  } finally { await f.close(); }
});
