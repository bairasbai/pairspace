import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { lettersFixture, pauseAfterMembers } from './letters-fixture.mjs';
import { sendLetter, listLetters, openLetter } from '../../src/letters.ts';

const unavailable = { ok: false, error: 'unavailable' };
const invalid = { ok: false, error: 'invalid_request' };
const day = 86400000;
const iso = time => new Date(time).toISOString();

test('real PostgreSQL scheduled letters: exact trusted boundary, SQL privacy, immutable schedule, current scopes', async () => {
  const { f, pairA, pairB, principal } = await lettersFixture();
  try {
    let time = Date.now(); const initial = time; const releaseAt = iso(time + 120000);
    const queries = []; const base = f.database();
    const db = { ...base, now: () => new Date(time), transaction: work => base.transaction(tx => work({
      async query(sql, params) { const result = await tx.query(sql, params);
        if (sql.includes('FROM letters')) queries.push({ sql, rows: result.rows }); return result; },
    })) };
    const sender = await principal(0); const receiver = await principal(1); const foreign = await principal(2);
    const scope = { coupleId: pairA, membershipEpoch: 1 };
    const command = { ...scope, clientId: randomUUID(), body: 'Synthetic sealed boundary body', releaseAt, releaseTimezone: 'UTC' };
    const sent = await sendLetter(db, sender, command); assert.equal(sent.ok, true);
    assert.equal(sent.value.letter.availability, 'sealed');
    const openScope = { ...scope, letterId: sent.value.letter.id };
    queries.length = 0;
    const list = await listLetters(db, receiver, scope);
    assert.equal(list.value.letters[0].releaseAt, releaseAt); assert.equal(list.value.letters[0].availability, 'sealed');
    assert.equal(JSON.stringify(list).includes(command.body), false);
    assert.equal(queries.every(q => q.rows.every(r => !Object.hasOwn(r, 'body'))), true);
    time = Date.parse(releaseAt) - 1;
    queries.length = 0;
    assert.deepEqual(await openLetter(db, receiver, openScope), unavailable);
    assert.equal(queries.every(q => q.rows.every(r => !Object.hasOwn(r, 'body'))), true, 'early SQL never retrieves content');
    assert.equal(queries.some(q => /release_at/.test(q.sql)), true);
    for (const who of [sender, foreign]) assert.deepEqual(await openLetter(db, who, openScope), unavailable);
    assert.deepEqual(await openLetter(db, receiver, { ...openScope, coupleId: pairB }), unavailable);
    assert.deepEqual(await openLetter(db, receiver, { ...openScope, membershipEpoch: 2 }), { ok: false, error: 'stale_membership' });
    assert.equal((await sendLetter(db, sender, command)).value.replay, true, 'retry does not fail elapsed minimum');
    assert.deepEqual(await sendLetter(db, sender, { ...command, releaseAt: iso(initial + 180000) }), { ok: false, error: 'idempotency_conflict' });
    assert.deepEqual(await sendLetter(db, sender, { ...command, releaseTimezone: 'Etc/GMT' }), { ok: false, error: 'idempotency_conflict' });
    assert.deepEqual(await sendLetter(db, sender, { ...scope, clientId: command.clientId, body: command.body }), { ok: false, error: 'idempotency_conflict' });
    time++;
    assert.equal((await listLetters(db, receiver, scope)).value.letters[0].availability, 'available');
    const opened = await openLetter(db, receiver, openScope); assert.equal(opened.value.letter.body, command.body);
    assert.equal(opened.value.letter.availability, 'available');
    // Recheck isolation after release so the seal cannot mask a broken authorization gate.
    for (const who of [sender, foreign]) assert.deepEqual(await openLetter(db, who, openScope), unavailable);
    assert.deepEqual(await openLetter(db, receiver, { ...openScope, coupleId: pairB }), unavailable);
    assert.deepEqual(await openLetter(db, receiver, { ...openScope, membershipEpoch: 2 }), { ok: false, error: 'stale_membership' });
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM outbox_events')).rows[0].n, 0);
    assert.equal((await f.domainPool.query('SELECT release_at::text FROM letters')).rows.length, 1);
    await f.domainPool.query('DELETE FROM "session" WHERE id=$1', [receiver.sessionId]);
    assert.deepEqual(await openLetter(db, receiver, openScope), unavailable);
  } finally { await f.close(); }
});

test('real PostgreSQL scheduled letters: strict window boundaries and fresh clock after membership lock', async () => {
  const { f, pairA, principal } = await lettersFixture();
  const locks = [];
  try {
    let time = Date.now(); const db = { ...f.database(), now: () => new Date(time) };
    const p = await principal(0); const receiver = await principal(1);
    const scope = { coupleId: pairA, membershipEpoch: 1 };
    const command = delta => ({ ...scope, clientId: randomUUID(), body: 'Synthetic window', releaseAt: iso(time + delta), releaseTimezone: 'UTC' });
    for (const delta of [59999, 366 * day + 1, -1]) assert.deepEqual(await sendLetter(db, p, command(delta)), invalid);
    for (const delta of [60000, 366 * day]) assert.equal((await sendLetter(db, p, command(delta))).ok, true);
    const delayed = command(60000); const locked = pauseAfterMembers(db); locks.push(locked);
    const sending = sendLetter(locked.db, p, delayed); await locked.entered; time += 1; locked.release();
    assert.deepEqual(await sending, invalid, 'minimum is checked using clock after lock wait');
    const release = command(120000); const sent = await sendLetter(db, p, release);
    const openingLock = pauseAfterMembers(db); locks.push(openingLock);
    const opening = openLetter(openingLock.db, receiver, { ...scope, letterId: sent.value.letter.id });
    await openingLock.entered; time = Date.parse(release.releaseAt); openingLock.release();
    assert.equal((await opening).value.letter.body, release.body, 'clock sampled after wait permits exact boundary');
  } finally { for (const lock of locks) lock.release(); await f.close(); }
});

test('real PostgreSQL scheduled HTTP rejects malformed schedules, spoofed clock and DST gaps', async () => {
  const { f, send, list, open, raw, path } = await lettersFixture();
  try {
    const when = iso(Date.now() + 120000); const marker = 'Synthetic secret must not leak';
    for (const extra of [
      { release_at: when }, { release_timezone: 'UTC' }, { release_at: null, release_timezone: null },
      { release_at: '2027-02-30T10:00:00Z', release_timezone: 'UTC' },
      { release_at: '2027-03-14T02:30:00-05:00', release_timezone: 'America/New_York' },
      { release_at: when, release_timezone: 'Not/AZone' },
      { release_at: when, release_timezone: 'UTC', server_now: '2099-01-01T00:00:00Z' },
    ]) {
      const response = await send(0, randomUUID(), marker, undefined, 1, extra);
      assert.equal(response.status, 400); assert.equal((await response.text()).includes(marker), false);
    }
    const response = await send(0, randomUUID(), marker, undefined, 1, { release_at: when, release_timezone: 'UTC' });
    assert.equal(response.status, 201); const id = (await response.json()).value.letter.id;
    const early = await raw(1, `${path()}/${id}?membership_epoch=1`, { headers: { date: 'Thu, 01 Jan 2099 00:00:00 GMT', 'x-client-time': '4070908800000' } });
    assert.equal(early.status, 403); assert.deepEqual(await early.json(), unavailable);
    const meta = await list(1); assert.equal(meta.headers.get('cache-control'), 'no-store');
    assert.equal((await meta.text()).includes(marker), false);
    assert.deepEqual(await (await open(1, randomUUID())).json(), await (await open(1, id)).json());
  } finally { await f.close(); }
});

test('real PostgreSQL schedules: explicit DST fold offsets distinguish instants; gap and false offset rejected', async () => {
  const { f, pairA, principal } = await lettersFixture();
  try {
    const db = { ...f.database(), now: () => new Date('2030-11-01T00:00:00Z') };
    const p = await principal(0); const scope = { coupleId: pairA, membershipEpoch: 1 };
    const command = releaseAt => ({ ...scope, clientId: randomUUID(), body: 'Synthetic DST', releaseAt, releaseTimezone: 'America/New_York' });
    const first = await sendLetter(db, p, command('2030-11-03T01:30:00-04:00'));
    const second = await sendLetter(db, p, command('2030-11-03T01:30:00-05:00'));
    assert.equal(first.ok, true); assert.equal(second.ok, true);
    assert.equal(Date.parse(second.value.letter.releaseAt) - Date.parse(first.value.letter.releaseAt), 3600000);
    assert.deepEqual(await sendLetter(db, p, command('2030-11-03T01:30:00-06:00')), invalid);
    assert.deepEqual(await sendLetter(db, p, command('2031-03-09T02:30:00-05:00')), invalid);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM letters')).rows[0].n, 2);
  } finally { await f.close(); }
});

test('real PostgreSQL forward migration leaves pre-existing rows immediate and enforces paired schedule metadata', async () => {
  const { f } = await lettersFixture(); const connection = await f.domainPool.connect();
  try {
    await connection.query('BEGIN');
    // A transaction-local temporary pre-007 table shadows only this connection's real fixture table.
    await connection.query('CREATE TEMP TABLE letters(id uuid PRIMARY KEY,body text,created_at timestamptz NOT NULL) ON COMMIT DROP');
    const id = randomUUID(); await connection.query("INSERT INTO letters VALUES($1,'Synthetic pre-migration',clock_timestamp())", [id]);
    await connection.query(await readFile(new URL('../../migrations/007_scheduled_letters.sql', import.meta.url), 'utf8'));
    const row = (await connection.query('SELECT * FROM letters WHERE id=$1', [id])).rows[0];
    assert.equal(row.release_at, null); assert.equal(row.release_timezone, null); assert.equal(row.body, 'Synthetic pre-migration');
    await connection.query('SAVEPOINT invalid_schedule');
    await assert.rejects(connection.query("UPDATE letters SET release_at=created_at+interval '1 day' WHERE id=$1", [id]), { code: '23514' });
    await connection.query('ROLLBACK TO SAVEPOINT invalid_schedule');
    await assert.rejects(connection.query("UPDATE letters SET release_at=created_at,release_timezone='UTC' WHERE id=$1", [id]), { code: '23514' });
    await connection.query('ROLLBACK');
  } finally { await connection.query('ROLLBACK'); connection.release(); await f.close(); }
});
