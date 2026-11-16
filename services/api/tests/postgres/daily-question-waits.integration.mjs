import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDailyAnswer, rewriteDailyAnswer, removeDailyAnswer, readDailyAnswer } from '../../src/daily-questions.ts';
import { fixture, early, start, tomorrow, proposal, command, observed, observedWait, lock, unlock, cleanup, delay, bodyFree } from './daily-question-fixture.mjs';

for (const boundary of ['pair', 'row']) test(`real daily rewrite rechecks midnight after observed ${boundary} wait`, async () => {
 const { f, a, db, principals: p } = await fixture(); let holder, pending;
 try {
  const scope = { coupleId: a, membershipEpoch: 1 }, made = (await createDailyAnswer(db, p[0], proposal(scope), early)).value;
  const locked = await lock(f, boundary === 'pair' ? 'SELECT id FROM couples WHERE id=$1 FOR UPDATE' : 'SELECT id FROM daily_question_answers WHERE id=$1 FOR UPDATE', [boundary === 'pair' ? a : made.answer.id]); holder = locked.holder;
  const state = { bodies: 0 }; let instant = start; const input = { ...command(scope, made.answer), text: 'Must not rewrite tomorrow' };
  pending = rewriteDailyAnswer(observed(db, state), p[0], input, () => new Date(instant)); pending.catch(() => {});
  await observedWait(f, () => state.waiter, locked.locker); instant = tomorrow;
  await unlock(holder); holder = null; const result = await pending; pending = null;
  assert.equal(result.ok, false); bodyFree(result); assert.equal(state.bodies, 0);
  assert.deepEqual((await f.domainPool.query('SELECT version,text FROM daily_question_answers WHERE id=$1', [made.answer.id])).rows, [{ version: 1, text: 'Synthetic private daily answer' }]);
  assert.equal((await f.domainPool.query('SELECT command_id FROM daily_question_commands WHERE command_id=$1', [input.commandId])).rowCount, 0);
 } finally { await cleanup(holder, pending, f); }
});

for (const operation of ['rewrite', 'remove']) for (const boundary of ['expiry', 'clock'])
test(`real daily ${operation} receipt FK wait ${boundary} rolls back metadata/body/receipt`, async () => {
 const { f, a, db, principals: p, usersA } = await fixture(); let holder, pending;
 try {
  const scope = { coupleId: a, membershipEpoch: 1 }, made = (await createDailyAnswer(db, p[0], proposal(scope), early)).value;
  const locked = await lock(f, 'SELECT user_id FROM couple_members WHERE couple_id=$1 AND user_id=$2 FOR UPDATE', [a, usersA[0]]); holder = locked.holder;
  const state = { bodies: 0 }; let instant = start;
  const actor = boundary === 'expiry' ? { ...p[0], tokenExpiresAt: Math.floor(Date.now() / 1000) + 2 } : p[0];
  const input = { ...command(scope, made.answer), ...(operation === 'rewrite' ? { text: 'Never committed' } : {}) };
  pending = (operation === 'rewrite' ? rewriteDailyAnswer : removeDailyAnswer)(observed(db, state), actor, input, () => new Date(instant)); pending.catch(() => {});
  await observedWait(f, () => state.receipt ? state.waiter : null, locked.locker);
  if (boundary === 'expiry') while (Date.now() < actor.tokenExpiresAt * 1000) await delay(10);
  else instant = operation === 'rewrite' ? tomorrow : '2026-11-10T11:59:59.999Z';
  await unlock(holder); holder = null;
  assert.equal((await pending).ok, false); pending = null; assert.equal(state.bodies, 0);
  assert.deepEqual((await f.domainPool.query('SELECT version,text,removed_at FROM daily_question_answers WHERE id=$1', [made.answer.id])).rows, [{ version: 1, text: 'Synthetic private daily answer', removed_at: null }]);
  assert.equal((await f.domainPool.query('SELECT command_id FROM daily_question_commands WHERE command_id=$1', [input.commandId])).rowCount, 0);
 } finally { await cleanup(holder, pending, f); }
});

test('real daily first-slot insertion crossing midnight rolls back zone, slot, answer and command', async () => {
 const { f, a, db, principals: p, usersA } = await fixture(); let holder, pending;
 try {
  const scope = { coupleId: a, membershipEpoch: 1 }, input = proposal(scope);
  const locked = await lock(f, 'SELECT user_id FROM couple_members WHERE couple_id=$1 AND user_id=$2 FOR UPDATE', [a, usersA[0]]); holder = locked.holder;
  const state = { bodies: 0 }; let instant = start;
  pending = createDailyAnswer(observed(db, state), p[0], input, () => new Date(instant)); pending.catch(() => {});
  await observedWait(f, () => state.waiter, locked.locker); instant = tomorrow;
  await unlock(holder); holder = null; assert.equal((await pending).ok, false); pending = null;
  for (const table of ['daily_question_zones', 'daily_question_slots', 'daily_question_answers', 'daily_question_commands']) assert.equal((await f.domainPool.query(`SELECT couple_id FROM ${table} WHERE couple_id=$1`, [a])).rowCount, 0);
 } finally { await cleanup(holder, pending, f); }
});

test('real daily partner read after own removal waits sees canonical tombstone before any body query', async () => {
 const { f, a, db, principals: p } = await fixture(); let holder, pending;
 try {
  const scope = { coupleId: a, membershipEpoch: 1 };
  const own = (await createDailyAnswer(db, p[0], proposal(scope, 'Own witness'), early)).value;
  const partner = (await createDailyAnswer(db, p[1], proposal(scope, 'Partner hidden'), early)).value;
  // Hold the same pair lock used by normal mutations, then commit a terminal removal
  // while the real read is blocked. Its earlier client metadata is not authority.
  const locked = await lock(f, 'SELECT id FROM couples WHERE id=$1 FOR UPDATE', [a]); holder = locked.holder;
  const state = { bodies: 0 };
  pending = readDailyAnswer(observed(db, state), p[0], { ...scope, answerId: partner.answer.id }, early); pending.catch(() => {});
  await observedWait(f, () => state.waiter, locked.locker);
  await holder.query("UPDATE daily_question_answers SET version=version+1,content_state='removed',removed_at=$2,text=NULL WHERE id=$1", [own.answer.id, start]);
  await unlock(holder); holder = null;
  const result = await pending; pending = null; assert.equal(result.ok, true); bodyFree(result); assert.equal(state.bodies, 0);
 } finally { await cleanup(holder, pending, f); }
});

test('real daily partner read provider expiry after answer wait selects no own or partner text', async () => {
 const { f, a, db, principals: p } = await fixture(); let holder, pending;
 try {
  const scope = { coupleId: a, membershipEpoch: 1 };
  await createDailyAnswer(db, p[0], proposal(scope, 'Own witness'), early);
  const partner = (await createDailyAnswer(db, p[1], proposal(scope, 'Partner target'), early)).value;
  await f.authPool.query(`UPDATE "session" SET "expiresAt"=clock_timestamp()+interval '2 seconds' WHERE id=$1`, [p[0].sessionId]);
  const locked = await lock(f, 'SELECT id FROM daily_question_answers WHERE id=$1 FOR UPDATE', [partner.answer.id]); holder = locked.holder;
  const state = { bodies: 0 };
  pending = readDailyAnswer(observed(db, state), p[0], { ...scope, answerId: partner.answer.id }, early); pending.catch(() => {});
  await observedWait(f, () => state.waiter, locked.locker); await delay(2100);
  await unlock(holder); holder = null;
  assert.deepEqual(await pending, { ok: false, error: 'unavailable' }); pending = null; assert.equal(state.bodies, 0);
 } finally { await cleanup(holder, pending, f); }
});

test('real daily revocation after session wait denies slot and answer metadata access', async () => {
 const { f, a, db, principals: p } = await fixture(); let holder, pending;
 try {
  const scope = { coupleId: a, membershipEpoch: 1 }, made = (await createDailyAnswer(db, p[0], proposal(scope), early)).value;
  const locked = await lock(f, 'SELECT id FROM "session" WHERE id=$1 FOR UPDATE', [p[0].sessionId]); holder = locked.holder;
  const state = { bodies: 0, privateQueries: 0 };
  pending = readDailyAnswer(observed(db, state), p[0], { ...scope, answerId: made.answer.id }, early); pending.catch(() => {});
  await observedWait(f, () => state.waiter, locked.locker); await holder.query('DELETE FROM "session" WHERE id=$1', [p[0].sessionId]);
  await unlock(holder); holder = null;
  assert.deepEqual(await pending, { ok: false, error: 'unavailable' }); pending = null; assert.equal(state.bodies, 0); assert.equal(state.privateQueries, 0);
 } finally { await cleanup(holder, pending, f); }
});
