import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closeCouple } from '../../src/chat.ts';
import { leaveFixture, leaveHarness, assertClosed } from './pair-leave-fixture.mjs';
import { gate } from './profile-fixture.mjs';
import { observedDatabase } from './invitation-fixture.mjs';
import { observeTask, barrierOrCompletion, settleBounded } from './async-bounds.mjs';

const delay = () => new Promise(resolve => setTimeout(resolve, 50));
async function eventTime(f, pairId) {
  const result = await f.domainPool.query(`SELECT created_at::text AS closed_at,
    clock_timestamp() > created_at AS elapsed FROM outbox_events WHERE couple_id=$1 AND type='couple.closed'`, [pairId]);
  assert.equal(result.rows.length, 1);
  return result.rows[0];
}
async function receipts(f, pairId, count, expected) {
  const result = await f.domainPool.query(`SELECT r.closed_at::text,
    r.closed_at=e.created_at AS exact_match, r.closed_at=$2::timestamptz AS original_match
    FROM pair_leave_commands r JOIN outbox_events e ON e.couple_id=r.couple_id AND e.type='couple.closed'
    WHERE r.couple_id=$1 ORDER BY r.actor_user_id,r.command_id`, [pairId, expected]);
  assert.equal(result.rows.length, count);
  assert.equal(result.rows.every(row => row.exact_match && row.original_match), true,
    'SQL compares exact timestamptz precision, not rounded JavaScript milliseconds');
  return result.rows;
}

test('pair leave closure time follows the actual lock wait; delayed second-partner and replay receipts preserve the exact event timestamp', async () => {
  const x = await leaveFixture(); const barrier = gate(); const tasks = []; let server; let stopped = false;
  try {
    server = await leaveHarness(x.f, { db: observedDatabase(x.f, async sql => {
      if (!stopped && sql.includes('FROM couples') && sql.includes('FOR UPDATE')) {
        stopped = true; await barrier.hook();
      }
    }) });
    const firstCommand = x.command(), secondCommand = x.command();
    const closing = observeTask(server.request(await x.connections[0].getCookie(), firstCommand)); tasks.push(closing);
    await barrierOrCompletion(barrier.ready, closing); await delay();
    const boundary = (await x.f.admin.query('SELECT clock_timestamp()::text AS boundary')).rows[0].boundary;
    barrier.release(); assert.equal((await closing).status, 200); await assertClosed(x.f, x.pairA);
    const initial = await eventTime(x.f, x.pairA);
    assert.equal((await x.f.domainPool.query('SELECT $1::timestamptz >= $2::timestamptz AS after_wait',
      [initial.closed_at, boundary])).rows[0].after_wait, true, 'event time is not transaction-start CURRENT_TIMESTAMP');
    await receipts(x.f, x.pairA, 1, initial.closed_at);
    await delay(); assert.equal((await eventTime(x.f, x.pairA)).elapsed, true);
    const second = await x.leave(1, secondCommand); assert.equal(second.status, 200);
    assert.equal((await second.json()).value.replayed, true);
    const beforeReplay = await receipts(x.f, x.pairA, 2, initial.closed_at);
    await delay();
    for (const [index, command] of [[0, firstCommand], [1, secondCommand]]) {
      const replay = await x.leave(index, command); assert.equal(replay.status, 200);
      assert.equal((await replay.json()).value.replayed, true);
    }
    assert.deepEqual(await receipts(x.f, x.pairA, 2, initial.closed_at), beforeReplay);
    assert.equal((await eventTime(x.f, x.pairA)).closed_at, initial.closed_at);
  } finally { barrier.release(); await settleBounded(tasks); await server?.close(); await x.f.close(); }
});

test('legacy pair closure followed by delayed acknowledgements uses the original event time for both receipts', async () => {
  const x = await leaveFixture();
  try {
    assert.deepEqual(await closeCouple(x.f.database(), await x.principal(0), x.pairA, 1), { ok: true, value: null });
    const original = await eventTime(x.f, x.pairA); const commands = [x.command(), x.command()];
    await delay(); assert.equal((await eventTime(x.f, x.pairA)).elapsed, true);
    for (let index = 0; index < 2; index++) {
      const response = await x.leave(index, commands[index]); assert.equal(response.status, 200);
      assert.equal((await response.json()).value.replayed, true);
      await receipts(x.f, x.pairA, index + 1, original.closed_at); await delay();
    }
    const beforeReplay = await receipts(x.f, x.pairA, 2, original.closed_at);
    assert.equal((await x.leave(0, commands[0])).status, 200);
    assert.deepEqual(await receipts(x.f, x.pairA, 2, original.closed_at), beforeReplay);
    assert.equal((await eventTime(x.f, x.pairA)).closed_at, original.closed_at);
    await assertClosed(x.f, x.pairA);
  } finally { await x.f.close(); }
});
