import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { blindFixture, value } from './blind-fixture.mjs';
import { openBlindRound, readBlindRound, submitBlindAnswer } from '../../src/blind-answers.ts';
import { gate, waitForQueryLock } from './profile-fixture.mjs';
import { observeTask, barrierOrCompletion, settleBounded } from './async-bounds.mjs';
const scope = x => ({ coupleId: x.pairA, membershipEpoch: 1 });
const opening = x => ({ ...scope(x), commandId: randomUUID(), questionId: 'small-joy', catalogVersion: 1 });
const answer = (x, round) => ({ ...opening(x), roundId: round.id, answer: 'Synthetic A', confirm: true });

test('blind PostgreSQL: real SQL projection does not read another body before mutual submission', async () => {
  const x = await blindFixture();
  try {
    const db = x.f.database(), a = await x.principal(0), b = await x.principal(1);
    const round = (await openBlindRound(db, a, opening(x))).value.round;
    const queries = [];
    const traced = { ...db, transaction: work => db.transaction(tx => work({ query: (sql, params) => {
      queries.push({ sql, params }); return tx.query(sql, params);
    } })) };
    const before = await readBlindRound(traced, b, scope(x));
    const mine = answer(x, round); await submitBlindAnswer(db, a, mine);
    assert.deepEqual(await readBlindRound(traced, b, scope(x)), before);
    await submitBlindAnswer(traced, a, mine);
    const bodyQueries = queries.filter(q => /SELECT.*body.*FROM blind_answers/i.test(q.sql));
    assert.ok(bodyQueries.length >= 3);
    for (const q of bodyQueries) {
      assert.match(q.sql, /author_id=\$2/); assert.equal(q.params.length, 2);
    }
    assert.equal(bodyQueries.filter(q => q.params[1] === a.userId).length, 2, 'only own replay/body projection reads A');
    queries.length = 0;
    await readBlindRound(traced, b, scope(x));
    assert.ok(queries.filter(q => /SELECT.*body.*FROM blind_answers/i.test(q.sql)).every(q => q.params[1] === b.userId));
    await submitBlindAnswer(db, b, { ...answer(x, round), answer: 'Synthetic B' });
    queries.length = 0;
    const revealed = await readBlindRound(traced, b, scope(x)); assert.equal(revealed.value.round.partnerAnswer, 'Synthetic A');
    assert.ok(queries.some(q => /SELECT.*body.*FROM blind_answers/i.test(q.sql) && q.params[1] === a.userId));
  } finally { await x.f.close(); }
});

for (const first of ['leave', 'submit', 'read']) {
  test(`blind PostgreSQL: ${first} serializes against closure without one-sided release`, async () => {
    const x = await blindFixture(), barrier = gate(), pending = []; let held = false;
    try {
      const db = x.f.database(), a = await x.principal(0), b = await x.principal(1);
      const round = (await openBlindRound(db, a, opening(x))).value.round;
      await submitBlindAnswer(db, a, answer(x, round));
      const traced = { ...db, transaction: work => db.transaction(tx => work({ query: async (sql, params) => {
        const result = await tx.query(sql, params);
        if (!held && sql.includes('FROM couples') && sql.includes('FOR UPDATE')) { held = true; await barrier.hook(); }
        return result;
      } })) };
      if (first === 'leave') {
        // Hold the pair before starting submit; closure wins the user/pair lock order.
        const { leavePair } = await import('../../src/pair-leave.ts');
        pending.push(observeTask(leavePair(traced, a, { ...scope(x), commandId: randomUUID(), confirm: true })));
      } else pending.push(observeTask(first === 'submit'
        ? submitBlindAnswer(traced, b, { ...answer(x, round), answer: 'Synthetic B' })
        : readBlindRound(traced, b, scope(x))));
      await barrierOrCompletion(barrier.ready, pending[0]);
      pending.push(observeTask(first === 'leave' ? submitBlindAnswer(db, b, answer(x, round)) : x.leave(0)));
      await waitForQueryLock(x.f, '%FROM users%FOR %'); barrier.release();
      const results = await Promise.all(pending);
      if (first === 'leave') assert.deepEqual(results[1], { ok: false, error: 'unavailable' });
      else { assert.equal(results[0].ok, true); assert.equal(results[1].status, 200); }
      assert.deepEqual(await readBlindRound(db, a, scope(x)), { ok: false, error: 'unavailable' });
      assert.deepEqual(await submitBlindAnswer(db, a, answer(x, round)), { ok: false, error: 'unavailable' });
    } finally { barrier.release(); await settleBounded(pending); await x.f.close(); }
  });
}

test('blind PostgreSQL: expired session after pair lock wait denies open/read/submit and exact replay', async () => {
  const x = await blindFixture(); const pending = []; let held;
  try {
    const db = x.f.database(), a = await x.principal(0), b = await x.principal(1);
    const command = opening(x), round = (await openBlindRound(db, a, command)).value.round;
    const submitted = answer(x, round); await submitBlindAnswer(db, a, submitted);
    await x.f.domainPool.query('UPDATE "session" SET "expiresAt"=clock_timestamp()+interval \'1 second\' WHERE id=ANY($1)', [[a.sessionId, b.sessionId]]);
    held = await x.f.domainPool.connect(); await held.query('BEGIN');
    await held.query('SELECT id FROM couples WHERE id=$1 FOR UPDATE', [x.pairA]);
    pending.push(observeTask(readBlindRound(db, b, scope(x))), observeTask(openBlindRound(db, a, command)),
      observeTask(submitBlindAnswer(db, a, submitted)), observeTask(submitBlindAnswer(db, b, answer(x, round))));
    await waitForQueryLock(x.f, '%FROM couples%FOR %');
    // Session expiry must be rechecked after the held pair lock.
    await new Promise(resolve => setTimeout(resolve, 1200));
    await held.query('COMMIT'); held.release(); held = null;
    for (const result of await Promise.all(pending)) assert.deepEqual(result, { ok: false, error: 'unavailable' });
    assert.equal((await x.f.domainPool.query('SELECT count(*)::int n FROM blind_answers')).rows[0].n, 1);
  } finally { if (held) { await held.query('ROLLBACK'); held.release(); } await settleBounded(pending); await x.f.close(); }
});

test('blind PostgreSQL: immutable rows and participant guard; answer and receipt commit atomically', async () => {
  const x = await blindFixture();
  try {
    const round = (await value(await x.open(0))).round;
    await assert.rejects(x.f.domainPool.query('INSERT INTO blind_answers(round_id,author_id,body) VALUES($1,$2,$3)',
      [round.id, x.usersB[0], 'Synthetic']), { code: '23514' });
    for (const body of ['', ' untrimmed ', 'two  spaces', 'e\u0301', 'line\nbreak', 'x'.repeat(1001)]) {
      await assert.rejects(x.f.domainPool.query('INSERT INTO blind_answers(round_id,author_id,body) VALUES($1,$2,$3)',
        [round.id, x.usersA[0], body]), { code: '23514' });
    }
    await x.f.domainPool.query(`CREATE FUNCTION reject_blind_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'Synthetic private answer'; END $$`);
    await x.f.domainPool.query('CREATE TRIGGER reject_blind_fixture BEFORE INSERT ON blind_commands FOR EACH ROW EXECUTE FUNCTION reject_blind_fixture()');
    const failed = await x.submit(0, round.id); assert.equal(failed.status, 503);
    assert.deepEqual(await failed.json(), { ok: false, error: 'temporarily_unavailable' });
    assert.equal((await value(await x.read(0))).round.ownAnswer, null);
    await x.f.domainPool.query('DROP TRIGGER reject_blind_fixture ON blind_commands');
    await x.submit(0, round.id);
    for (const table of ['blind_rounds', 'blind_answers', 'blind_commands']) {
      await assert.rejects(x.f.domainPool.query(`DELETE FROM ${table}`), { code: '23514' });
    }
    await assert.rejects(x.f.domainPool.query("UPDATE blind_answers SET body='Synthetic edited'"), { code: '23514' });
    await assert.rejects(x.f.domainPool.query('UPDATE blind_rounds SET catalog_version=1'), { code: '23514' });
    await assert.rejects(x.f.domainPool.query("UPDATE blind_commands SET operation='open'"), { code: '23514' });
  } finally { await x.f.close(); }
});

test('blind PostgreSQL: revoked provider session during user-lock wait prevents the second submission', async () => {
  const x = await blindFixture(); const pending = []; let held;
  try {
    const db = x.f.database(), a = await x.principal(0), b = await x.principal(1);
    const round = (await openBlindRound(db, a, opening(x))).value.round;
    await submitBlindAnswer(db, a, answer(x, round));
    held = await x.f.domainPool.connect(); await held.query('BEGIN');
    await held.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [[...x.usersA].sort()[0]]);
    pending.push(observeTask(submitBlindAnswer(db, b, answer(x, round))));
    await waitForQueryLock(x.f, '%FROM users%FOR %');
    await x.f.domainPool.query('DELETE FROM "session" WHERE id=$1', [b.sessionId]);
    await held.query('COMMIT'); held.release(); held = null;
    assert.deepEqual(await pending[0], { ok: false, error: 'unavailable' });
    assert.equal((await readBlindRound(db, a, scope(x))).value.round.partnerAnswer, null);
    assert.equal((await x.f.domainPool.query('SELECT count(*)::int n FROM blind_answers')).rows[0].n, 1);
  } finally { if (held) { await held.query('ROLLBACK'); held.release(); } await settleBounded(pending); await x.f.close(); }
});
