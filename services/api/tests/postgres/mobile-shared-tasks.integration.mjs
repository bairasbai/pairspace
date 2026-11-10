import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createComposedFixture, client } from './composed-fixture.mjs';
import { mobile, password, closeMobile } from './mobile-invitations-fixture.mjs';

// Real official provider cookies, HTTP, SQL locks/receipts and production mobile controllers.
test('real PostgreSQL: shared-task mobile immutable retry, newer replay, conflict and isolation', async () => {
  const f = await createComposedFixture({ enableSyntheticSharedTasks: true, enableSyntheticPairLeave: true });
  const accounts = [];
  try {
    const identities = [];
    for (let n = 0; n < 4; n++) {
      const connection = client(f.baseURL);
      const result = await connection.auth.signUp.email({ email: `task-mobile-${n}@example.test`, password, name: 'Synthetic' });
      assert.equal(result.error === null, true, 'synthetic signup'); identities.push(result.data.user.id);
    }
    const pairA = randomUUID(), pairB = randomUUID();
    await f.provision(identities.slice(0, 2), pairA);
    await f.provision(identities.slice(2), pairB);
    let drop = 'create'; const commands = [];
    accounts.push(await mobile(f, 0, { email: 'task-mobile-0@example.test', signup: false,
      beforeRequest: async (record, request) => {
        if (record.path.includes('/tasks') && record.method === 'POST') {
          const body = await request.clone().json(); commands.push(body);
          assert.equal(request.headers.get('idempotency-key'), body.command_id);
        }
      },
      afterResponse: async (record, response) => {
        if (record.path.includes('/tasks') && record.method === 'POST' && drop !== null) {
          assert.ok(response.status === 200 || response.status === 201);
          drop = null; throw new Error('Synthetic lost committed ACK');
        }
      } }));
    accounts.push(await mobile(f, 1, { email: 'task-mobile-1@example.test', signup: false }));
    accounts.push(await mobile(f, 2, { email: 'task-mobile-2@example.test', signup: false }));
    const [a, b, foreign] = accounts.map(account => account.controller);
    assert.equal(accounts.every(account => !account.requests.some(r => r.path.includes('/tasks'))), true, 'no implicit task I/O');
    a.tasks.setDraft('Synthetic shared task');
    await a.tasks.create(); assert.equal(a.tasks.getSnapshot().status, 'retry');
    a.tasks.setDraft('Synthetic next draft');
    await a.tasks.retry(); assert.equal(a.tasks.getSnapshot().status, 'saved');
    assert.equal(a.tasks.getSnapshot().draft, 'Synthetic next draft');
    assert.deepEqual(commands[0], commands[1], 'retry keeps exact command and original title');
    const task = a.tasks.getSnapshot().tasks[0]; assert.equal(task.version, 1);
    await b.tasks.list(); assert.equal(b.tasks.getSnapshot().tasks[0].id, task.id);
    await foreign.tasks.list(); assert.equal(foreign.tasks.getSnapshot().tasks.length, 0);
    const cookie = await accounts[2].connection.getCookie();
    assert.equal((await fetch(`${f.baseURL}/v1/couples/${pairA}/tasks?membership_epoch=1`,
      { headers: { cookie, origin: f.baseURL } })).status, 403);

    drop = 'complete';
    await a.tasks.complete(task.id); assert.equal(a.tasks.getSnapshot().status, 'retry');
    assert.equal(a.tasks.getSnapshot().tasks[0].version, 1, 'unknown ACK not falsely applied');
    await b.tasks.list(); assert.equal(b.tasks.getSnapshot().tasks[0].state, 'completed');
    await b.tasks.reopen(task.id); assert.equal(b.tasks.getSnapshot().tasks[0].version, 3);
    await a.tasks.retry();
    assert.equal(a.tasks.getSnapshot().status, 'saved');
    assert.equal(a.tasks.getSnapshot().tasks[0].version, 3);
    assert.equal(a.tasks.getSnapshot().tasks[0].state, 'open', 'old completion receipt cannot undo newer reopen');
    assert.deepEqual(commands[2], commands[3], 'state retry binds operation and expected version');
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM shared_tasks')).rows[0].n, 1);

    await a.tasks.complete(task.id); assert.equal(a.tasks.getSnapshot().tasks[0].version, 4);
    await b.tasks.complete(task.id);
    assert.equal(b.tasks.getSnapshot().status, 'conflict');
    assert.equal(b.tasks.getSnapshot().requiresRefresh, true);
    await b.tasks.retry(); assert.equal(b.tasks.getSnapshot().status, 'conflict');
    await b.tasks.list(); assert.equal(b.tasks.getSnapshot().requiresRefresh, false);
    await b.tasks.reopen(task.id); assert.equal(b.tasks.getSnapshot().tasks[0].version, 5);

    const ownerCookie = await accounts[0].connection.getCookie();
    const leave = await fetch(`${f.baseURL}/v1/pair/leave`, { method: 'POST',
      headers: { cookie: ownerCookie, origin: f.baseURL, 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: randomUUID(), coupleId: pairA, membershipEpoch: 1, confirm: true }) });
    assert.equal(leave.status, 200);
    await a.tasks.list(); assert.equal(a.tasks.getSnapshot().available, false);
    assert.equal(a.tasks.getSnapshot().tasks.length, 0); assert.equal(a.tasks.getSnapshot().draft, '');
    await b.refresh(); assert.equal(b.tasks.getSnapshot().tasks.length, 0);
    await foreign.tasks.list(); assert.equal(foreign.tasks.getSnapshot().available, true);
    await foreign.signOut(); assert.equal(foreign.tasks.getSnapshot().available, false);
  } finally { await closeMobile(f, accounts); }
});
