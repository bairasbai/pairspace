import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { tasksFixture, tasksHarness } from './shared-tasks-fixture.mjs';

const fields = ['coupleId', 'createdAt', 'creatorId', 'id', 'membershipEpoch', 'state', 'title', 'updatedAt', 'version'];
const value = async response => (await response.json()).value;

test('shared tasks PostgreSQL: both partners create/list/complete/reopen; pair, session and resource isolation', async () => {
  const x = await tasksFixture();
  try {
    const first = await x.create(0, '  Synthetic\r\n e\u0301  '); assert.equal(first.status, 201);
    const task = (await value(first)).task;
    assert.equal(task.title, 'Synthetic é'); assert.equal(task.version, 1); assert.equal(task.state, 'open');
    assert.equal(task.creatorId, x.usersA[0]); assert.equal(task.coupleId, x.pairA);
    assert.deepEqual(Object.keys(task).sort(), fields);
    for (const index of [0, 1]) {
      const result = await value(await x.list(index)); assert.equal(result.limit, 50); assert.deepEqual(result.tasks, [task]);
    }
    assert.equal((await x.create(1, 'Partner task')).status, 201);
    const completed = await x.change(1, task.id); assert.equal(completed.status, 200);
    assert.equal((await value(completed)).task.state, 'completed');
    const reopened = await value(await x.change(0, task.id, 'reopen', 2));
    assert.equal(reopened.task.state, 'open'); assert.equal(reopened.task.version, 3);
    assert.equal((await x.list(null)).status, 401);
    for (const index of [2, 3]) {
      assert.equal((await x.list(index)).status, 403);
      assert.equal((await x.change(index, task.id, 'complete', 3)).status, 403);
    }
    assert.equal((await x.create(0, 'Foreign', randomUUID(), x.pairB)).status, 403);
    assert.equal((await x.change(2, task.id, 'complete', 3, randomUUID(), x.pairB)).status, 403);
    assert.deepEqual((await value(await x.list(2, x.pairB))).tasks, []);
    assert.equal((await x.list(1, x.pairA, 2)).status, 409);
    const saved = await x.connections[1].getCookie(); await x.connections[1].auth.signOut();
    assert.equal((await fetch(`${x.f.baseURL}${x.path()}?membership_epoch=1`, {
      headers: { origin: x.f.baseURL, cookie: saved },
    })).status, 401);
    assert.equal((await x.f.domainPool.query('SELECT count(*)::int AS n FROM outbox_events')).rows[0].n, 0);
  } finally { await x.f.close(); }
});

test('shared tasks PostgreSQL: actual lost ACK retries preserve receipt and return current state after another operation', async () => {
  const x = await tasksFixture(); let server;
  try {
    server = await tasksHarness(x.f); const cookie = await x.connections[0].getCookie();
    const create = { command_id: randomUUID(), membership_epoch: 1, title: 'Synthetic unknown ACK' };
    await assert.rejects(server.request(cookie, x.path(), create), /fetch failed/);
    const retry = await server.request(cookie, x.path(), create); assert.equal(retry.status, 200);
    const receipt = await value(retry); assert.equal(receipt.replay, true); assert.equal(receipt.appliedVersion, 1);
    await server.close(); server = await tasksHarness(x.f);
    const mutation = { command_id: randomUUID(), membership_epoch: 1, operation: 'complete', expected_version: 1 };
    await assert.rejects(server.request(cookie, `${x.path()}/${receipt.task.id}`, mutation), /fetch failed/);
    const newer = await value(await x.change(1, receipt.task.id, 'reopen', 2));
    assert.equal(newer.task.version, 3);
    const delayed = await value(await server.request(cookie, `${x.path()}/${receipt.task.id}`, mutation));
    assert.equal(delayed.replay, true); assert.equal(delayed.appliedVersion, 2);
    assert.equal(delayed.task.state, 'open'); assert.equal(delayed.task.version, 3);
    const createAgain = await value(await x.create(0, create.title, create.command_id));
    assert.equal(createAgain.replay, true); assert.equal(createAgain.task.version, 3); assert.equal(createAgain.appliedVersion, 1);
    assert.equal((await x.create(0, 'Edited title', create.command_id)).status, 409);
    assert.equal((await x.change(0, receipt.task.id, 'reopen', 1, mutation.command_id)).status, 409);
    assert.equal((await x.change(0, receipt.task.id, 'complete', 3, mutation.command_id)).status, 409);
    assert.equal((await x.change(0, receipt.task.id, 'complete', 3, create.command_id)).status, 409);
    const second = await value(await x.create(1));
    assert.equal((await x.change(0, second.task.id, 'complete', 1, mutation.command_id)).status, 409);
    assert.equal((await x.f.domainPool.query('SELECT count(*)::int AS n FROM shared_tasks')).rows[0].n, 2);
  } finally { await server?.close(); await x.f.close(); }
});

test('shared tasks PostgreSQL: concurrent create and optimistic transitions serialize without silent overwrite', async () => {
  const x = await tasksFixture();
  try {
    const commandId = randomUUID();
    const creates = await Promise.all(Array.from({ length: 8 }, () => x.create(0, 'Synthetic race', commandId)));
    assert.equal(creates.filter(r => r.status === 201).length, 1); assert.equal(creates.filter(r => r.status === 200).length, 7);
    const receipts = await Promise.all(creates.map(value)); assert.equal(new Set(receipts.map(r => r.task.id)).size, 1);
    const task = receipts[0].task;
    for (const [operation, version] of [['complete', 1], ['reopen', 2]]) {
      const race = await Promise.all([x.change(0, task.id, operation, version), x.change(1, task.id, operation, version)]);
      assert.deepEqual(race.map(r => r.status).sort(), [200, 409]);
      assert.deepEqual(await race.find(r => r.status === 409).json(), { ok: false, error: 'version_conflict' });
    }
    const current = (await value(await x.list(0))).tasks[0];
    assert.equal(current.version, 3); assert.equal(current.state, 'open');
    const sameId = randomUUID(); const conflict = await Promise.all([x.create(0, 'A', sameId), x.create(0, 'B', sameId)]);
    assert.deepEqual(conflict.map(r => r.status).sort(), [201, 409]);
    const distinct = await Promise.all([x.create(0, 'Partner A'), x.create(1, 'Partner B')]);
    assert.deepEqual(distinct.map(r => r.status), [201, 201]);
    const changeId = randomUUID();
    const duplicates = await Promise.all(Array.from({ length: 8 }, () => x.change(1, task.id, 'complete', 3, changeId)));
    assert.ok(duplicates.every(r => r.status === 200));
    const results = await Promise.all(duplicates.map(value));
    assert.equal(results.filter(r => !r.replay).length, 1); assert.ok(results.every(r => r.task.version === 4));
  } finally { await x.f.close(); }
});

test('shared tasks PostgreSQL: bounded latest fifty are deterministic and omit old epoch tasks', async () => {
  const x = await tasksFixture();
  try {
    const created = [];
    for (let n = 0; n < 53; n++) {
      const response = await x.create(n % 2, `Synthetic ${n}`); assert.equal(response.status, 201);
      created.push((await value(response)).task);
    }
    const result = await value(await x.list(0)); assert.equal(result.limit, 50); assert.equal(result.tasks.length, 50);
    const expected = (await x.f.domainPool.query('SELECT id FROM shared_tasks WHERE couple_id=$1 ORDER BY created_at DESC,id DESC LIMIT 50', [x.pairA])).rows;
    assert.deepEqual(result.tasks.map(t => t.id), expected.map(t => t.id));
    assert.deepEqual(await value(await x.list(1)), result);
    await x.f.domainPool.query('UPDATE couples SET membership_epoch=2 WHERE id=$1', [x.pairA]);
    assert.equal((await x.list(0)).status, 409);
    assert.deepEqual((await value(await x.list(0, x.pairA, 2))).tasks, []);
    assert.equal((await x.change(0, created[0].id, 'complete', 1, randomUUID(), x.pairA, 2)).status, 403);
  } finally { await x.f.close(); }
});

test('shared tasks PostgreSQL: strict body, title, route and idempotency validation does not persist rejected input', async () => {
  const x = await tasksFixture();
  try {
    for (const title of ['', ' \n', null, 3, '\u0000', '\uD800', 'x'.repeat(201)]) assert.equal((await x.create(0, title)).status, 400);
    for (const extra of [{ creator_id: randomUUID() }, { due_at: '2099-01-01' }, { state: 'completed' }]) {
      assert.equal((await x.create(0, 'Synthetic', randomUUID(), x.pairA, 1, extra)).status, 400);
    }
    for (const query of ['', '?membership_epoch=01', '?membership_epoch=1&membership_epoch=1', '?membership_epoch=1&limit=99', '?membership_epoch=1&title=secret']) {
      assert.equal((await x.raw(0, x.path() + query)).status, 400);
    }
    const body = { command_id: randomUUID(), membership_epoch: 1, title: 'Synthetic' };
    assert.equal((await x.post(0, `${x.path()}?title=secret`, body)).status, 400);
    assert.equal((await x.raw(0, x.path(), { method: 'POST', body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() } })).status, 400);
    assert.equal((await x.raw(0, x.path(), { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await x.raw(0, x.path(), { method: 'DELETE' })).status, 405);
    assert.equal((await x.raw(0, x.path(), { headers: { origin: 'https://untrusted.example.test' } })).status, 403);
    assert.equal((await x.change(0, randomUUID(), 'delete')).status, 400);
    assert.equal((await x.change(0, randomUUID(), 'complete', 0)).status, 400);
    assert.equal((await x.change(0, 'not-a-uuid')).status, 400);
    assert.deepEqual((await value(await x.list(0))).tasks, []);
  } finally { await x.f.close(); }
});

test('shared tasks PostgreSQL: migration constrains pair FK, titles, versions and immutable receipts; failed receipt is atomic', async () => {
  const x = await tasksFixture();
  try {
    const insert = (creator = x.usersA[0], title = 'Synthetic', epoch = 1, state = 'open', version = 1) =>
      x.f.domainPool.query(`INSERT INTO shared_tasks(couple_id,creator_id,membership_epoch,title,state,version,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,date_trunc('milliseconds',statement_timestamp()),date_trunc('milliseconds',statement_timestamp()))`, [x.pairA, creator, epoch, title, state, version]);
    await assert.rejects(insert(x.usersB[0]), { code: '23503' });
    for (const title of ['', 'x'.repeat(201), ' untrimmed ', 'two  spaces', 'e\u0301', 'line\nbreak']) {
      await assert.rejects(insert(x.usersA[0], title), { code: '23514' });
    }
    await assert.rejects(insert(x.usersA[0], 'Synthetic', 0), { code: '23514' });
    await assert.rejects(insert(x.usersA[0], 'Synthetic', 1, 'deleted'), { code: '23514' });
    await assert.rejects(insert(x.usersA[0], 'Synthetic', 1, 'open', 0), { code: '23514' });
    const task = (await value(await x.create(0))).task;
    for (const sql of ["UPDATE shared_tasks SET title='Edited'", 'UPDATE shared_tasks SET version=2',
      "UPDATE shared_tasks SET state='completed',version=3", 'UPDATE shared_task_commands SET applied_version=2', 'DELETE FROM shared_task_commands']) {
      await assert.rejects(x.f.domainPool.query(sql), { code: '23514' });
    }
    await x.f.domainPool.query(`CREATE FUNCTION reject_task_receipt_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'synthetic private details must be redacted'; END $$`);
    await x.f.domainPool.query('CREATE TRIGGER reject_task_receipt_fixture BEFORE INSERT ON shared_task_commands FOR EACH ROW EXECUTE FUNCTION reject_task_receipt_fixture()');
    const command = randomUUID(); const failed = await x.change(1, task.id, 'complete', 1, command);
    assert.equal(failed.status, 503); assert.deepEqual(await failed.json(), { ok: false, error: 'temporarily_unavailable' });
    assert.equal((await value(await x.list(1))).tasks[0].version, 1, 'task update rolls back if receipt insert fails');
    const failedCreate = await x.create(0, 'Synthetic rollback'); assert.equal(failedCreate.status, 503);
    assert.equal((await x.f.domainPool.query('SELECT count(*)::int AS n FROM shared_tasks')).rows[0].n, 1);
    await x.f.domainPool.query('DROP TRIGGER reject_task_receipt_fixture ON shared_task_commands');
    const retry = await value(await x.change(1, task.id, 'complete', 1, command));
    assert.equal(retry.replay, false); assert.equal(retry.task.version, 2);
  } finally { await x.f.close(); }
});
