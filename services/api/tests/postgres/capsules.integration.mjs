import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createCapsule, listCapsules, readCapsule, resealCapsule, removeCapsule } from '../../src/capsules.ts';
import { pairAgain } from './pair-leave-fixture.mjs';
import { leavePair } from '../../src/pair-leave.ts';
import { fixture, early, due, proposal, command, laterSchedule, observed, bodyFree } from './capsules-fixture.mjs';

test('real capsules: owner-only metadata, sealed body, exact release, duplicate retry and current body-free replay', async () => {
 const { f, a, b, db, principals: p } = await fixture();
 try {
  const scope = { coupleId: a, membershipEpoch: 1 }, input = proposal(scope, '🦉'.repeat(2000));
  const duplicates = await Promise.all(Array.from({ length: 4 }, () => createCapsule(db, p[0], input, early)));
  assert.equal(duplicates.every(r => r.ok), true); assert.equal(duplicates.filter(r => !r.value.replay).length, 1);
  let q = duplicates[0].value.capsule;
  duplicates.forEach(bodyFree);
  const detail = { ...scope, capsuleId: q.id }, state = { bodies: 0 }, tracked = observed(db, state);
  const ownerList = await listCapsules(tracked, p[0], scope, early);
  assert.deepEqual(ownerList.value.capsules, [q]); assert.equal(ownerList.value.used, 1); assert.equal(ownerList.value.capacity, 1); bodyFree(ownerList);
  const partnerList = await listCapsules(tracked, p[1], scope, due);
  assert.deepEqual(partnerList.value.capsules, []); assert.equal(partnerList.value.used, 0); bodyFree(partnerList);
  for (const principal of [p[1], p[2]]) assert.equal((await readCapsule(tracked, principal, detail, due)).error, 'unavailable');
  const before = await readCapsule(tracked, p[0], detail, () => new Date('2026-11-16T05:59:59.999Z'));
  bodyFree(before); assert.equal(state.bodies, 0);
  assert.equal((await readCapsule(tracked, p[0], detail, due)).value.text, input.text); assert.equal(state.bodies, 1);
  assert.equal((await listCapsules(db, p[0], { ...scope, coupleId: b }, due)).error, 'unavailable');
  assert.equal((await listCapsules(db, p[0], { ...scope, membershipEpoch: 2 }, due)).error, 'stale_membership');
  assert.equal((await createCapsule(db, p[0], { ...input, text: 'Different' }, early)).error, 'idempotency_conflict');
  for (const mutate of [resealCapsule, removeCapsule]) {
   assert.equal((await mutate(db, p[1], (mutate === resealCapsule ? { ...command(scope, q), text: 'Foreign', schedule: laterSchedule } : command(scope, q)), early)).error, 'unavailable');
  }
  const replacement = { ...command(scope, q), text: 'Synthetic replacement', schedule: laterSchedule };
  const resealed = await resealCapsule(db, p[0], replacement, early); assert.equal(resealed.ok, true); q = resealed.value.capsule; bodyFree(resealed);
  const replay = await createCapsule(db, p[0], input, early);
  assert.equal(replay.value.replay, true); assert.deepEqual(replay.value.capsule, q); bodyFree(replay);
  bodyFree(await readCapsule(db, p[0], detail, due));
  assert.equal((await readCapsule(db, p[0], detail, () => new Date(q.releaseAt))).value.text, replacement.text);
  const removed = await removeCapsule(db, p[0], command(scope, q), due); assert.equal(removed.ok, true); bodyFree(removed);
  for (const result of [await createCapsule(db, p[0], input, early), await resealCapsule(db, p[0], replacement, early)]) {
   assert.equal(result.value.replay, true); assert.deepEqual(result.value.capsule, removed.value.capsule); bodyFree(result);
  }
  state.bodies = 0; bodyFree(await readCapsule(tracked, p[0], detail, () => new Date('2026-12-01'))); assert.equal(state.bodies, 0);
  assert.equal((await f.domainPool.query('SELECT body FROM capsules WHERE id=$1', [q.id])).rows[0].body, null);
  assert.equal((await createCapsule(db, p[0], proposal(scope), early)).error, 'capacity_reached');
  assert.equal((await resealCapsule(db, p[0], { ...command(scope, removed.value.capsule), text: 'Resurrection', schedule: laterSchedule }, early)).error, 'version_conflict');
  await assert.rejects(f.domainPool.query('DELETE FROM capsules WHERE id=$1', [q.id]), { code: '23514' });
  await assert.rejects(f.domainPool.query('UPDATE capsule_commands SET fingerprint=fingerprint'), { code: '23514' });
  await assert.rejects(f.domainPool.query('DELETE FROM capsule_commands'), { code: '23514' });
  assert.equal((await leavePair(db, p[1], { ...scope, commandId: randomUUID(), confirm: true })).ok, true);
  assert.equal((await listCapsules(db, p[0], scope, due)).error, 'unavailable');
  assert.equal((await createCapsule(db, p[0], input, early)).error, 'unavailable');
 } finally { await f.close(); }
});

test('real capsules: concurrent singleton creates, independent author capacity, CAS reseal/remove and receipt ownership', async () => {
 const { f, a, db, principals: p, usersA } = await fixture();
 try {
  const scope = { coupleId: a, membershipEpoch: 1 };
  const results = await Promise.all([createCapsule(db, p[0], proposal(scope, 'A'), early), createCapsule(db, p[0], proposal(scope, 'B'), early)]);
  assert.equal(results.filter(r => r.ok).length, 1); assert.equal(results.find(r => !r.ok).error, 'capacity_reached');
  const q = results.find(r => r.ok).value.capsule;
  assert.equal((await createCapsule(db, p[1], proposal(scope, 'Partner personal'), early)).ok, true);
  assert.equal((await listCapsules(db, p[0], scope, due)).value.capsules.length, 1);
  assert.equal((await listCapsules(db, p[1], scope, due)).value.capsules.length, 1);
  const outcomes = await Promise.all([
   resealCapsule(db, p[0], { ...command(scope, q), text: 'New', schedule: laterSchedule }, early),
   removeCapsule(db, p[0], command(scope, q), early)
  ]);
  assert.equal(outcomes.filter(r => r.ok).length, 1); assert.equal(outcomes.find(r => !r.ok).error, 'version_conflict');
  const current = outcomes.find(r => r.ok).value.capsule;
  await assert.rejects(f.domainPool.query(`INSERT INTO capsule_commands(actor_user_id,command_id,couple_id,membership_epoch,capsule_id,fingerprint,operation,expected_version,applied)
   VALUES($1,$2,$3,1,$4,$5,'create',NULL,$6)`, [usersA[1], randomUUID(), a, q.id, 'a'.repeat(64), current]), { code: '23514' });
  await assert.rejects(f.domainPool.query('UPDATE capsules SET author_id=$1,version=version+1 WHERE id=$2', [usersA[1], q.id]), { code: '23514' });
  const receipts = (await f.domainPool.query('SELECT applied FROM capsule_commands')).rows;
  receipts.forEach(bodyFree);
 } finally { await f.close(); }
});


test('real capsules: closed epoch and old command cannot cross to replacement pair', async () => {
 const { f, a, db, principals: p, usersA } = await fixture();
 try {
  const scope = { coupleId: a, membershipEpoch: 1 }, input = proposal(scope);
  const q = (await createCapsule(db, p[0], input, early)).value.capsule;
  assert.equal((await leavePair(db, p[1], { ...scope, commandId: randomUUID(), confirm: true })).ok, true);
  const pair = await pairAgain(f, usersA), freshScope = { coupleId: pair, membershipEpoch: 1 };
  assert.equal((await createCapsule(db, p[0], input, early)).error, 'unavailable');
  assert.equal((await readCapsule(db, p[0], { ...scope, capsuleId: q.id }, due)).error, 'unavailable');
  assert.equal((await createCapsule(db, p[0], { ...input, ...freshScope }, early)).error, 'idempotency_conflict');
  assert.equal((await readCapsule(db, p[0], { ...freshScope, capsuleId: q.id }, due)).error, 'unavailable');
  assert.deepEqual((await listCapsules(db, p[0], freshScope, due)).value.capsules, []);
  assert.equal((await createCapsule(db, p[0], proposal(freshScope), early)).ok, true);
  assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM capsules')).rows[0].n, 2);
 } finally { await f.close(); }
});
