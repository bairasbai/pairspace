import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { songsFixture } from './shared-songs-fixture.mjs';
import { createSharedSong, listSharedSongs } from '../../src/shared-songs.ts';
import { leaveHarness, assertClosed, pairAgain } from './pair-leave-fixture.mjs';
import { observedDatabase } from './invitation-fixture.mjs';
import { gate, waitForQueryLock } from './profile-fixture.mjs';
import { observeTask, barrierOrCompletion, settleBounded } from './async-bounds.mjs';

const scope = x => ({ coupleId: x.pairA, membershipEpoch: 1 });
const createCommand = x => ({ ...scope(x), commandId: randomUUID(), title: 'Synthetic race song', explanation: 'Synthetic explanation' });
const leaveCommand = x => ({ ...scope(x), commandId: randomUUID(), confirm: true });

for (const firstOperation of ['leave', 'create', 'list']) {
  test(`shared songs PostgreSQL: ${firstOperation} first serializes with leave and denies closed resources`, async () => {
    const x = await songsFixture(); const barrier = gate(); const pending = []; let server; let held = false;
    try {
      const db = x.f.database(); const principal = await x.principal(0); const partner = await x.principal(1);
      const original = await createSharedSong(db, principal, createCommand(x)); assert.equal(original.ok, true);
      const createOnly = createCommand(x);
      const observer = async sql => {
        if (!held && sql.includes('FROM couples') && /FOR (UPDATE|SHARE)/.test(sql)) { held = true; await barrier.hook(); }
      };
      const traced = { ...db, transaction: work => db.transaction(tx => work({ query: async (sql, params) => {
        const result = await tx.query(sql, params); await observer(sql); return result;
      } })) };
      server = await leaveHarness(x.f, { db: firstOperation === 'leave' ? observedDatabase(x.f, observer) : undefined });
      const cookie = await x.connections[0].getCookie();
      const first = observeTask(firstOperation === 'leave' ? server.request(cookie, leaveCommand(x))
        : firstOperation === 'create' ? createSharedSong(traced, partner, createOnly)
          : listSharedSongs(traced, partner, scope(x)));
      pending.push(first); await barrierOrCompletion(barrier.ready, first);
      const second = observeTask(firstOperation === 'leave' ? createSharedSong(db, partner, createOnly)
        : server.request(cookie, leaveCommand(x))); pending.push(second);
      await waitForQueryLock(x.f, '%FROM users%FOR %'); barrier.release();
      const [a, b] = await Promise.all(pending);
      assert.equal(firstOperation === 'leave' ? a.status : b.status, 200);
      assert.equal(firstOperation === 'leave' ? b.ok : a.ok, firstOperation !== 'leave');
      await assertClosed(x.f, x.pairA);
      assert.deepEqual(await createSharedSong(db, principal, createOnly), { ok: false, error: 'unavailable' });
      assert.deepEqual(await listSharedSongs(db, partner, scope(x)), { ok: false, error: 'unavailable' });
    } finally { barrier.release(); await settleBounded(pending); await server?.close(); await x.f.close(); }
  });
}

test('shared songs PostgreSQL: create, exact replay and list recheck expired session after pair lock wait', async () => {
  const x = await songsFixture(); let held; const pending = [];
  try {
    const db = x.f.database(); const principal = await x.principal(0); const partner = await x.principal(1);
    const command = createCommand(x); const created = await createSharedSong(db, principal, command); assert.equal(created.ok, true);
    await x.f.domainPool.query('UPDATE "session" SET "expiresAt"=clock_timestamp()+interval \'1 second\' WHERE id=ANY($1)', [[principal.sessionId, partner.sessionId]]);
    held = await x.f.domainPool.connect(); await held.query('BEGIN');
    await held.query('SELECT id FROM couples WHERE id=$1 FOR UPDATE', [x.pairA]);
    pending.push(observeTask(createSharedSong(db, principal, command)),
      observeTask(createSharedSong(db, principal, createCommand(x))),
      observeTask(listSharedSongs(db, partner, scope(x))));
    await waitForQueryLock(x.f, '%FROM couples%FOR %');
    await new Promise(resolve => setTimeout(resolve, 1200));
    await held.query('COMMIT'); held.release(); held = null;
    for (const result of await Promise.all(pending)) assert.deepEqual(result, { ok: false, error: 'unavailable' });
    assert.equal((await x.f.domainPool.query('SELECT count(*)::int AS n FROM shared_songs')).rows[0].n, 1);
  } finally { if (held) { await held.query('ROLLBACK'); held.release(); } await settleBounded(pending); await x.f.close(); }
});

test('shared songs PostgreSQL: old command cannot cross to a new pair; old resource remains isolated', async () => {
  const x = await songsFixture();
  try {
    const db = x.f.database(); const principal = await x.principal(0); const partner = await x.principal(1);
    const command = createCommand(x); const created = await createSharedSong(db, principal, command); assert.equal(created.ok, true);
    assert.equal((await x.leave(1)).status, 200);
    const pair = await pairAgain(x.f, x.usersA);
    assert.deepEqual(await createSharedSong(db, principal, command), { ok: false, error: 'unavailable' });
    assert.deepEqual(await listSharedSongs(db, principal, scope(x)), { ok: false, error: 'unavailable' });
    assert.deepEqual(await createSharedSong(db, principal, { ...command, coupleId: pair }), { ok: false, error: 'idempotency_conflict' });
    const newScope = { coupleId: pair, membershipEpoch: 1 };
    assert.deepEqual((await listSharedSongs(db, partner, newScope)).value.songs, []);
    const fresh = await createSharedSong(db, partner, { ...command, ...newScope, commandId: randomUUID() }); assert.equal(fresh.ok, true);
    assert.equal((await x.f.domainPool.query('SELECT count(*)::int AS n FROM shared_songs')).rows[0].n, 2);
  } finally { await x.f.close(); }
});

test('shared songs PostgreSQL: database rejects one-member active pair; service rejects uncommitted inconsistent membership', async () => {
  const x = await songsFixture(); let held;
  try {
    const db = x.f.database(); const principal = await x.principal(0); const partner = await x.principal(1);
    const command = createCommand(x); const created = await createSharedSong(db, principal, command); assert.equal(created.ok, true);
    const revoke = "UPDATE couple_members SET status='revoked' WHERE couple_id=$1 AND user_id=$2";
    await assert.rejects(x.f.domainPool.query(revoke, [x.pairA, x.usersA[1]]), { code: '23514' });
    held = await x.f.domainPool.connect(); await held.query('BEGIN');
    await held.query(revoke, [x.pairA, x.usersA[1]]);
    const inconsistent = { ...db, transaction: work => work({ query: (sql, params) => held.query(sql, params) }) };
    for (const actor of [principal, partner]) {
      assert.deepEqual(await listSharedSongs(inconsistent, actor, scope(x)), { ok: false, error: 'unavailable' });
      assert.deepEqual(await createSharedSong(inconsistent, actor, command), { ok: false, error: 'unavailable' });
    }
  } finally { if (held) { await held.query('ROLLBACK'); held.release(); } await x.f.close(); }
});


test('shared songs PostgreSQL: revoked provider session during user-lock wait denies list and replay without disclosure', async () => {
  const x = await songsFixture(); let held; const pending = [];
  try {
    const db = x.f.database(), principal = await x.principal(0);
    const command = createCommand(x); assert.equal((await createSharedSong(db, principal, command)).ok, true);
    held = await x.f.domainPool.connect(); await held.query('BEGIN');
    await held.query('SELECT id FROM users WHERE id=ANY($1) ORDER BY id FOR UPDATE', [x.usersA]);
    pending.push(observeTask(createSharedSong(db, principal, command)), observeTask(listSharedSongs(db, principal, scope(x))));
    await waitForQueryLock(x.f, '%FROM users%FOR %');
    await x.f.authPool.query('DELETE FROM "session" WHERE id=$1', [principal.sessionId]);
    await held.query('COMMIT'); held.release(); held = null;
    for (const result of await Promise.all(pending)) assert.deepEqual(result, { ok: false, error: 'unavailable' });
    assert.equal((await x.f.domainPool.query('SELECT count(*)::int n FROM shared_songs')).rows[0].n, 1);
  } finally { if (held) { await held.query('ROLLBACK'); held.release(); } await settleBounded(pending); await x.f.close(); }
});

test('shared songs PostgreSQL: equal server millisecond timestamp uses stable descending UUID tie-breaker', async () => {
  const x = await songsFixture();
  try {
    const db = x.f.database(), actor = await x.principal(0), partner = await x.principal(1);
    const instant = new Date('2026-11-10T12:00:00.123Z'); const sameClock = { ...db, now: () => new Date(instant) };
    const first = await createSharedSong(sameClock, actor, createCommand(x));
    const second = await createSharedSong(sameClock, partner, createCommand(x));
    assert.equal(first.ok, true); assert.equal(second.ok, true);
    assert.equal(first.value.song.createdAt, instant.toISOString()); assert.equal(second.value.song.createdAt, instant.toISOString());
    const expected = [first.value.song.id, second.value.song.id].sort().reverse();
    for (const member of [actor, partner]) assert.deepEqual((await listSharedSongs(db, member, scope(x))).value.songs.map(d => d.id), expected);
  } finally { await x.f.close(); }
});
