import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCapsule, readCapsule, resealCapsule, listCapsules } from '../../src/capsules.ts';
import { fixture, early, due, created, released, proposal, command, laterSchedule, observed, observedWait, lock, unlock, cleanup, delay, bodyFree } from './capsules-fixture.mjs';

for (const boundary of ['pair', 'row']) for (const operation of ['read', 'reseal'])
 test(`real capsule ${operation} checks deadline after observed ${boundary} lock wait`, async () => {
 const { f, a, db, principals: p } = await fixture(); let holder, pending;
 try {
  const scope = { coupleId: a, membershipEpoch: 1 }, q = (await createCapsule(db, p[0], proposal(scope), early)).value.capsule;
  const locked = await lock(f, boundary === 'pair' ? 'SELECT id FROM couples WHERE id=$1 FOR UPDATE' : 'SELECT id FROM capsules WHERE id=$1 FOR UPDATE', [boundary === 'pair' ? a : q.id]);
  holder = locked.holder; const state = { bodies: 0 }; let featureTime = operation === 'read' ? released : created;
  const input = { ...command(scope, q), text: 'New sealed body', schedule: laterSchedule };
  pending = operation === 'read' ? readCapsule(observed(db, state), p[0], { ...scope, capsuleId: q.id }, () => new Date(featureTime))
   : resealCapsule(observed(db, state), p[0], input, () => new Date(featureTime)); pending.catch(() => {});
  await observedWait(f, () => state.waiter, locked.locker);
  featureTime = operation === 'read' ? created : released;
  await unlock(holder); holder = null;
  const result = await pending; pending = null;
  bodyFree(result); assert.equal(state.bodies, 0);
  if (operation === 'reseal') assert.equal(result.ok, false);
  else assert.equal(result.ok, true);
  assert.deepEqual((await listCapsules(db, p[0], scope, early)).value.capsules, [q]);
  assert.equal((await f.domainPool.query('SELECT command_id FROM capsule_commands WHERE command_id=$1', [input.commandId])).rowCount, 0);
 } finally { await cleanup(holder, pending, f); }
});

for (const boundary of ['expiry', 'clock']) test(`real capsule receipt FK wait: ${boundary} rolls back reseal and receipt`, async () => {
 const { f, a, db, principals: p, usersA } = await fixture(); let holder, pending;
 try {
  const scope = { coupleId: a, membershipEpoch: 1 }, q = (await createCapsule(db, p[0], proposal(scope), early)).value.capsule;
  const locked = await lock(f, 'SELECT user_id FROM couple_members WHERE couple_id=$1 AND user_id=$2 FOR UPDATE', [a, usersA[0]]); holder = locked.holder;
  const state = { bodies: 0 }; let featureTime = created;
  const principal = boundary === 'expiry' ? { ...p[0], tokenExpiresAt: Math.floor(Date.now() / 1000) + 2 } : p[0];
  const input = { ...command(scope, q), text: 'Never committed', schedule: laterSchedule };
  pending = resealCapsule(observed(db, state), principal, input, () => new Date(featureTime)); pending.catch(() => {});
  await observedWait(f, () => state.receipt ? state.waiter : null, locked.locker);
  if (boundary === 'expiry') while (Date.now() < principal.tokenExpiresAt * 1000) await delay(10);
  else featureTime = released;
  await unlock(holder); holder = null;
  const result = await pending; pending = null; assert.equal(result.ok, false); bodyFree(result); assert.equal(state.bodies, 0);
  assert.deepEqual((await listCapsules(db, p[0], scope, early)).value.capsules, [q]);
  assert.equal((await f.domainPool.query('SELECT command_id FROM capsule_commands WHERE command_id=$1', [input.commandId])).rowCount, 0);
  assert.equal((await readCapsule(db, p[0], { ...scope, capsuleId: q.id }, due)).value.text, 'Synthetic private capsule');
 } finally { await cleanup(holder, pending, f); }
});

test('real capsule read checks provider expiry after row lock before body SELECT', async () => {
 const { f, a, db, principals: p } = await fixture(); let holder, pending;
 try {
  const scope = { coupleId: a, membershipEpoch: 1 }, q = (await createCapsule(db, p[0], proposal(scope), early)).value.capsule;
  await f.authPool.query(`UPDATE "session" SET "expiresAt"=clock_timestamp()+interval '2 seconds' WHERE id=$1`, [p[0].sessionId]);
  const locked = await lock(f, 'SELECT id FROM capsules WHERE id=$1 FOR UPDATE', [q.id]); holder = locked.holder;
  const state = { bodies: 0 };
  pending = readCapsule(observed(db, state), p[0], { ...scope, capsuleId: q.id }, due); pending.catch(() => {});
  await observedWait(f, () => state.waiter, locked.locker); await delay(2100);
  assert.equal((await f.authPool.query('SELECT "expiresAt"<=clock_timestamp() expired FROM "session" WHERE id=$1', [p[0].sessionId])).rows[0].expired, true);
  await unlock(holder); holder = null;
  assert.deepEqual(await pending, { ok: false, error: 'unavailable' }); pending = null; assert.equal(state.bodies, 0);
 } finally { await cleanup(holder, pending, f); }
});

test('real capsule session revocation after observed session wait denies all capsule queries', async () => {
 const { f, a, db, principals: p } = await fixture(); let holder, pending;
 try {
  const scope = { coupleId: a, membershipEpoch: 1 }, q = (await createCapsule(db, p[0], proposal(scope), early)).value.capsule;
  const locked = await lock(f, 'SELECT id FROM "session" WHERE id=$1 FOR UPDATE', [p[0].sessionId]); holder = locked.holder;
  const state = { bodies: 0, privateQueries: 0 };
  pending = readCapsule(observed(db, state), p[0], { ...scope, capsuleId: q.id }, due); pending.catch(() => {});
  await observedWait(f, () => state.waiter, locked.locker);
  await holder.query('DELETE FROM "session" WHERE id=$1', [p[0].sessionId]);
  await unlock(holder); holder = null;
  assert.deepEqual(await pending, { ok: false, error: 'unavailable' }); pending = null;
  assert.equal(state.bodies, 0); assert.equal(state.privateQueries, 0);
 } finally { await cleanup(holder, pending, f); }
});

test('real capsule creation rechecks tomorrow after pair lock wait', async () => {
 const { f, a, db, principals: p } = await fixture(); let holder, pending;
 try {
  const scope = { coupleId: a, membershipEpoch: 1 }, input = proposal(scope);
  const locked = await lock(f, 'SELECT id FROM couples WHERE id=$1 FOR UPDATE', [a]); holder = locked.holder;
  const state = { bodies: 0 }; let featureTime = created;
  pending = createCapsule(observed(db, state), p[0], input, () => new Date(featureTime)); pending.catch(() => {});
  await observedWait(f, () => state.waiter, locked.locker); featureTime = '2026-11-15T21:00:00.000Z';
  await unlock(holder); holder = null;
  assert.deepEqual(await pending, { ok: false, error: 'invalid_request' }); pending = null;
  assert.equal((await f.domainPool.query('SELECT id FROM capsules WHERE couple_id=$1', [a])).rowCount, 0);
  assert.equal((await f.domainPool.query('SELECT command_id FROM capsule_commands WHERE command_id=$1', [input.commandId])).rowCount, 0);
 } finally { await cleanup(holder, pending, f); }
});

test('real capsule token expiry after observed pair wait denies sealed metadata and body', async () => {
 const { f, a, db, principals: p } = await fixture(); let holder, pending;
 try {
  const scope = { coupleId: a, membershipEpoch: 1 }, q = (await createCapsule(db, p[0], proposal(scope), early)).value.capsule;
  const locked = await lock(f, 'SELECT id FROM couples WHERE id=$1 FOR UPDATE', [a]); holder = locked.holder;
  const state = { bodies: 0, privateQueries: 0 }, principal = { ...p[0], tokenExpiresAt: Math.floor(Date.now() / 1000) + 2 };
  pending = readCapsule(observed(db, state), principal, { ...scope, capsuleId: q.id }, due); pending.catch(() => {});
  await observedWait(f, () => state.waiter, locked.locker);
  while (Date.now() < principal.tokenExpiresAt * 1000) await delay(10);
  await unlock(holder); holder = null;
  assert.deepEqual(await pending, { ok: false, error: 'unavailable' }); pending = null;
  assert.equal(state.bodies, 0); assert.equal(state.privateQueries, 0);
 } finally { await cleanup(holder, pending, f); }
});

for (const boundary of ['pair', 'row']) test(`real capsule read opens only on refreshed due clock after ${boundary} wait`, async () => {
 const { f, a, db, principals: p } = await fixture(); let holder, pending;
 try {
  const scope = { coupleId: a, membershipEpoch: 1 }, q = (await createCapsule(db, p[0], proposal(scope), early)).value.capsule;
  const locked = await lock(f, boundary === 'pair' ? 'SELECT id FROM couples WHERE id=$1 FOR UPDATE' : 'SELECT id FROM capsules WHERE id=$1 FOR UPDATE', [boundary === 'pair' ? a : q.id]); holder = locked.holder;
  const state = { bodies: 0 }; let featureTime = created;
  pending = readCapsule(observed(db, state), p[0], { ...scope, capsuleId: q.id }, () => new Date(featureTime)); pending.catch(() => {});
  await observedWait(f, () => state.waiter, locked.locker); assert.equal(state.bodies, 0); featureTime = released;
  await unlock(holder); holder = null;
  const result = await pending; pending = null;
  assert.equal(result.value.text, 'Synthetic private capsule'); assert.equal(result.value.checkedAt, released); assert.equal(state.bodies, 1);
 } finally { await cleanup(holder, pending, f); }
});
