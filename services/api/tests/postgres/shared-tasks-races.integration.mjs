import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { tasksFixture } from './shared-tasks-fixture.mjs';
import { createSharedTask, changeSharedTask, listSharedTasks } from '../../src/shared-tasks.ts';
import { leaveHarness, assertClosed, pairAgain } from './pair-leave-fixture.mjs';
import { observedDatabase } from './invitation-fixture.mjs';
import { gate, waitForQueryLock } from './profile-fixture.mjs';
import { observeTask, barrierOrCompletion, settleBounded } from './async-bounds.mjs';

const scope = x => ({ coupleId: x.pairA, membershipEpoch: 1 });
const createCommand = x => ({ ...scope(x), commandId: randomUUID(), title: 'Synthetic race task' });
const leaveCommand = x => ({ ...scope(x), commandId: randomUUID(), confirm: true });
const changed = (x, task, operation = 'complete') => ({ ...scope(x), commandId: randomUUID(), taskId: task.id,
  operation, expectedVersion: task.version });

for (const firstOperation of ['leave', 'create', 'change', 'list']) {
  test(`shared tasks PostgreSQL: ${firstOperation} first serializes with leave and denies closed resources`, async () => {
    const x = await tasksFixture(); const barrier = gate(); const pending = []; let server; let held = false;
    try {
      const db = x.f.database(); const principal = await x.principal(0); const partner = await x.principal(1);
      const original = await createSharedTask(db, principal, createCommand(x)); assert.equal(original.ok, true);
      const command = createCommand(x); const transition = changed(x, original.value.task);
      const observer = async sql => {
        if (!held && sql.includes('FROM couples') && /FOR (UPDATE|SHARE)/.test(sql)) { held = true; await barrier.hook(); }
      };
      const traced = { ...db, transaction: work => db.transaction(tx => work({ query: async (sql, params) => {
        const result = await tx.query(sql, params); await observer(sql); return result;
      } })) };
      server = await leaveHarness(x.f, { db: firstOperation === 'leave' ? observedDatabase(x.f, observer) : undefined });
      const cookie = await x.connections[0].getCookie();
      const first = observeTask(firstOperation === 'leave' ? server.request(cookie, leaveCommand(x))
        : firstOperation === 'create' ? createSharedTask(traced, partner, command)
          : firstOperation === 'change' ? changeSharedTask(traced, partner, transition) : listSharedTasks(traced, partner, scope(x)));
      pending.push(first); await barrierOrCompletion(barrier.ready, first);
      const second = observeTask(firstOperation === 'leave' ? changeSharedTask(db, partner, transition)
        : server.request(cookie, leaveCommand(x))); pending.push(second);
      await waitForQueryLock(x.f, '%FROM users%FOR %'); barrier.release();
      const [a, b] = await Promise.all(pending);
      assert.equal(firstOperation === 'leave' ? a.status : b.status, 200);
      assert.equal(firstOperation === 'leave' ? b.ok : a.ok, firstOperation !== 'leave');
      await assertClosed(x.f, x.pairA);
      assert.deepEqual(await createSharedTask(db, principal, command), { ok: false, error: 'unavailable' });
      assert.deepEqual(await changeSharedTask(db, principal, transition), { ok: false, error: 'unavailable' });
      assert.deepEqual(await listSharedTasks(db, partner, scope(x)), { ok: false, error: 'unavailable' });
    } finally { barrier.release(); await settleBounded(pending); await server?.close(); await x.f.close(); }
  });
}

test('shared tasks PostgreSQL: create, exact replay, change and list recheck expired session after pair lock wait', async () => {
  const x = await tasksFixture(); let held; const pending = [];
  try {
    const db = x.f.database(); const principal = await x.principal(0); const partner = await x.principal(1);
    const command = createCommand(x); const created = await createSharedTask(db, principal, command); assert.equal(created.ok, true);
    await x.f.domainPool.query('UPDATE "session" SET "expiresAt"=clock_timestamp()+interval \'1 second\' WHERE id=ANY($1)', [[principal.sessionId, partner.sessionId]]);
    held = await x.f.domainPool.connect(); await held.query('BEGIN');
    await held.query('SELECT id FROM couples WHERE id=$1 FOR UPDATE', [x.pairA]);
    pending.push(observeTask(createSharedTask(db, principal, command)),
      observeTask(createSharedTask(db, principal, createCommand(x))),
      observeTask(changeSharedTask(db, partner, changed(x, created.value.task))),
      observeTask(listSharedTasks(db, partner, scope(x))));
    await waitForQueryLock(x.f, '%FROM couples%FOR %');
    await new Promise(resolve => setTimeout(resolve, 1200));
    await held.query('COMMIT'); held.release(); held = null;
    for (const result of await Promise.all(pending)) assert.deepEqual(result, { ok: false, error: 'unavailable' });
    assert.equal((await x.f.domainPool.query('SELECT count(*)::int AS n FROM shared_tasks')).rows[0].n, 1);
    assert.equal((await x.f.domainPool.query('SELECT version FROM shared_tasks')).rows[0].version, 1);
  } finally { if (held) { await held.query('ROLLBACK'); held.release(); } await settleBounded(pending); await x.f.close(); }
});

test('shared tasks PostgreSQL: old command cannot cross to a new pair; old resource remains isolated', async () => {
  const x = await tasksFixture();
  try {
    const db = x.f.database(); const principal = await x.principal(0); const partner = await x.principal(1);
    const command = createCommand(x); const created = await createSharedTask(db, principal, command); assert.equal(created.ok, true);
    const complete = changed(x, created.value.task); assert.equal((await changeSharedTask(db, principal, complete)).ok, true);
    assert.equal((await x.leave(1)).status, 200);
    const pair = await pairAgain(x.f, x.usersA);
    assert.deepEqual(await createSharedTask(db, principal, { ...command, coupleId: pair }), { ok: false, error: 'idempotency_conflict' });
    assert.deepEqual(await changeSharedTask(db, principal, complete), { ok: false, error: 'unavailable' });
    const newScope = { coupleId: pair, membershipEpoch: 1 };
    assert.deepEqual((await listSharedTasks(db, partner, newScope)).value.tasks, []);
    assert.deepEqual(await changeSharedTask(db, partner, { ...complete, ...newScope, commandId: randomUUID() }), { ok: false, error: 'unavailable' });
    const fresh = await createSharedTask(db, partner, { ...command, ...newScope, commandId: randomUUID() }); assert.equal(fresh.ok, true);
    assert.deepEqual(await changeSharedTask(db, principal, { ...complete, ...newScope, taskId: fresh.value.task.id }), { ok: false, error: 'idempotency_conflict' });
    assert.equal((await listSharedTasks(db, partner, newScope)).value.tasks[0].version, 1);
    assert.equal((await x.f.domainPool.query('SELECT count(*)::int AS n FROM shared_tasks')).rows[0].n, 2);
  } finally { await x.f.close(); }
});

test('shared tasks PostgreSQL: database rejects one-member active pair; service rejects uncommitted inconsistent membership', async () => {
  const x = await tasksFixture(); let held;
  try {
    const db = x.f.database(); const principal = await x.principal(0); const partner = await x.principal(1);
    const command = createCommand(x); const created = await createSharedTask(db, principal, command); assert.equal(created.ok, true);
    const revoke = "UPDATE couple_members SET status='revoked' WHERE couple_id=$1 AND user_id=$2";
    await assert.rejects(x.f.domainPool.query(revoke, [x.pairA, x.usersA[1]]), { code: '23514' });
    held = await x.f.domainPool.connect(); await held.query('BEGIN');
    await held.query(revoke, [x.pairA, x.usersA[1]]);
    const inconsistent = { ...db, transaction: work => work({ query: (sql, params) => held.query(sql, params) }) };
    for (const actor of [principal, partner]) {
      assert.deepEqual(await listSharedTasks(inconsistent, actor, scope(x)), { ok: false, error: 'unavailable' });
      assert.deepEqual(await createSharedTask(inconsistent, actor, command), { ok: false, error: 'unavailable' });
      assert.deepEqual(await changeSharedTask(inconsistent, actor, changed(x, created.value.task)), { ok: false, error: 'unavailable' });
    }
  } finally { if (held) { await held.query('ROLLBACK'); held.release(); } await x.f.close(); }
});

test('shared tasks PostgreSQL: equal timestamp order is stable and backward clock does not regress updatedAt', async () => {
  const x = await tasksFixture();
  try {
    const db = x.f.database(); const actor = await x.principal(0); const partner = await x.principal(1);
    const instant = new Date(Date.now() + 5000);
    const sameClock = { ...db, now: () => new Date(instant) };
    const first = await createSharedTask(sameClock, actor, createCommand(x));
    const second = await createSharedTask(sameClock, partner, createCommand(x));
    assert.equal(first.ok, true); assert.equal(second.ok, true);
    assert.equal(first.value.task.createdAt, second.value.task.createdAt);
    const expected = [first.value.task.id, second.value.task.id].sort().reverse();
    for (const member of [actor, partner]) {
      const listed = await listSharedTasks(db, member, scope(x));
      assert.deepEqual(listed.value.tasks.map(task => task.id), expected);
    }
    const updated = await changeSharedTask(db, partner, changed(x, first.value.task));
    assert.equal(updated.ok, true); assert.equal(updated.value.task.updatedAt, instant.toISOString());
    assert.equal(updated.value.task.version, 2);
    assert.deepEqual((await listSharedTasks(db, actor, scope(x))).value.tasks.map(task => task.id), expected,
      'completion does not reorder the latest-created window');
  } finally { await x.f.close(); }
});
