import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { datesFixture, datesHarness } from './shared-dates-fixture.mjs';

const value = async response => (await response.json()).value;

test('shared dates PostgreSQL: both partners explicitly create; Tokyo/Los Angeles preserve local calendar day; isolated pairs', async () => {
  const x = await datesFixture();
  try {
    for (const [index, zone] of [[0, 'Asia/Tokyo'], [1, 'America/Los_Angeles']]) {
      const response = await x.create(index, ' Synthetic e\u0301 ', randomUUID(), x.pairA, 1, { timezone: zone });
      assert.equal(response.status, 201); const date = (await value(response)).date;
      assert.equal(date.title, 'Synthetic é'); assert.equal(date.localDate, '2028-02-29'); assert.equal(date.timezone, zone);
      assert.equal(date.creatorId, x.usersA[index]);
      assert.deepEqual(Object.keys(date).sort(), ['asOfLocalDate', 'coupleId', 'createdAt', 'creatorId', 'id', 'leapDayPolicy', 'localDate', 'membershipEpoch', 'nextOccurrence', 'recurrence', 'timezone', 'title']);
    }
    const a = await value(await x.list(0)); assert.equal(a.dates.length, 2); assert.equal(a.limit, 50);
    assert.deepEqual(await value(await x.list(1)), a);
    assert.equal((await x.list(null)).status, 401);
    for (const index of [2, 3]) {
      assert.equal((await x.list(index)).status, 403); assert.equal((await x.create(index)).status, 403);
    }
    assert.deepEqual((await value(await x.list(2, x.pairB))).dates, []);
    assert.equal((await x.list(0, x.pairA, 2)).status, 409);
    assert.equal((await x.f.domainPool.query('SELECT count(*)::int n FROM outbox_events')).rows[0].n, 0);
  } finally { await x.f.close(); }
});

test('shared dates PostgreSQL: strict calendar and IANA validation, aliases preserve exact identity, DST dates do not become instants', async () => {
  const x = await datesFixture();
  try {
    for (const day of ['0000-01-01', '10000-01-01', '2027-02-29', '1900-02-29', '2028-13-01', '2028-04-31', '2028-00-01', '2028-01-00', '2028-2-09', '2028-02-29T00:00:00Z']) {
      assert.equal((await x.create(0, 'Synthetic invalid', randomUUID(), x.pairA, 1, { local_date: day })).status, 400, day);
    }
    for (const timezone of ['Invalid/Nowhere', '+09:00', '', ' Asia/Tokyo ', 'asia/tokyo']) {
      assert.equal((await x.create(0, 'Synthetic invalid', randomUUID(), x.pairA, 1, { timezone })).status, 400, timezone);
    }
    for (const day of ['0001-01-01', '9999-12-31', '2000-02-29', '2026-03-08', '2026-11-01']) {
      const result = await value(await x.create(0, 'Synthetic valid', randomUUID(), x.pairA, 1,
        { local_date: day, timezone: 'America/Los_Angeles' }));
      assert.equal(result.date.localDate, day);
    }
    const id = randomUUID(); const first = await value(await x.create(0, 'Alias', id, x.pairA, 1, { timezone: 'US/Pacific' }));
    assert.equal(first.date.timezone, 'US/Pacific');
    assert.equal((await x.create(0, 'Alias', id, x.pairA, 1, { timezone: 'America/Los_Angeles' })).status, 409);
    const replay = await value(await x.create(0, 'Alias', id, x.pairA, 1, { timezone: 'US/Pacific' }));
    assert.equal(replay.replay, true); assert.deepEqual(replay.date, first.date);
  } finally { await x.f.close(); }
});

test('shared dates PostgreSQL: lost committed ACK and concurrent retries preserve immutable body-bound command', async () => {
  const x = await datesFixture(); let server;
  try {
    server = await datesHarness(x.f); const cookie = await x.connections[0].getCookie();
    const body = { command_id: randomUUID(), membership_epoch: 1, title: 'Synthetic unknown ACK', local_date: '2028-02-29', timezone: 'Asia/Tokyo' };
    await assert.rejects(server.request(cookie, x.path(), body), /fetch failed/);
    const response = await server.request(cookie, x.path(), body); assert.equal(response.status, 200);
    const replay = await value(response); assert.equal(replay.replay, true);
    for (const extra of [{ title: 'Changed' }, { local_date: '2028-03-01' }, { timezone: 'America/Los_Angeles' }]) {
      assert.equal((await x.post(0, x.path(), { ...body, ...extra })).status, 409);
    }
    const id = randomUUID(); const results = await Promise.all(Array.from({ length: 8 }, () => x.create(0, 'Synthetic race', id)));
    assert.equal(results.filter(r => r.status === 201).length, 1); assert.equal(results.filter(r => r.status === 200).length, 7);
    assert.equal(new Set((await Promise.all(results.map(value))).map(r => r.date.id)).size, 1);
    const conflictId = randomUUID();
    const conflict = await Promise.all([x.create(0, 'A', conflictId), x.create(0, 'B', conflictId)]);
    assert.deepEqual(conflict.map(r => r.status).sort(), [201, 409]);
    assert.equal((await x.f.domainPool.query('SELECT count(*)::int n FROM shared_dates')).rows[0].n, 3);
    await assert.rejects(x.f.domainPool.query('UPDATE shared_dates SET title=$1 WHERE id=$2', ['Changed', replay.date.id]));
    await assert.rejects(x.f.domainPool.query('DELETE FROM shared_dates WHERE id=$1', [replay.date.id]));
  } finally { await server?.close(); await x.f.close(); }
});

test('shared dates PostgreSQL: latest fifty creation window, not upcoming or complete archive; epoch filtering', async () => {
  const x = await datesFixture();
  try {
    for (let n = 0; n < 53; n++) assert.equal((await x.create(n % 2, `Synthetic ${n}`)).status, 201);
    const result = await value(await x.list(0)); assert.equal(result.limit, 50); assert.equal(result.dates.length, 50);
    const expected = (await x.f.domainPool.query('SELECT id FROM shared_dates WHERE couple_id=$1 ORDER BY created_at DESC,id DESC LIMIT 50', [x.pairA])).rows;
    assert.deepEqual(result.dates.map(d => d.id), expected.map(d => d.id));
    await x.f.domainPool.query('UPDATE couples SET membership_epoch=2 WHERE id=$1', [x.pairA]);
    assert.equal((await x.list(0)).status, 409);
    assert.deepEqual((await value(await x.list(1, x.pairA, 2))).dates, []);
  } finally { await x.f.close(); }
});

test('shared dates PostgreSQL: direct SQL enforces calendar, zone, millisecond time, receipt identity and immutability', async () => {
  const x = await datesFixture();
  try {
    const result = await value(await x.create(0)); const date = result.date;
    const sql = `INSERT INTO shared_dates(couple_id,creator_id,membership_epoch,title,local_date,timezone,created_at)
      VALUES($1,$2,1,'Synthetic SQL',$3,$4,$5)`;
    for (const [day, zone, instant] of [['2027-02-29', 'UTC', '2026-11-10T00:00:00.000Z'],
      ['0000-01-01', 'UTC', '2026-11-10T00:00:00.000Z'], ['2028-01-01', 'Invalid/Zone', '2026-11-10T00:00:00.000Z'],
      ['2028-01-01', 'UTC', '2026-11-10T00:00:00.000001Z']]) {
      await assert.rejects(x.f.domainPool.query(sql, [x.pairA, x.usersA[0], day, zone, instant]), { code: '23514' });
    }
    await assert.rejects(x.f.domainPool.query('UPDATE shared_date_commands SET title=$1 WHERE command_id=$2', ['Tampered', result.commandId]), { code: '23514' });
    await assert.rejects(x.f.domainPool.query('DELETE FROM shared_date_commands WHERE command_id=$1', [result.commandId]), { code: '23514' });
    await assert.rejects(x.f.domainPool.query(`INSERT INTO shared_date_commands(actor_user_id,command_id,couple_id,membership_epoch,date_id,title,local_date,timezone)
      VALUES($1,$2,$3,1,$4,'Incorrect body','2028-02-29','Asia/Tokyo')`, [x.usersA[0], randomUUID(), x.pairA, date.id]), { code: '23503' });
    assert.equal((await x.f.domainPool.query('SELECT count(*)::int n FROM shared_dates')).rows[0].n, 1);
  } finally { await x.f.close(); }
});
