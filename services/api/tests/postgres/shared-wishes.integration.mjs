import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createFixture } from './fixture.mjs';
import { account, waitForQueryLock, gate } from './profile-fixture.mjs';
import { createSharedWish, changeSharedWish, listSharedWishes } from '../../src/shared-wishes.ts';
import { leavePair } from '../../src/pair-leave.ts';
import { pairAgain } from './pair-leave-fixture.mjs';
import { observeTask, settleBounded, barrierOrCompletion } from './async-bounds.mjs';

test('wishes PostgreSQL: populated migration/rollback, atomic receipts, CAS, expiry, epoch, closure races and pair isolation', async () => {
  const f = await createFixture({ skipSharedWishesMigration: true }); let held; const pending = []; const barrier = gate();
  try {
    // Finish every independent signup before any failure can begin pool cleanup.
    const signups = await Promise.allSettled([account(f, 0), account(f, 1), account(f, 2), account(f, 3)]);
    const failed = signups.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    const identities = signups.map(result => result.value);
    const pair = randomUUID(), foreignPair = randomUUID();
    const users = await f.provision(identities.slice(0, 2).map(x => x.user.id), pair);
    const otherUsers = await f.provision(identities.slice(2).map(x => x.user.id), foreignPair);
    await f.domainPool.query(`INSERT INTO shared_tasks(couple_id,creator_id,membership_epoch,title,created_at,updated_at)
      VALUES($1,$2,1,'Synthetic prior task','2026-11-10Z','2026-11-10Z')`, [pair, users[0]]);
    await f.domainPool.query(`INSERT INTO shared_songs(couple_id,creator_id,membership_epoch,command_id,title,explanation,created_at)
      VALUES($1,$2,1,$3,'Synthetic prior song','Prior reason','2026-11-10Z')`, [pair, users[1], randomUUID()]);
    const legacy = async () => (await f.domainPool.query(`SELECT
      (SELECT jsonb_agg(t) FROM shared_tasks t) tasks,(SELECT jsonb_agg(s) FROM shared_songs s) songs`)).rows;
    const before = await legacy();
    const migration = await readFile(new URL('../../migrations/019_shared_wishes.sql', import.meta.url), 'utf8');
    held = await f.domainPool.connect(); await held.query('BEGIN'); await held.query(migration);
    assert.equal((await held.query('SELECT count(*)::int n FROM shared_wishes')).rows[0].n, 0);
    await held.query('ROLLBACK'); held.release(); held = null;
    assert.equal((await f.domainPool.query("SELECT to_regclass('shared_wishes') t")).rows[0].t, null);
    assert.deepEqual(await legacy(), before); await f.domainPool.query(migration); assert.deepEqual(await legacy(), before);
    const actors = await Promise.all(identities.map(async (identity, n) => {
      const s = (await f.domainPool.query('SELECT id,"expiresAt" FROM "session" WHERE "userId"=$1', [identity.user.id])).rows[0];
      return { source: 'better-auth', userId: [...users, ...otherUsers][n], authUserId: identity.user.id,
        sessionId: s.id, tokenExpiresAt: Math.floor(s.expiresAt.getTime() / 1000) };
    }));
    const db = f.database(), scope = { coupleId: pair, membershipEpoch: 1 };
    const create = { ...scope, commandId: randomUUID(), title: 'Synthetic wish', explanation: '' };
    const broken = { ...db, transaction: work => db.transaction(tx => work({ query: (sql, params) => {
      if (sql.includes('INSERT INTO shared_wish_commands')) throw Error('synthetic_receipt_failure');
      return tx.query(sql, params);
    } })) };
    await assert.rejects(createSharedWish(broken, actors[0], create), /synthetic_receipt_failure/);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM shared_wishes')).rows[0].n, 0);
    const attempts = await Promise.all(Array.from({ length: 6 }, () => createSharedWish(db, actors[0], create)));
    assert.equal(attempts.filter(x => x.ok && !x.value.replay).length, 1);
    assert.ok(attempts.every(x => x.ok)); const wish = attempts[0].value.wish;
    assert.equal(new Set(attempts.map(x => x.value.wish.id)).size, 1);
    const fulfill = { ...scope, wishId: wish.id, commandId: randomUUID(), expectedVersion: 1, operation: 'fulfill' };
    await assert.rejects(changeSharedWish(broken, actors[1], fulfill), /synthetic_receipt_failure/);
    assert.deepEqual((await listSharedWishes(db, actors[1], scope)).value.wishes, [wish]);
    const race = await Promise.all([changeSharedWish(db, actors[0], fulfill),
      changeSharedWish(db, actors[1], { ...fulfill, commandId: randomUUID() })]);
    assert.equal(race.filter(x => x.ok).length, 1); assert.equal(race.filter(x => x.error === 'version_conflict').length, 1);
    assert.equal((await changeSharedWish(db, actors[1], { ...fulfill, commandId: randomUUID(), operation: 'reopen', expectedVersion: 2 })).ok, true);
    const replay = await createSharedWish(db, actors[0], create);
    assert.equal(replay.value.replay, true); assert.equal(replay.value.appliedVersion, 1); assert.equal(replay.value.wish.version, 3);
    assert.equal(replay.value.wish.creatorId, users[0]); assert.equal(replay.value.wish.state, 'open');
    for (const actor of actors.slice(2)) {
      assert.deepEqual(await listSharedWishes(db, actor, scope), { ok: false, error: 'unavailable' });
      assert.deepEqual(await changeSharedWish(db, actor, fulfill), { ok: false, error: 'unavailable' });
      assert.deepEqual(await createSharedWish(db, actor, create), { ok: false, error: 'unavailable' });
    }
    assert.deepEqual((await listSharedWishes(db, actors[2], { ...scope, coupleId: foreignPair })).value.wishes, []);
    await f.domainPool.query('UPDATE couples SET membership_epoch=2 WHERE id=$1', [pair]);
    assert.deepEqual(await createSharedWish(db, actors[0], create), { ok: false, error: 'stale_membership' });
    assert.deepEqual(await createSharedWish(db, actors[0], { ...create, membershipEpoch: 2 }), { ok: false, error: 'idempotency_conflict' });
    await f.domainPool.query('UPDATE couples SET membership_epoch=1 WHERE id=$1', [pair]);
    for (const sql of ['UPDATE shared_wish_commands SET title=title', 'DELETE FROM shared_wish_commands', 'DELETE FROM shared_wishes',
      "UPDATE shared_wishes SET explanation='Changed',version=version+1,state='fulfilled'", 'UPDATE shared_wishes SET creator_id=gen_random_uuid()',
      "UPDATE shared_wishes SET state='fulfilled',version=version+2"]) await assert.rejects(f.domainPool.query(sql), { code: '23514' });
    for (const [title, explanation, stamp] of [
      ['', '', '2026-11-10Z'], ['x'.repeat(201), '', '2026-11-10Z'],
      ['Synthetic', 'x'.repeat(601), '2026-11-10Z'], ['Synthetic', 'e\u0301', '2026-11-10Z'],
      ['Synthetic', 'x\r', '2026-11-10Z'], ['Synthetic', '', 'infinity'],
      ['Synthetic', '', '2026-11-10T00:00:00.000001Z'],
    ]) await assert.rejects(f.domainPool.query(`INSERT INTO shared_wishes
      (couple_id,creator_id,membership_epoch,title,explanation,created_at,updated_at) VALUES($1,$2,1,$3,$4,$5,$5)`,
    [pair, users[0], title, explanation, stamp]), { code: '23514' });
    await assert.rejects(f.domainPool.query(`INSERT INTO shared_wish_commands
      (actor_user_id,command_id,couple_id,membership_epoch,wish_id,operation,expected_version,title,explanation,applied_version)
      VALUES($1,$2,$3,1,$4,'fulfill',2,NULL,NULL,3)`, [users[0], randomUUID(), pair, wish.id]), { code: '23514' });
    const latestIds = Array.from({ length: 51 }, () => randomUUID()).sort().reverse();
    for (const id of latestIds) await f.domainPool.query(`INSERT INTO shared_wishes
      (id,couple_id,creator_id,membership_epoch,title,explanation,created_at,updated_at)
      VALUES($1,$2,$3,1,'Synthetic latest','','2090-01-01Z','2090-01-01Z')`, [id, pair, users[0]]);
    assert.deepEqual((await listSharedWishes(db, actors[1], scope)).value.wishes.map(x => x.id), latestIds.slice(0, 50));
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM outbox_events')).rows[0].n, 0);
    // Every request must recheck the real provider session after waiting on the pair lock.
    await f.domainPool.query('UPDATE "session" SET "expiresAt"=clock_timestamp()+interval \'1 second\' WHERE id=ANY($1)', [actors.slice(0, 2).map(x => x.sessionId)]);
    held = await f.domainPool.connect(); await held.query('BEGIN'); await held.query('SELECT id FROM couples WHERE id=$1 FOR UPDATE', [pair]);
    pending.push(observeTask(createSharedWish(db, actors[0], create)),
      observeTask(createSharedWish(db, actors[0], { ...create, commandId: randomUUID() })),
      observeTask(changeSharedWish(db, actors[1], { ...fulfill, commandId: randomUUID(), expectedVersion: 3 })),
      observeTask(listSharedWishes(db, actors[1], scope)));
    await waitForQueryLock(f, '%FROM couples%FOR %'); await new Promise(resolve => setTimeout(resolve, 1200));
    await held.query('COMMIT'); held.release(); held = null;
    for (const result of await Promise.all(pending)) assert.deepEqual(result, { ok: false, error: 'unavailable' });
    await f.domainPool.query('UPDATE "session" SET "expiresAt"=clock_timestamp()+interval \'1 hour\' WHERE id=ANY($1)', [actors.slice(0, 2).map(x => x.sessionId)]);
    let stopped = false;
    const traced = { ...db, transaction: work => db.transaction(tx => work({ query: async (sql, params) => {
      const result = await tx.query(sql, params);
      if (!stopped && sql.includes('FROM couples') && sql.includes('FOR UPDATE')) { stopped = true; await barrier.hook(); }
      return result;
    } })) };
    const closing = observeTask(leavePair(traced, actors[0], { ...scope, commandId: randomUUID(), confirm: true }));
    pending.push(closing); await barrierOrCompletion(barrier.ready, closing);
    const denied = [observeTask(createSharedWish(db, actors[1], { ...create, commandId: randomUUID() })),
      observeTask(changeSharedWish(db, actors[1], { ...fulfill, expectedVersion: 3 })), observeTask(listSharedWishes(db, actors[1], scope))];
    pending.push(...denied); await waitForQueryLock(f, '%FROM users%FOR %'); barrier.release();
    assert.equal((await closing).ok, true);
    for (const result of await Promise.all(denied)) assert.deepEqual(result, { ok: false, error: 'unavailable' });
    assert.deepEqual(await createSharedWish(db, actors[0], create), { ok: false, error: 'unavailable' });
    const newPair = await pairAgain(f, users);
    assert.deepEqual(await createSharedWish(db, actors[0], { ...create, coupleId: newPair }), { ok: false, error: 'idempotency_conflict' });
    assert.deepEqual(await changeSharedWish(db, actors[0], { ...fulfill, coupleId: newPair, commandId: randomUUID() }), { ok: false, error: 'unavailable' });
    assert.deepEqual((await listSharedWishes(db, actors[0], { ...scope, coupleId: newPair })).value.wishes, []);
    assert.deepEqual(await legacy(), before);
  } finally {
    barrier.release(); if (held) { await held.query('ROLLBACK'); held.release(); }
    await settleBounded(pending); await f.close();
  }
});
