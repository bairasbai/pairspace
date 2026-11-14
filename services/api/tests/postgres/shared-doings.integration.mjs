import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { replyFixture } from './chat-replies-fixture.mjs';
import { proposeSharedDoing, listSharedDoings, joinSharedDoing, advanceSharedDoing, declineSharedDoing, removeSharedDoing } from '../../src/shared-doings.ts';
import { completeDoing } from '../../../../packages/domain/doings/state.ts';
import { leavePair } from '../../src/pair-leave.ts';
async function migration(f) { await f.domainPool.query(await readFile(new URL('../../migrations/042_shared_doings.sql', import.meta.url), 'utf8')); }
async function observedWait(f, pid, locker) {
  for (let n = 0; n < 150; n++) {
    const waiter = pid();
    if (waiter) {
      const r = (await f.domainPool.query('SELECT $2=ANY(pg_blocking_pids(pid)) blocked FROM pg_stat_activity WHERE pid=$1', [waiter, locker])).rows[0];
      if (r?.blocked) return;
    }
    await delay(10);
  }
  assert.fail('Expected real PostgreSQL lock wait was not observed');
}
test('real shared doings: independent own positions, voluntary join, CAS races, completion withdrawal, canonical removal and capacity', async () => {
  const { f, a, b, db, principals: p } = await replyFixture();
  try {
    await migration(f); const scope = { coupleId: a, membershipEpoch: 1 };
    const proposal = (title = 'Synthetic native course', parts = 3) => ({ ...scope, commandId: randomUUID(), confirm: true, title, kind: 'course', parts });
    const action = d => ({ ...scope, doingId: d.id, commandId: randomUUID(), expectedVersion: d.version, confirm: true });
    const original = proposal('🦉'.repeat(200));
    const duplicate = await Promise.all(Array.from({ length: 4 }, () => proposeSharedDoing(db, p[0], original)));
    assert.equal(duplicate.every(r => r.ok), true); assert.equal(duplicate.filter(r => !r.value.replay).length, 1);
    let d = duplicate[0].value.doing;
    assert.equal((await listSharedDoings(db, p[1], scope)).value.doings[0].title === original.title, true);
    assert.equal('recipientAt' in d, false);
    assert.equal((await joinSharedDoing(db, p[0], action(d))).error, 'unavailable');
    assert.equal((await advanceSharedDoing(db, p[1], { ...action(d), part: 1 })).error, 'version_conflict');
    assert.equal((await listSharedDoings(db, p[2], scope)).error, 'unavailable');
    assert.equal((await listSharedDoings(db, p[0], { ...scope, coupleId: b })).error, 'unavailable');
    d = (await advanceSharedDoing(db, p[0], { ...action(d), part: 2 })).value.doing;
    const joining = action(d); d = (await joinSharedDoing(db, p[1], joining)).value.doing;
    assert.equal(d.recipientAt, 0); assert.equal(d.authorAt, 2);
    for (const sql of ['UPDATE shared_doings SET author_at=author_at+1,recipient_at=recipient_at+1,version=version+1 WHERE id=$1',
      'UPDATE shared_doings SET author_at=1,version=version+1 WHERE id=$1', 'UPDATE shared_doings SET version=version+1 WHERE id=$1', 'DELETE FROM shared_doings WHERE id=$1']) await assert.rejects(f.domainPool.query(sql, [d.id]), { code: '23514' });
    const commands = [{ ...action(d), part: 3 }, { ...action(d), part: 1 }];
    const race = await Promise.all(commands.map((c, index) => advanceSharedDoing(db, p[index], c)));
    assert.equal(race.filter(r => r.ok).length, 1); assert.equal(race.find(r => !r.ok).error, 'version_conflict');
    d = (await listSharedDoings(db, p[0], scope)).value.doings[0];
    const loser = race.findIndex(r => !r.ok); d = (await advanceSharedDoing(db, p[loser], { ...action(d), part: commands[loser].part })).value.doing;
    d = (await advanceSharedDoing(db, p[1], { ...action(d), part: 3 })).value.doing;
    assert.equal(d.authorAt, 3); assert.equal(d.recipientAt, 3); assert.equal(completeDoing(d), true);
    assert.equal((await advanceSharedDoing(db, p[0], { ...action(d), part: 3 })).error, 'version_conflict');
    const declining = action(d); d = (await declineSharedDoing(db, p[1], declining)).value.doing;
    assert.equal(completeDoing(d), false); assert.equal('recipientAt' in d, false); assert.equal(d.authorAt, 3);
    assert.equal((await joinSharedDoing(db, p[1], action(d))).error, 'version_conflict');
    assert.equal((await removeSharedDoing(db, p[1], action(d))).error, 'unavailable');
    d = (await removeSharedDoing(db, p[0], action(d))).value.doing;
    for (const result of [await proposeSharedDoing(db, p[0], original), await joinSharedDoing(db, p[1], joining), await declineSharedDoing(db, p[1], declining)]) {
      assert.equal(result.ok && result.value.replay, true); assert.deepEqual(result.value.doing, d);
      assert.equal(['title', 'kind', 'parts', 'authorAt', 'recipientAt'].some(k => k in result.value.doing), false);
    }
    assert.deepEqual((await f.domainPool.query('SELECT title,kind,parts,author_at,recipient_at FROM shared_doings WHERE id=$1', [d.id])).rows[0], { title: null, kind: null, parts: null, author_at: null, recipient_at: null });
    await assert.rejects(f.domainPool.query('UPDATE shared_doing_commands SET fingerprint=fingerprint'), { code: '23514' });
    for (const competing of ['decline', 'remove']) {
      const next = (await proposeSharedDoing(db, p[0], proposal())).value.doing;
      const outcomes = await Promise.all([joinSharedDoing(db, p[1], action(next)), competing === 'decline' ? declineSharedDoing(db, p[1], action(next)) : removeSharedDoing(db, p[0], action(next))]);
      assert.equal(outcomes.filter(r => r.ok).length, 1); assert.equal(outcomes.find(r => !r.ok).error, 'version_conflict');
    }
    await assert.rejects(f.domainPool.query(`INSERT INTO shared_doings(couple_id,author_id,recipient_id,membership_epoch,sequence,version,created_at,content_state,decision_state,title,kind,parts,author_at)
      VALUES($1,$2,$3,1,(SELECT count(*)+1 FROM shared_doings WHERE couple_id=$1),1,clock_timestamp(),'active','invited',$4,'book',1,0)`, [a, p[0].userId, p[1].userId, String.fromCodePoint(0xa0) + 'Not canonical' + String.fromCodePoint(0xa0)]), { code: '23514' });
    let used = (await listSharedDoings(db, p[0], scope)).value.used;
    for (; used < 99; used++) assert.equal((await proposeSharedDoing(db, p[0], proposal())).ok, true);
    const capacity = await Promise.all([proposeSharedDoing(db, p[0], proposal('Last A')), proposeSharedDoing(db, p[0], proposal('Last B'))]);
    assert.equal(capacity.filter(r => r.ok).length, 1); assert.equal(capacity.find(r => !r.ok).error, 'capacity_reached');
    const history = (await listSharedDoings(db, p[1], scope)).value;
    assert.equal(history.used, 100); assert.equal(history.doings.length, 100);
    assert.deepEqual(history.doings.map(d => d.sequence).sort((x, y) => x - y), Array.from({ length: 100 }, (_, n) => n + 1));
    const last = history.doings.find(d => d.decisionState === 'invited');
    const lastJoin = await joinSharedDoing(db, p[1], action(last)); assert.equal(lastJoin.ok, true);
    assert.equal((await advanceSharedDoing(db, p[1], { ...action(lastJoin.value.doing), part: 1 })).ok, true);
    assert.equal((await leavePair(db, p[1], { ...scope, commandId: randomUUID(), confirm: true })).ok, true);
    assert.equal((await listSharedDoings(db, p[0], scope)).error, 'unavailable');
    assert.equal((await joinSharedDoing(db, p[1], joining)).error, 'unavailable');
  } finally { await f.close(); }
});
test('real shared-doing join receipt FK wait: expiry rolls back consent/progress/version/receipt before private projection', async () => {
  const { f, a, db, principals: p, usersA } = await replyFixture(); let holder, pending;
  try {
    await migration(f); const scope = { coupleId: a, membershipEpoch: 1 };
    const d = (await proposeSharedDoing(db, p[0], { ...scope, commandId: randomUUID(), confirm: true, title: 'Synthetic receipt boundary', kind: 'book', parts: 2 })).value.doing;
    holder = await f.domainPool.connect(); await holder.query('BEGIN');
    const locker = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    await holder.query('SELECT user_id FROM couple_members WHERE couple_id=$1 AND user_id=$2 FOR UPDATE', [a, usersA[1]]);
    let waiter, receipt = false, privateQueries = 0;
    const tracked = { ...db, transaction: work => db.transaction(async tx => {
      waiter = (await tx.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      return work({ query(sql, args) { if (sql.startsWith('INSERT INTO shared_doing_commands')) receipt = true;
        if (sql.startsWith('SELECT title,kind,parts')) privateQueries++; return tx.query(sql, args); } });
    }) };
    const limited = { ...p[1], tokenExpiresAt: Math.floor(Date.now() / 1000) + 2 };
    const joining = { ...scope, doingId: d.id, commandId: randomUUID(), expectedVersion: 1, confirm: true };
    pending = joinSharedDoing(tracked, limited, joining); pending.catch(() => {});
    await observedWait(f, () => receipt ? waiter : null, locker);
    assert.equal(privateQueries, 0); while (Date.now() < limited.tokenExpiresAt * 1000) await delay(10);
    await holder.query('COMMIT'); holder.release(); holder = null;
    assert.deepEqual(await pending, { ok: false, error: 'unavailable' }); pending = null; assert.equal(privateQueries, 0);
    assert.deepEqual((await listSharedDoings(db, p[0], scope)).value.doings, [d]);
    assert.equal((await f.domainPool.query('SELECT command_id FROM shared_doing_commands WHERE command_id=$1', [joining.commandId])).rowCount, 0);
  } finally { if (holder) { await holder.query('ROLLBACK'); holder.release(); } if (pending) await pending.catch(() => {}); await f.close(); }
});
test('real shared-doing target-row wait rechecks actual provider expiry before private positions or mutation', async () => {
  const { f, a, db, principals: p } = await replyFixture(); let holder, pending;
  try {
    await migration(f); const scope = { coupleId: a, membershipEpoch: 1 };
    const d = (await proposeSharedDoing(db, p[0], { ...scope, commandId: randomUUID(), confirm: true, title: 'Synthetic row boundary', kind: 'series', parts: 3 })).value.doing;
    await f.authPool.query(`UPDATE "session" SET "expiresAt"=clock_timestamp()+interval '2 seconds' WHERE id=$1`, [p[1].sessionId]);
    holder = await f.domainPool.connect(); await holder.query('BEGIN'); const locker = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    await holder.query('SELECT id FROM shared_doings WHERE id=$1 FOR UPDATE', [d.id]); let waiter, privateQueries = 0, writes = 0;
    const tracked = { ...db, transaction: work => db.transaction(async tx => { waiter = (await tx.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      return work({ query(sql, args) { if (sql.startsWith('SELECT title,kind,parts')) privateQueries++; if (sql.startsWith('UPDATE shared_doings')) writes++; return tx.query(sql, args); } }); }) };
    pending = joinSharedDoing(tracked, p[1], { ...scope, doingId: d.id, commandId: randomUUID(), expectedVersion: 1, confirm: true }); pending.catch(() => {});
    await observedWait(f, () => waiter, locker); await delay(2100);
    assert.equal((await f.domainPool.query('SELECT "expiresAt"<=clock_timestamp() expired FROM "session" WHERE id=$1', [p[1].sessionId])).rows[0].expired, true);
    await holder.query('COMMIT'); holder.release(); holder = null;
    assert.deepEqual(await pending, { ok: false, error: 'unavailable' }); pending = null; assert.equal(privateQueries, 0); assert.equal(writes, 0);
    assert.deepEqual((await listSharedDoings(db, p[0], scope)).value.doings, [d]);
  } finally { if (holder) { await holder.query('ROLLBACK'); holder.release(); } if (pending) await pending.catch(() => {}); await f.close(); }
});
test('real shared-doing list denies provider revocation after observed session-row wait before accessing any doing', async () => {
  const { f, a, db, principals: p } = await replyFixture(); let holder, pending;
  try {
    await migration(f); const scope = { coupleId: a, membershipEpoch: 1 };
    await proposeSharedDoing(db, p[0], { ...scope, commandId: randomUUID(), confirm: true, title: 'Synthetic revocation boundary', kind: 'other', parts: 1 });
    holder = await f.domainPool.connect(); await holder.query('BEGIN'); const locker = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    await holder.query('SELECT id FROM "session" WHERE id=$1 FOR UPDATE', [p[0].sessionId]); let waiter, queries = 0;
    const tracked = { ...db, transaction: work => db.transaction(async tx => { waiter = (await tx.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      return work({ query(sql, args) { if (sql.includes('FROM shared_doings')) queries++; return tx.query(sql, args); } }); }) };
    pending = listSharedDoings(tracked, p[0], scope); pending.catch(() => {}); await observedWait(f, () => waiter, locker);
    await holder.query('DELETE FROM "session" WHERE id=$1', [p[0].sessionId]); await holder.query('COMMIT'); holder.release(); holder = null;
    assert.deepEqual(await pending, { ok: false, error: 'unavailable' }); pending = null; assert.equal(queries, 0);
  } finally { if (holder) { await holder.query('ROLLBACK'); holder.release(); } if (pending) await pending.catch(() => {}); await f.close(); }
});
