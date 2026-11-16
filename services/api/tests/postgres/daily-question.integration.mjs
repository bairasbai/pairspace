import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDailyAnswer, rewriteDailyAnswer, removeDailyAnswer, readDailyAnswer, listDailyQuestions } from '../../src/daily-questions.ts';
import { leavePair } from '../../src/pair-leave.ts';
import { pairAgain } from './pair-leave-fixture.mjs';
import { dailyPrompt } from '../../../../packages/domain/daily-question/catalog.ts';
import { fixture, early, past, proposal, command, observed, bodyFree } from './daily-question-fixture.mjs';

test('real daily question: concurrent first answers share immutable slot, duplicates/current replay and canonical today witness', async () => {
 const { f, a, db, principals: p, usersA } = await fixture();
 try {
  const scope = { coupleId: a, membershipEpoch: 1 }, input = proposal(scope, '🦉'.repeat(2000));
  const results = await Promise.all(Array.from({ length: 4 }, () => createDailyAnswer(db, p[0], input, early)));
  assert.equal(results.every(result => result.ok), true); assert.equal(results.filter(result => !result.value.replay).length, 1); results.forEach(bodyFree);
  const first = results[0].value, detail = { ...scope, answerId: first.answer.id }, state = { bodies: 0 }, tracked = observed(db, state);
  assert.equal((await f.domainPool.query('SELECT id FROM daily_question_slots')).rowCount, 1);
  const hidden = await readDailyAnswer(tracked, p[1], detail, early); assert.equal(hidden.ok, true); bodyFree(hidden); assert.equal(state.bodies, 0);
  assert.equal((await readDailyAnswer(tracked, p[0], detail, early)).value.text, input.text); assert.equal(state.bodies, 1);
  const competing = await Promise.all([createDailyAnswer(db, p[1], proposal(scope, 'Partner first'), early), createDailyAnswer(db, p[1], proposal(scope, 'Partner competing'), early)]);
  assert.equal(competing.filter(result => result.ok).length, 1); assert.equal(competing.find(result => !result.ok).error, 'version_conflict');
  const partner = competing.find(result => result.ok).value;
  assert.equal(partner.slot.id, first.slot.id); assert.deepEqual(partner.slot.participantIds, [...usersA].sort());
  state.bodies = 0; state.bodyAuthors = [];
  assert.equal((await readDailyAnswer(tracked, p[1], detail, early)).value.text, input.text);
  assert.deepEqual(state.bodyAuthors, [usersA[1], usersA[0]], 'own canonical text validated before partner text');
  const replacement = { ...command(scope, first.answer), text: 'Synthetic replacement' };
  const rewritten = await rewriteDailyAnswer(db, p[0], replacement, early); assert.equal(rewritten.ok, true); bodyFree(rewritten);
  const originalReplay = await createDailyAnswer(db, p[0], input, past); assert.equal(originalReplay.value.replay, true);
  assert.deepEqual(originalReplay.value.answer, rewritten.value.answer); assert.deepEqual(originalReplay.value.slot, first.slot); bodyFree(originalReplay);
  assert.equal((await removeDailyAnswer(db, p[1], command(scope, partner.answer), early)).ok, true);
  state.bodies = 0; bodyFree(await readDailyAnswer(tracked, p[1], detail, early)); assert.equal(state.bodies, 0);
  assert.equal((await readDailyAnswer(tracked, p[1], detail, past)).value.text, replacement.text, 'past day does not require an own answer');
  assert.equal((await createDailyAnswer(db, p[1], proposal(scope), early)).error, 'version_conflict');
  assert.equal((await rewriteDailyAnswer(db, p[0], { ...command(scope, rewritten.value.answer), text: 'Too late' }, past)).error, 'version_conflict');
  const removed = await removeDailyAnswer(db, p[0], command(scope, rewritten.value.answer), past); assert.equal(removed.ok, true);
  for (const result of [await createDailyAnswer(db, p[0], input, past), await rewriteDailyAnswer(db, p[0], replacement, past)]) {
   assert.equal(result.value.replay, true); assert.deepEqual(result.value.answer, removed.value.answer); bodyFree(result);
  }
  state.bodies = 0; bodyFree(await readDailyAnswer(tracked, p[1], detail, past)); assert.equal(state.bodies, 0);
  assert.equal((await f.domainPool.query('SELECT text FROM daily_question_answers WHERE id=$1', [first.answer.id])).rows[0].text, null);
  bodyFree(await listDailyQuestions(tracked, p[0], { ...scope, beforeDay: null }, past));
  assert.equal((await readDailyAnswer(tracked, p[2], detail, past)).error, 'unavailable');
  assert.equal((await listDailyQuestions(db, p[0], { ...scope, beforeDay: null, membershipEpoch: 2 }, past)).error, 'stale_membership');
 } finally { await f.close(); }
});

test('real daily question: two simultaneous participants create one pinned question and CAS rewrite/removal serializes', async () => {
 const { f, a, db, principals: p } = await fixture();
 try {
  const scope = { coupleId: a, membershipEpoch: 1 };
  const results = await Promise.all([createDailyAnswer(db, p[0], proposal(scope), early, () => 'UTC'), createDailyAnswer(db, p[1], proposal(scope), early, () => 'UTC')]);
  assert.equal(results.every(result => result.ok), true); assert.equal(results[0].value.slot.id, results[1].value.slot.id);
  const q = results[0].value.answer;
  const race = await Promise.all([rewriteDailyAnswer(db, p[0], { ...command(scope, q), text: 'Replacement race' }, early), removeDailyAnswer(db, p[0], command(scope, q), early)]);
  assert.equal(race.filter(result => result.ok).length, 1); assert.equal(race.find(result => !result.ok).error, 'version_conflict');
  const history = await listDailyQuestions(db, p[0], { ...scope, beforeDay: null }, early, () => 'Asia/Tokyo');
  assert.equal(history.value.today.timezone, 'UTC'); assert.equal(history.value.slots[0].slot.timezone, 'UTC');
  const next = await createDailyAnswer(db, p[0], proposal(scope, 'Next day', '2026-11-11'), past, () => 'Asia/Tokyo');
  assert.equal(next.ok, true); assert.equal(next.value.slot.timezone, 'UTC'); assert.notEqual(next.value.slot.id, results[0].value.slot.id);
 } finally { await f.close(); }
});

test('real daily question: database rejects catalog/identity/text rewrites, malformed receipts, terminal resurrection', async () => {
 const { f, a, db, principals: p, usersA } = await fixture();
 try {
  const scope = { coupleId: a, membershipEpoch: 1 }, made = await createDailyAnswer(db, p[0], proposal(scope), early);
  const { slot, answer } = made.value;
  for (const day of ['0001-01-01', '2025-12-31', '2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05', '2026-01-06', '2026-01-07', '9999-12-31']) {
   assert.deepEqual((await f.domainPool.query('SELECT daily_question_prompt($1::date,$2) value', [day, 'amio-daily-v1'])).rows[0].value, dailyPrompt(day));
  }
  assert.equal((await f.domainPool.query('SELECT daily_question_prompt($1::date,$2) value', ['2026-11-10', 'unknown'])).rows[0].value, null);
  const nextPrompt = dailyPrompt('2026-11-11');
  for (const patch of [{ catalogVersion: 'unknown' }, { promptId: 'unknown' }, { promptRU: 'rewritten' }, { promptEN: 'rewritten' }]) {
   const candidate = { ...nextPrompt, ...patch };
   await assert.rejects(f.domainPool.query(`INSERT INTO daily_question_slots(couple_id,membership_epoch,participant_a,participant_b,day,timezone,catalog_version,prompt_id,prompt_ru,prompt_en,created_at)
    VALUES($1,1,$2,$3,'2026-11-11','UTC',$4,$5,$6,$7,'2026-11-11T12:00:00Z')`,
    [a, ...slot.participantIds, candidate.catalogVersion, candidate.promptId, candidate.promptRU, candidate.promptEN]), { code: '23514' });
  }
  for (const sql of ["UPDATE daily_question_slots SET prompt_ru='rewritten' WHERE id=$1", "UPDATE daily_question_slots SET timezone='Asia/Tokyo' WHERE id=$1", 'DELETE FROM daily_question_slots WHERE id=$1']) await assert.rejects(f.domainPool.query(sql, [slot.id]), { code: '23514' });
  await assert.rejects(f.domainPool.query("UPDATE daily_question_zones SET timezone='Asia/Tokyo' WHERE couple_id=$1", [a]), { code: '23514' });
  await assert.rejects(f.domainPool.query('INSERT INTO daily_question_zones VALUES($1,2,$2)', [a, 'UTC']), { code: '23514' });
  for (const sql of ["UPDATE daily_question_answers SET version=version+1,text=E'bad\\ttext' WHERE id=$1",
   "UPDATE daily_question_answers SET version=version+1,text=U&'e\\0301' WHERE id=$1", "UPDATE daily_question_answers SET version=version+1,text=repeat('a',2001) WHERE id=$1",
   "UPDATE daily_question_answers SET version=version+1,edited_at='2026-11-11' WHERE id=$1", 'DELETE FROM daily_question_answers WHERE id=$1']) await assert.rejects(f.domainPool.query(sql, [answer.id]), { code: '23514' });
  await assert.rejects(f.domainPool.query('UPDATE daily_question_commands SET fingerprint=fingerprint'), { code: '23514' });
  await assert.rejects(f.domainPool.query('DELETE FROM daily_question_commands'), { code: '23514' });
  const receipt = async (actor, applied, savedSlot) => f.domainPool.query(`INSERT INTO daily_question_commands(actor_user_id,command_id,couple_id,membership_epoch,answer_id,fingerprint,operation,expected_version,applied,slot)
   VALUES($1,$2,$3,1,$4,$5,'create',NULL,$6,$7)`, [actor, randomUUID(), a, answer.id, 'a'.repeat(64), applied, savedSlot]);
  await assert.rejects(receipt(usersA[1], answer, slot), { code: '23514' });
  await assert.rejects(receipt(usersA[0], { ...answer, text: 'leak' }, slot), { code: '23514' });
  await assert.rejects(receipt(usersA[0], answer, { ...slot, promptEN: 'forged' }), { code: '23514' });
  await removeDailyAnswer(db, p[0], command(scope, answer), early);
  await assert.rejects(f.domainPool.query("UPDATE daily_question_answers SET version=version+1,content_state='active',removed_at=NULL,text='resurrection' WHERE id=$1", [answer.id]), { code: '23514' });
 } finally { await f.close(); }
});

test('real daily question: history keyset is bounded to100, not lifetime capacity; old pair/epoch cannot cross', async () => {
 const { f, a, db, principals: p, usersA } = await fixture();
 try {
  const scope = { coupleId: a, membershipEpoch: 1 }; let original;
  for (let n = 0; n < 102; n++) {
   const time = new Date(Date.parse('2026-01-01T12:00:00.000Z') + n * 86400000), input = proposal(scope, 'Synthetic history', time.toISOString().slice(0, 10));
   const result = await createDailyAnswer(db, p[0], input, () => time); assert.equal(result.ok, true); if (!n) original = { input, value: result.value };
  }
  const last = () => new Date('2026-12-01T00:00:00.000Z');
  const first = (await listDailyQuestions(db, p[1], { ...scope, beforeDay: null }, last)).value;
  assert.equal(first.slots.length, 100); assert.equal(typeof first.nextBeforeDay, 'string'); bodyFree(first);
  const second = (await listDailyQuestions(db, p[1], { ...scope, beforeDay: first.nextBeforeDay }, last)).value;
  assert.equal(second.slots.length, 2); assert.equal(second.nextBeforeDay, null);
  assert.equal(new Set([...first.slots, ...second.slots].map(entry => entry.slot.id)).size, 102);
  assert.equal((await leavePair(db, p[1], { ...scope, commandId: randomUUID(), confirm: true })).ok, true);
  const pair = await pairAgain(f, usersA), newScope = { coupleId: pair, membershipEpoch: 1 };
  assert.equal((await createDailyAnswer(db, p[0], original.input, last)).error, 'unavailable');
  assert.equal((await createDailyAnswer(db, p[0], { ...original.input, ...newScope }, last)).error, 'idempotency_conflict');
  assert.equal((await readDailyAnswer(db, p[0], { ...newScope, answerId: original.value.answer.id }, last)).error, 'unavailable');
  assert.equal((await listDailyQuestions(db, p[0], { ...newScope, beforeDay: null }, last)).value.slots.length, 0);
 } finally { await f.close(); }
});

test('real daily SQL rejects answer and receipt writes for revoked members, changed epoch or closed pair', async () => {
 const { f, a, db, principals: p, usersA } = await fixture();
 try {
  const scope = { coupleId: a, membershipEpoch: 1 }, made = (await createDailyAnswer(db, p[0], proposal(scope), early)).value;
  const rewrite = tx => tx.query("UPDATE daily_question_answers SET version=version+1,text='Forbidden rewrite' WHERE id=$1", [made.answer.id]);
  const insertAnswer = tx => tx.query(`INSERT INTO daily_question_answers(slot_id,couple_id,membership_epoch,author_id,version,created_at,edited_at,content_state,text)
   VALUES($1,$2,1,$3,1,$4,$4,'active','Forbidden insert')`, [made.slot.id, a, usersA[1], made.answer.createdAt]);
  const insertReceipt = tx => tx.query(`INSERT INTO daily_question_commands(actor_user_id,command_id,couple_id,membership_epoch,answer_id,fingerprint,operation,applied,slot)
   VALUES($1,$2,$3,1,$4,$5,'create',$6,$7)`, [usersA[0], randomUUID(), a, made.answer.id, 'a'.repeat(64), made.answer, made.slot]);
  for (const change of ["UPDATE couple_members SET status='revoked' WHERE couple_id=$1", 'UPDATE couples SET membership_epoch=2 WHERE id=$1']) {
   for (const operation of [rewrite, insertAnswer, insertReceipt]) {
    const tx = await f.domainPool.connect();
    try { await tx.query('BEGIN'); await tx.query(change, [a]); await assert.rejects(operation(tx), { code: '23514' }); }
    finally { await tx.query('ROLLBACK'); tx.release(); }
   }
  }
  assert.equal((await leavePair(db, p[1], { ...scope, commandId: randomUUID(), confirm: true })).ok, true);
  for (const operation of [rewrite, insertAnswer, insertReceipt]) await assert.rejects(operation(f.domainPool), { code: '23514' });
  assert.deepEqual((await f.domainPool.query('SELECT version,text FROM daily_question_answers WHERE id=$1', [made.answer.id])).rows, [{ version: 1, text: 'Synthetic private daily answer' }]);
 } finally { await f.close(); }
});
