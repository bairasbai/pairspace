import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDispute, listDisputes, readDispute, joinDispute, declineDispute, resolveDispute, removeDispute } from '../../src/disputes.ts';
import { pairAgain } from './pair-leave-fixture.mjs';
import { leavePair } from '../../src/pair-leave.ts';
import { fixture, early, due, proposal, command, observed, bodyFree } from './disputes-fixture.mjs';

test('real disputes: duplicate creation, shared private terms, current metadata replay and terminal body erasure', async () => {
  const { f, a, b, db, principals: p } = await fixture();
  try {
    const scope = { coupleId: a, membershipEpoch: 1 }, input = proposal(scope, '🦉'.repeat(2000));
    const results = await Promise.all(Array.from({ length: 4 }, () => createDispute(db, p[0], input, early)));
    assert.equal(results.every(r => r.ok), true); assert.equal(results.filter(r => !r.value.replay).length, 1); results.forEach(bodyFree);
    let q = results[0].value.dispute;
    const detail = { ...scope, disputeId: q.id }, state = { bodies: 0 }, tracked = observed(db, state);
    for (const actor of [p[0], p[1]]) {
      const list = await listDisputes(tracked, actor, scope, early); bodyFree(list);
      assert.deepEqual(list.value.disputes, [q]); assert.equal(list.value.used, 1); assert.equal(list.value.capacity, 100);
    }
    assert.equal(state.bodies, 0);
    for (const actor of [p[0], p[1]]) {
      const read = await readDispute(tracked, actor, detail, early);
      assert.equal(read.value.claim, input.claim); assert.equal(read.value.condition, input.condition);
    }
    assert.equal(state.bodies, 2);
    assert.equal((await readDispute(db, p[2], detail, due)).error, 'unavailable');
    assert.equal((await listDisputes(db, p[0], { ...scope, coupleId: b }, due)).error, 'unavailable');
    assert.equal((await listDisputes(db, p[0], { ...scope, membershipEpoch: 2 }, due)).error, 'stale_membership');
    assert.equal((await createDispute(db, p[0], { ...input, condition: null }, early)).error, 'idempotency_conflict');
    assert.equal((await joinDispute(db, p[0], command(scope, q), early)).error, 'unavailable');
    const joining = command(scope, q), joined = await joinDispute(db, p[1], joining, early);
    assert.equal(joined.ok, true); bodyFree(joined); q = joined.value.dispute;
    const resolution = { ...command(scope, q), winnerId: null };
    assert.equal((await resolveDispute(db, p[0], resolution, early)).ok, false);
    const resolved = await resolveDispute(db, p[0], resolution, due);
    assert.equal(resolved.ok, true); bodyFree(resolved); q = resolved.value.dispute;
    assert.equal(q.decisionState, 'resolved'); assert.equal(q.winnerId, null); assert.equal(q.resolvedBy, p[0].userId);
    assert.equal((await declineDispute(db, p[1], command(scope, q), due)).error, 'version_conflict');
    assert.equal((await removeDispute(db, p[1], command(scope, q), due)).error, 'unavailable');
    const removed = await removeDispute(db, p[0], command(scope, q), due);
    assert.equal(removed.ok, true); bodyFree(removed);
    for (const replay of [await createDispute(db, p[0], input, due), await joinDispute(db, p[1], joining, due), await resolveDispute(db, p[0], resolution, due)]) {
      assert.equal(replay.value.replay, true); assert.deepEqual(replay.value.dispute, removed.value.dispute); bodyFree(replay);
    }
    state.bodies = 0;
    for (const actor of [p[0], p[1]]) bodyFree(await readDispute(tracked, actor, detail, due));
    assert.equal(state.bodies, 0);
    assert.deepEqual((await f.domainPool.query('SELECT claim,condition FROM disputes WHERE id=$1', [q.id])).rows, [{ claim: null, condition: null }]);
    (await f.domainPool.query('SELECT applied FROM dispute_commands')).rows.forEach(bodyFree);
    await assert.rejects(f.domainPool.query('DELETE FROM disputes WHERE id=$1', [q.id]), { code: '23514' });
    await assert.rejects(f.domainPool.query('UPDATE dispute_commands SET fingerprint=fingerprint'), { code: '23514' });
    await assert.rejects(f.domainPool.query('DELETE FROM dispute_commands'), { code: '23514' });
  } finally { await f.close(); }
});

for (const other of ['decline', 'remove']) test(`real dispute CAS serializes verdict versus ${other}`, async () => {
  const { f, a, db, principals: p } = await fixture();
  try {
    const scope = { coupleId: a, membershipEpoch: 1 };
    let q = (await createDispute(db, p[0], proposal(scope), early)).value.dispute;
    q = (await joinDispute(db, p[1], command(scope, q), early)).value.dispute;
    const resolve = { ...command(scope, q), winnerId: p[1].userId }, alternate = command(scope, q);
    const outcomes = await Promise.all([resolveDispute(db, p[0], resolve, due),
      other === 'decline' ? declineDispute(db, p[1], alternate, due) : removeDispute(db, p[0], alternate, due)]);
    assert.equal(outcomes.filter(r => r.ok).length, 1);
    assert.equal(outcomes.find(r => !r.ok).error, 'version_conflict'); outcomes.forEach(bodyFree);
    const current = (await listDisputes(db, p[0], scope, due)).value.disputes[0];
    assert.equal(current.version, 3);
    if (current.decisionState === 'declined') { assert.equal(current.winnerId, null); assert.equal(current.resolvedAt, null); }
    if (current.contentState === 'removed') assert.equal(current.resolvedAt, null);
    const winner = outcomes[0].ok ? resolve : alternate;
    assert.equal((await f.domainPool.query('SELECT command_id FROM dispute_commands WHERE command_id=ANY($1::uuid[])', [[resolve.commandId, alternate.commandId]])).rowCount, 1);
    assert.equal((await f.domainPool.query('SELECT command_id FROM dispute_commands WHERE command_id=$1', [winner.commandId])).rowCount, 1);
  } finally { await f.close(); }
});

test('real dispute leave and replacement epoch deny old resources/receipts without erasing retained terms', async () => {
  const { f, a, db, principals: p, usersA } = await fixture();
  try {
    const scope = { coupleId: a, membershipEpoch: 1 }, input = proposal(scope);
    const q = (await createDispute(db, p[0], input, early)).value.dispute;
    assert.equal((await leavePair(db, p[1], { ...scope, commandId: randomUUID(), confirm: true })).ok, true);
    const pair = await pairAgain(f, usersA), fresh = { coupleId: pair, membershipEpoch: 1 };
    assert.equal((await createDispute(db, p[0], input, early)).error, 'unavailable');
    assert.equal((await readDispute(db, p[0], { ...fresh, disputeId: q.id }, due)).error, 'unavailable');
    assert.equal((await createDispute(db, p[0], { ...input, ...fresh }, early)).error, 'idempotency_conflict');
    assert.deepEqual((await listDisputes(db, p[0], fresh, due)).value.disputes, []);
    assert.equal((await f.domainPool.query('SELECT claim FROM disputes WHERE id=$1', [q.id])).rows[0].claim, input.claim);
  } finally { await f.close(); }
});

test('real dispute shared lifetime capacity100 serializes final creates and retains tombstones', async () => {
  const { f, a, db, principals: p } = await fixture();
  try {
    const scope = { coupleId: a, membershipEpoch: 1 }, firstInput = proposal(scope);
    const first = await createDispute(db, p[0], firstInput, early); assert.equal(first.ok, true);
    for (let n = 1; n < 99; n++) assert.equal((await createDispute(db, p[n % 2], proposal(scope), early)).ok, true);
    const outcomes = await Promise.all([createDispute(db, p[0], proposal(scope), early), createDispute(db, p[1], proposal(scope), early)]);
    assert.equal(outcomes.filter(r => r.ok).length, 1); assert.equal(outcomes.find(r => !r.ok).error, 'capacity_reached');
    await removeDispute(db, p[0], command(scope, first.value.dispute), early);
    const list = await listDisputes(db, p[1], scope, due); assert.equal(list.value.used, 100); assert.equal(list.value.disputes.length, 100); bodyFree(list);
    assert.equal((await createDispute(db, p[0], proposal(scope), early)).error, 'capacity_reached');
    const replay = await createDispute(db, p[0], firstInput, due); assert.equal(replay.value.replay, true);
    assert.equal(replay.value.dispute.contentState, 'removed'); bodyFree(replay);
  } finally { await f.close(); }
});
