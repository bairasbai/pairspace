import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDispute, readDispute, joinDispute, resolveDispute, removeDispute, listDisputes } from '../../src/disputes.ts';
import { fixture, early, due, created, released, proposal, command, observed, observedWait, lock, unlock, cleanup, delay, bodyFree } from './disputes-fixture.mjs';

for (const boundary of ['pair', 'row']) test(`real dispute join cannot cross local due during observed ${boundary} lock wait`, async () => {
  const { f, a, db, principals: p } = await fixture(); let holder, pending;
  try {
    const scope = { coupleId: a, membershipEpoch: 1 }, q = (await createDispute(db, p[0], proposal(scope), early)).value.dispute;
    const locked = await lock(f, boundary === 'pair' ? 'SELECT id FROM couples WHERE id=$1 FOR UPDATE' : 'SELECT id FROM disputes WHERE id=$1 FOR UPDATE', [boundary === 'pair' ? a : q.id]); holder = locked.holder;
    const state = { bodies: 0 }; let instant = created; const input = command(scope, q);
    pending = joinDispute(observed(db, state), p[1], input, () => new Date(instant)); pending.catch(() => {});
    await observedWait(f, () => state.waiter, locked.locker); instant = released;
    await unlock(holder); holder = null;
    const result = await pending; pending = null; assert.equal(result.ok, false); bodyFree(result); assert.equal(state.bodies, 0);
    assert.deepEqual((await listDisputes(db, p[0], scope, due)).value.disputes, [q]);
    assert.equal((await f.domainPool.query('SELECT command_id FROM dispute_commands WHERE command_id=$1', [input.commandId])).rowCount, 0);
  } finally { await cleanup(holder, pending, f); }
});

for (const boundary of ['expiry', 'clock']) test(`real dispute join receipt FK wait ${boundary} rolls back joined event and receipt`, async () => {
  const { f, a, db, principals: p, usersA } = await fixture(); let holder, pending;
  try {
    const scope = { coupleId: a, membershipEpoch: 1 }, q = (await createDispute(db, p[0], proposal(scope), early)).value.dispute;
    const locked = await lock(f, 'SELECT user_id FROM couple_members WHERE couple_id=$1 AND user_id=$2 FOR UPDATE', [a, usersA[1]]); holder = locked.holder;
    const state = { bodies: 0 }; let instant = created;
    const principal = boundary === 'expiry' ? { ...p[1], tokenExpiresAt: Math.floor(Date.now() / 1000) + 2 } : p[1];
    const input = command(scope, q);
    pending = joinDispute(observed(db, state), principal, input, () => new Date(instant)); pending.catch(() => {});
    await observedWait(f, () => state.receipt ? state.waiter : null, locked.locker);
    if (boundary === 'expiry') while (Date.now() < principal.tokenExpiresAt * 1000) await delay(10);
    else instant = released;
    await unlock(holder); holder = null;
    assert.deepEqual(await pending, { ok: false, error: 'unavailable' }); pending = null; assert.equal(state.bodies, 0);
    assert.deepEqual((await listDisputes(db, p[0], scope, due)).value.disputes, [q]);
    assert.equal((await f.domainPool.query('SELECT command_id FROM dispute_commands WHERE command_id=$1', [input.commandId])).rowCount, 0);
  } finally { await cleanup(holder, pending, f); }
});

for (const operation of ['resolve', 'remove']) test(`real dispute late clock rollback reverses ${operation} plus receipt after FK wait`, async () => {
  const { f, a, db, principals: p, usersA } = await fixture(); let holder, pending;
  try {
    const scope = { coupleId: a, membershipEpoch: 1 }; let q = (await createDispute(db, p[0], proposal(scope), early)).value.dispute;
    q = (await joinDispute(db, p[1], command(scope, q), early)).value.dispute;
    const locked = await lock(f, 'SELECT user_id FROM couple_members WHERE couple_id=$1 AND user_id=$2 FOR UPDATE', [a, usersA[0]]); holder = locked.holder;
    const state = { bodies: 0 }; let instant = released;
    const input = operation === 'resolve' ? { ...command(scope, q), winnerId: null } : command(scope, q);
    pending = (operation === 'resolve' ? resolveDispute : removeDispute)(observed(db, state), p[0], input, () => new Date(instant)); pending.catch(() => {});
    await observedWait(f, () => state.receipt ? state.waiter : null, locked.locker); instant = created;
    await unlock(holder); holder = null;
    assert.deepEqual(await pending, { ok: false, error: 'unavailable' }); pending = null;
    assert.deepEqual((await listDisputes(db, p[0], scope, due)).value.disputes, [q]);
    assert.equal((await readDispute(db, p[0], { ...scope, disputeId: q.id }, due)).value.claim, 'Synthetic disputed claim');
    assert.equal((await f.domainPool.query('SELECT command_id FROM dispute_commands WHERE command_id=$1', [input.commandId])).rowCount, 0);
  } finally { await cleanup(holder, pending, f); }
});

test('real dispute creation rechecks future date after insert FK wait', async () => {
  const { f, a, db, principals: p, usersA } = await fixture(); let holder, pending;
  try {
    const scope = { coupleId: a, membershipEpoch: 1 }, input = proposal(scope);
    const locked = await lock(f, 'SELECT user_id FROM couple_members WHERE couple_id=$1 AND user_id=$2 FOR UPDATE', [a, usersA[0]]); holder = locked.holder;
    const state = { bodies: 0 }; let instant = created;
    pending = createDispute(observed(db, state), p[0], input, () => new Date(instant)); pending.catch(() => {});
    await observedWait(f, () => state.waiter, locked.locker); instant = released;
    await unlock(holder); holder = null;
    assert.deepEqual(await pending, { ok: false, error: 'unavailable' }); pending = null;
    assert.equal((await f.domainPool.query('SELECT id FROM disputes WHERE couple_id=$1', [a])).rowCount, 0);
    assert.equal((await f.domainPool.query('SELECT command_id FROM dispute_commands WHERE command_id=$1', [input.commandId])).rowCount, 0);
  } finally { await cleanup(holder, pending, f); }
});

test('real dispute read rechecks provider expiry after row wait before selecting either text', async () => {
  const { f, a, db, principals: p } = await fixture(); let holder, pending;
  try {
    const scope = { coupleId: a, membershipEpoch: 1 }, q = (await createDispute(db, p[0], proposal(scope), early)).value.dispute;
    await f.authPool.query(`UPDATE "session" SET "expiresAt"=clock_timestamp()+interval '2 seconds' WHERE id=$1`, [p[1].sessionId]);
    const locked = await lock(f, 'SELECT id FROM disputes WHERE id=$1 FOR UPDATE', [q.id]); holder = locked.holder;
    const state = { bodies: 0 };
    pending = readDispute(observed(db, state), p[1], { ...scope, disputeId: q.id }, early); pending.catch(() => {});
    await observedWait(f, () => state.waiter, locked.locker); await delay(2100);
    assert.equal((await f.authPool.query('SELECT "expiresAt"<=clock_timestamp() expired FROM "session" WHERE id=$1', [p[1].sessionId])).rows[0].expired, true);
    await unlock(holder); holder = null;
    assert.deepEqual(await pending, { ok: false, error: 'unavailable' }); pending = null; assert.equal(state.bodies, 0);
  } finally { await cleanup(holder, pending, f); }
});

test('real dispute session revocation after observed session wait denies metadata queries', async () => {
  const { f, a, db, principals: p } = await fixture(); let holder, pending;
  try {
    const scope = { coupleId: a, membershipEpoch: 1 };
    const locked = await lock(f, 'SELECT id FROM "session" WHERE id=$1 FOR UPDATE', [p[0].sessionId]); holder = locked.holder;
    const state = { bodies: 0, privateQueries: 0 };
    pending = listDisputes(observed(db, state), p[0], scope, early); pending.catch(() => {});
    await observedWait(f, () => state.waiter, locked.locker);
    await holder.query('DELETE FROM "session" WHERE id=$1', [p[0].sessionId]); await unlock(holder); holder = null;
    assert.deepEqual(await pending, { ok: false, error: 'unavailable' }); pending = null;
    assert.equal(state.bodies, 0); assert.equal(state.privateQueries, 0);
  } finally { await cleanup(holder, pending, f); }
});

test('real dispute token expiry after observed pair wait denies all private metadata', async () => {
  const { f, a, db, principals: p } = await fixture(); let holder, pending;
  try {
    const scope = { coupleId: a, membershipEpoch: 1 }, state = { bodies: 0, privateQueries: 0 };
    const principal = { ...p[0], tokenExpiresAt: Math.floor(Date.now() / 1000) + 2 };
    const locked = await lock(f, 'SELECT id FROM couples WHERE id=$1 FOR UPDATE', [a]); holder = locked.holder;
    pending = listDisputes(observed(db, state), principal, scope, early); pending.catch(() => {});
    await observedWait(f, () => state.waiter, locked.locker);
    while (Date.now() < principal.tokenExpiresAt * 1000) await delay(10);
    await unlock(holder); holder = null;
    assert.deepEqual(await pending, { ok: false, error: 'unavailable' }); pending = null; assert.equal(state.privateQueries, 0);
  } finally { await cleanup(holder, pending, f); }
});

test('real dispute pair closes during observed pair wait and denies all private projections', async () => {
  const { f, a, db, principals: p } = await fixture(); let holder, pending;
  try {
    const scope = { coupleId: a, membershipEpoch: 1 }, input = proposal(scope);
    const q = (await createDispute(db, p[0], input, early)).value.dispute;
    const locked = await lock(f, 'SELECT id FROM couples WHERE id=$1 FOR UPDATE', [a]); holder = locked.holder;
    const state = { bodies: 0, privateQueries: 0 };
    pending = readDispute(observed(db, state), p[1], { ...scope, disputeId: q.id }, early); pending.catch(() => {});
    await observedWait(f, () => state.waiter, locked.locker);
    await holder.query("UPDATE couples SET status='closed',membership_epoch=membership_epoch+1 WHERE id=$1", [a]);
    await holder.query("UPDATE couple_members SET status='revoked' WHERE couple_id=$1", [a]);
    await unlock(holder); holder = null;
    assert.deepEqual(await pending, { ok: false, error: 'unavailable' }); pending = null;
    assert.equal(state.bodies, 0); assert.equal(state.privateQueries, 0);
    assert.equal((await f.domainPool.query('SELECT claim FROM disputes WHERE id=$1', [q.id])).rows[0].claim, input.claim);
  } finally { await cleanup(holder, pending, f); }
});
