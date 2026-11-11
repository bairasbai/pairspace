import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { memoriesFixture, memoriesHarness } from './shared-memories-fixture.mjs';
const value = async response => (await response.json()).value;

test('shared memories PostgreSQL: explicit dated immutable text is shared only within verified pair and epoch', async () => {
  const x = await memoriesFixture();
  try {
    for (const index of [0, 1]) {
      const response = await x.create(index, ' Synthetic e\u0301 ', randomUUID(), x.pairA, 1, { body: 'e\u0301\r\nSynthetic 😀' });
      assert.equal(response.status, 201);
      const memory = (await value(response)).memory;
      assert.equal(memory.title, 'Synthetic é'); assert.equal(memory.body, 'é\nSynthetic 😀');
      assert.equal(memory.localDate, '2028-02-29'); assert.equal(memory.creatorId, x.usersA[index]);
      assert.deepEqual(Object.keys(memory).sort(), ['body', 'coupleId', 'createdAt', 'creatorId', 'id', 'localDate', 'membershipEpoch', 'title']);
    }
    const a = await value(await x.list(0)); assert.equal(a.memories.length, 2); assert.equal(a.limit, 50);
    assert.deepEqual(await value(await x.list(1)), a);
    assert.equal((await x.list(null)).status, 401);
    for (const index of [2, 3]) { assert.equal((await x.list(index)).status, 403); assert.equal((await x.create(index)).status, 403); }
    assert.deepEqual((await value(await x.list(2, x.pairB))).memories, []);
    assert.equal((await x.list(0, x.pairA, 2)).status, 409);
    assert.equal((await x.f.domainPool.query('SELECT count(*)::int n FROM outbox_events')).rows[0].n, 0);
    for (const sql of ['UPDATE shared_memories SET body=body', 'DELETE FROM shared_memories']) await assert.rejects(x.f.domainPool.query(sql), { code: '23514' });
    for (const extra of [{ body: ' ' }, { body: '\ud800' }, { body: '😀'.repeat(2001) }, { title: ' ' }, { local_date: '2027-02-29' }, { timezone: 'UTC' }]) {
      assert.equal((await x.create(0, 'Synthetic invalid', randomUUID(), x.pairA, 1, extra)).status, 400);
    }
    for (const day of ['0001-01-01', '9999-12-31', '2000-02-29', '2026-03-08', '2026-11-01']) {
      assert.equal((await value(await x.create(0, 'Date only', randomUUID(), x.pairA, 1, { local_date: day }))).memory.localDate, day);
    }
  } finally { await x.f.close(); }
});

test('shared memories PostgreSQL: durable lost ACK, concurrent identical retries and strict payload conflict', async () => {
  const x = await memoriesFixture(); let server;
  try {
    server = await memoriesHarness(x.f); const cookie = await x.connections[0].getCookie();
    const body = { command_id: randomUUID(), membership_epoch: 1, title: 'Synthetic lost ACK', body: 'Shared text', local_date: '2028-02-29' };
    await assert.rejects(server.request(cookie, x.path(), body), /fetch failed/);
    const response = await server.request(cookie, x.path(), body); assert.equal(response.status, 200);
    const replay = await value(response); assert.equal(replay.replay, true);
    for (const extra of [{ title: 'Changed' }, { local_date: '2028-03-01' }, { body: 'Changed' }]) assert.equal((await x.post(0, x.path(), { ...body, ...extra })).status, 409);
    const id = randomUUID(); const results = await Promise.all(Array.from({ length: 6 }, () => x.create(0, 'Synthetic concurrent', id)));
    assert.equal(results.filter(r => r.status === 201).length, 1); assert.equal(results.filter(r => r.status === 200).length, 5);
    assert.equal(new Set((await Promise.all(results.map(value))).map(r => r.memory.id)).size, 1);
    assert.equal((await x.f.domainPool.query('SELECT count(*)::int n FROM shared_memories')).rows[0].n, 2);
    assert.equal((await x.leave(1)).status, 200);
    assert.equal((await x.post(0, x.path(), body)).status, 403);
    assert.equal((await x.list(1)).status, 403);
  } finally { await server?.close(); await x.f.close(); }
});
