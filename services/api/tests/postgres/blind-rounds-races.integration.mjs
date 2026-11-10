import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { roundsFixture, value } from './blind-rounds-fixture.mjs';
import { listBlindRounds, readSelectedBlindRound, nextBlindRound } from '../../src/blind-answers.ts';
import { waitForQueryLock } from './profile-fixture.mjs';
import { observeTask, settleBounded } from './async-bounds.mjs';
const scope = x => ({ coupleId: x.pairA, membershipEpoch: 1 });
const nextInput = (x, round) => ({ ...scope(x), commandId: randomUUID(), expectedPredecessorRoundId: round.id,
  questionId: 'shared-plan', catalogVersion: 1, confirm: true });

test('blind rounds PostgreSQL: raw SQL enforces current snapshot, complete predecessor and one concurrent successor', async () => {
  const x = await roundsFixture();
  try {
    const first = (await value(await x.open(0))).round;
    const insert = (predecessor, extra = {}) => {
      const r = { pair: x.pairA, epoch: 1, question: 'shared-plan', version: 1,
        participants: [...x.usersA].sort(), ...extra };
      return x.f.domainPool.query(`INSERT INTO blind_rounds
        (couple_id,membership_epoch,question_id,catalog_version,participant_one,participant_two,predecessor_round_id)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [r.pair, r.epoch, r.question, r.version, ...r.participants, predecessor]);
    };
    await assert.rejects(insert(first.id), { code: '23514' });
    await x.finish(first);
    for (const extra of [{ epoch: 2 }, { version: 2 }, { question: 'unknown' },
      { participants: [...x.usersB].sort() }, { pair: x.pairB, participants: [...x.usersB].sort() }]) {
      await assert.rejects(insert(first.id, extra), { code: '23514' });
    }
    await assert.rejects(insert(null), { code: '23514' });
    const results = await Promise.allSettled([insert(first.id), insert(first.id)]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.ok(['23514', '23505'].includes(results.find(r => r.status === 'rejected').reason.code));
    const second = results.find(r => r.status === 'fulfilled').value.rows[0];
    await assert.rejects(insert(first.id), { code: '23514' });
    await assert.rejects(x.f.domainPool.query('UPDATE blind_rounds SET predecessor_round_id=NULL WHERE id=$1', [second.id]), { code: '23514' });
    await x.leave(0);
    await assert.rejects(insert(second.id), { code: '23514' });
    assert.equal((await x.f.domainPool.query('SELECT count(*)::int n FROM blind_rounds')).rows[0].n, 2);
  } finally { await x.f.close(); }
});

test('blind rounds PostgreSQL: metadata does not query bodies and selected projection remains author-only until reveal', async () => {
  const x = await roundsFixture();
  try {
    const first = (await value(await x.open(0))).round; await x.finish(first);
    const second = (await value(await x.next(0, x.command(first)))).round;
    await x.submit(0, second.id, 'Synthetic hidden next answer', randomUUID(), x.pairA, 1, { question_id: 'shared-plan' });
    const db = x.f.database(), b = await x.principal(1), queries = [];
    const traced = { ...db, transaction: work => db.transaction(tx => work({ query: (sql, params) => {
      queries.push({ sql, params }); return tx.query(sql, params);
    } })) };
    assert.equal((await listBlindRounds(traced, b, scope(x))).ok, true);
    assert.equal(queries.filter(q => /FROM blind_answers/i.test(q.sql)).length, 0, 'metadata cannot query answers at all');
    queries.length = 0;
    const selected = await readSelectedBlindRound(traced, b, { ...scope(x), roundId: second.id });
    assert.equal(selected.value.round.partnerAnswer, null);
    const bodies = queries.filter(q => /SELECT.*body.*FROM blind_answers/i.test(q.sql));
    assert.ok(bodies.length > 0);
    for (const q of bodies) { assert.match(q.sql, /author_id=\$2/); assert.equal(q.params[1], b.userId); }
  } finally { await x.f.close(); }
});

for (const mode of ['revoke', 'close']) {
  test(`blind rounds PostgreSQL: ${mode} during lock wait denies next/history/selected including replay`, async () => {
    const x = await roundsFixture(), pending = []; let held;
    try {
      const first = (await value(await x.open(0))).round; await x.finish(first);
      const db = x.f.database(), a = await x.principal(0), command = nextInput(x, first);
      const second = (await nextBlindRound(db, a, command)).value.round;
      held = await x.f.domainPool.connect(); await held.query('BEGIN');
      // Revoke before session-share acquisition; closure wins at the pair lock.
      if (mode === 'revoke') await held.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [[...x.usersA].sort()[0]]);
      else await held.query('SELECT id FROM couples WHERE id=$1 FOR UPDATE', [x.pairA]);
      pending.push(observeTask(nextBlindRound(db, a, command)), observeTask(listBlindRounds(db, a, scope(x))),
        observeTask(readSelectedBlindRound(db, a, { ...scope(x), roundId: second.id })));
      await waitForQueryLock(x.f, mode === 'revoke' ? '%FROM users%FOR %' : '%FROM couples%FOR %');
      if (mode === 'revoke') await x.f.authPool.query('DELETE FROM "session" WHERE id=$1', [a.sessionId]);
      else {
        await held.query("UPDATE couple_members SET status='revoked' WHERE couple_id=$1", [x.pairA]);
        await held.query("UPDATE couples SET status='closed',membership_epoch=membership_epoch+1 WHERE id=$1", [x.pairA]);
      }
      await held.query('COMMIT'); held.release(); held = null;
      for (const result of await Promise.all(pending)) assert.deepEqual(result, { ok: false, error: 'unavailable' });
      assert.equal((await x.f.domainPool.query('SELECT count(*)::int n FROM blind_rounds')).rows[0].n, 2);
    } finally { if (held) { await held.query('ROLLBACK'); held.release(); } await settleBounded(pending); await x.f.close(); }
  });
}
