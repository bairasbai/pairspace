import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { songsFixture } from './shared-songs-fixture.mjs';
import { createSharedSong, editSharedSong, listSharedSongs } from '../../src/shared-songs.ts';
import { leaveHarness, assertClosed, pairAgain } from './pair-leave-fixture.mjs';
import { observedDatabase } from './invitation-fixture.mjs';
import { gate, waitForQueryLock } from './profile-fixture.mjs';
import { observeTask, barrierOrCompletion, settleBounded } from './async-bounds.mjs';

const scope = x => ({ coupleId: x.pairA, membershipEpoch: 1 });
const createCommand = x => ({ ...scope(x), commandId: randomUUID(), title: 'Synthetic race song', explanation: 'Synthetic explanation' });
const leaveCommand = x => ({ ...scope(x), commandId: randomUUID(), confirm: true });

for (const firstOperation of ['leave', 'create', 'list', 'edit']) {
  test(`shared songs PostgreSQL: ${firstOperation} first serializes with leave and denies closed resources`, async () => {
    const x = await songsFixture(); const barrier = gate(); const pending = []; let server; let held = false;
    try {
      const db = x.f.database(); const principal = await x.principal(0); const partner = await x.principal(1);
      const original = await createSharedSong(db, principal, createCommand(x)); assert.equal(original.ok, true);
      const createOnly = createCommand(x);
      const edit = { ...createOnly, songId: original.value.song.id, expectedVersion: 1 };
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
          : firstOperation === 'edit' ? editSharedSong(traced, principal, edit) : listSharedSongs(traced, partner, scope(x)));
      pending.push(first); await barrierOrCompletion(barrier.ready, first);
      const second = observeTask(firstOperation === 'leave' ? editSharedSong(db, principal, edit)
        : server.request(cookie, leaveCommand(x))); pending.push(second);
      if (firstOperation === 'leave') pending.push(observeTask(createSharedSong(db, partner, createOnly)));
      await waitForQueryLock(x.f, '%FROM users%FOR %'); barrier.release();
      const [a, b, deniedCreate] = await Promise.all(pending);
      if (firstOperation === 'leave') assert.deepEqual(deniedCreate, { ok: false, error: 'unavailable' });
      assert.equal(firstOperation === 'leave' ? a.status : b.status, 200);
      assert.equal(firstOperation === 'leave' ? b.ok : a.ok, firstOperation !== 'leave');
      await assertClosed(x.f, x.pairA);
      assert.deepEqual(await editSharedSong(db, principal, edit), { ok: false, error: 'unavailable' });
      assert.deepEqual(await createSharedSong(db, principal, createOnly), { ok: false, error: 'unavailable' });
      assert.deepEqual(await listSharedSongs(db, partner, scope(x)), { ok: false, error: 'unavailable' });
    } finally { barrier.release(); await settleBounded(pending); await server?.close(); await x.f.close(); }
  });
}

test('shared songs PostgreSQL: create, exact replay, list and edit recheck expired session after pair lock wait', async () => {
  const x = await songsFixture(); let held; const pending = [];
  try {
    const db = x.f.database(); const principal = await x.principal(0); const partner = await x.principal(1);
    const command = createCommand(x); const created = await createSharedSong(db, principal, command); assert.equal(created.ok, true);
    await x.f.domainPool.query('UPDATE "session" SET "expiresAt"=clock_timestamp()+interval \'1 second\' WHERE id=ANY($1)', [[principal.sessionId, partner.sessionId]]);
    held = await x.f.domainPool.connect(); await held.query('BEGIN');
    await held.query('SELECT id FROM couples WHERE id=$1 FOR UPDATE', [x.pairA]);
    pending.push(observeTask(createSharedSong(db, principal, command)),
      observeTask(createSharedSong(db, principal, createCommand(x))),
      observeTask(listSharedSongs(db, partner, scope(x))),
      observeTask(editSharedSong(db, principal, { ...command, songId: created.value.song.id, expectedVersion: 1, commandId: randomUUID() })));
    await waitForQueryLock(x.f, '%FROM couples%FOR %');
    await new Promise(resolve => setTimeout(resolve, 1200));
    await held.query('COMMIT'); held.release(); held = null;
    for (const result of await Promise.all(pending)) assert.deepEqual(result, { ok: false, error: 'unavailable' });
    assert.equal((await x.f.domainPool.query('SELECT count(*)::int AS n FROM shared_songs')).rows[0].n, 1);
  } finally { if (held) { await held.query('ROLLBACK'); held.release(); } await settleBounded(pending); await x.f.close(); }
});

test('shared songs PostgreSQL: old create/edit commands cannot cross to a new pair; old resource remains isolated', async () => {
  const x = await songsFixture();
  try {
    const db = x.f.database(); const principal = await x.principal(0); const partner = await x.principal(1);
    const command = createCommand(x); const created = await createSharedSong(db, principal, command); assert.equal(created.ok, true);
    const edit = { ...command, commandId: randomUUID(), songId: created.value.song.id, expectedVersion: 1, title: 'Synthetic corrected' };
    assert.equal((await editSharedSong(db, principal, edit)).ok, true);
    assert.equal((await x.leave(1)).status, 200);
    const pair = await pairAgain(x.f, x.usersA);
    assert.deepEqual(await editSharedSong(db, principal, edit), { ok: false, error: 'unavailable' });
    assert.deepEqual(await editSharedSong(db, principal, { ...edit, coupleId: pair }), { ok: false, error: 'idempotency_conflict' });
    assert.deepEqual(await editSharedSong(db, principal, { ...edit, coupleId: pair, commandId: randomUUID() }), { ok: false, error: 'unavailable' });
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


test('shared songs PostgreSQL: revoked provider session during user-lock wait denies list, replay and edit without disclosure', async () => {
  const x = await songsFixture(); let held; const pending = [];
  try {
    const db = x.f.database(), principal = await x.principal(0);
    const command = createCommand(x); const created = await createSharedSong(db, principal, command); assert.equal(created.ok, true);
    held = await x.f.domainPool.connect(); await held.query('BEGIN');
    await held.query('SELECT id FROM users WHERE id=ANY($1) ORDER BY id FOR UPDATE', [x.usersA]);
    pending.push(observeTask(createSharedSong(db, principal, command)), observeTask(listSharedSongs(db, principal, scope(x))),
      observeTask(editSharedSong(db, principal, { ...command, songId: created.value.song.id, expectedVersion: 1, commandId: randomUUID() })));
    await waitForQueryLock(x.f, '%FROM users%FOR %');
    await x.f.authPool.query('DELETE FROM "session" WHERE id=$1', [principal.sessionId]);
    await held.query('COMMIT'); held.release(); held = null;
    for (const result of await Promise.all(pending)) assert.deepEqual(result, { ok: false, error: 'unavailable' });
    assert.equal((await x.f.domainPool.query('SELECT count(*)::int n FROM shared_songs')).rows[0].n, 1);
  } finally { if (held) { await held.query('ROLLBACK'); held.release(); } await settleBounded(pending); await x.f.close(); }
});

test('shared songs PostgreSQL: stable creation order survives same-version edit race, replay and epoch change', async () => {
  const x = await songsFixture();
  try {
    const db = x.f.database(), actor = await x.principal(0), partner = await x.principal(1);
    const instant = new Date('2026-11-10T12:00:00.123Z'); const sameClock = { ...db, now: () => new Date(instant) };
    const first = await createSharedSong(sameClock, actor, createCommand(x));
    const second = await createSharedSong(sameClock, partner, createCommand(x));
    assert.equal(first.ok, true); assert.equal(second.ok, true);
    assert.equal(first.value.song.createdAt, instant.toISOString()); assert.equal(second.value.song.createdAt, instant.toISOString());
    const edit = { ...createCommand(x), songId: first.value.song.id, expectedVersion: 1, title: 'Synthetic first edit' };
    const other = { ...edit, commandId: randomUUID(), title: 'Synthetic concurrent edit' };
    const results = await Promise.all([editSharedSong(db, actor, edit), editSharedSong(db, actor, other)]);
    assert.equal(results.filter(r => r.ok).length, 1);
    assert.deepEqual(results.find(r => !r.ok), { ok: false, error: 'version_conflict' });
    const winningCommand = results[0].ok ? edit : other;
    const replays = await Promise.all([editSharedSong(db, actor, winningCommand), editSharedSong(db, actor, winningCommand)]);
    assert.ok(replays.every(r => r.ok && r.value.replay && r.value.song.version === 2));
    assert.deepEqual(await editSharedSong(db, partner, { ...edit, expectedVersion: 2 }), { ok: false, error: 'unavailable' });
    assert.deepEqual(await editSharedSong(db, await x.principal(2), edit), { ok: false, error: 'unavailable' });
    assert.equal((await x.f.domainPool.query('SELECT count(*)::int n FROM shared_song_commands')).rows[0].n, 3);
    const expected = [first.value.song.id, second.value.song.id].sort().reverse();
    for (const member of [actor, partner]) assert.deepEqual((await listSharedSongs(db, member, scope(x))).value.songs.map(d => d.id), expected);
    await x.f.domainPool.query('UPDATE couples SET membership_epoch=2 WHERE id=$1', [x.pairA]);
    assert.deepEqual(await editSharedSong(db, actor, winningCommand), { ok: false, error: 'stale_membership' });
    assert.deepEqual(await editSharedSong(db, actor, { ...winningCommand, membershipEpoch: 2 }), { ok: false, error: 'idempotency_conflict' });
  } finally { await x.f.close(); }
});
