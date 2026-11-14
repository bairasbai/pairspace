import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { replyFixture } from './chat-replies-fixture.mjs';
import { reconcileChat } from '../../src/chat-reconciliation.ts';
import { setChatVisibility } from '../../src/chat-visibility.ts';
import { visibilityResponse } from '../../src/chat-visibility-scope.ts';
const change = (coupleId, messageId, hidden, expectedVersion) => ({ coupleId, membershipEpoch: 1, messageId, hidden, expectedVersion, commandId: randomUUID() });
async function blocked(pool, waiter, locker) {
    for (let i = 0; i < 150; i++) {
        const r = (await pool.query(`SELECT wait_event_type='Lock' AND $2=ANY(pg_blocking_pids(pid)) AS blocked
      FROM pg_stat_activity WHERE pid=$1`, [waiter, locker])).rows[0];
        if (r?.blocked)
            return;
        await delay(10);
    }
    assert.fail('expected real lock wait and exact blocking PID');
}
test('same-transaction visibility fence: read body holds SHARE until old revision captured; hide waits actual PID', async () => {
    const { f, a, db, principals: p } = await replyFixture();
    let release = () => { };
    try {
        const root = (await f.domainPool.query('SELECT id FROM chat_messages WHERE couple_id=$1 ORDER BY seq DESC LIMIT 1', [a])).rows[0].id;
        let readerPid, writerPid, signal;
        const reached = new Promise(resolve => { signal = resolve; });
        const hold = new Promise(resolve => { release = resolve; });
        const reader = { ...db, transaction: work => db.transaction(async (tx) => {
                readerPid = (await tx.query('SELECT pg_backend_pid() pid')).rows[0].pid;
                return work({ async query(sql, params) {
                        const result = await tx.query(sql, params);
                        if (sql.includes('m.id=ANY($2::uuid[])')) {
                            signal();
                            await hold;
                        }
                        return result;
                    } });
            }) };
        const writer = { ...db, transaction: work => db.transaction(async (tx) => {
                writerPid = (await tx.query('SELECT pg_backend_pid() pid')).rows[0].pid;
                return work(tx);
            }) };
        const handler = visibilityResponse(reader, bound => async () => globalThis.Response.json(await reconcileChat(bound, p[0], { coupleId: a, membershipEpoch: 1, readId: randomUUID(), messageIds: [root], detailId: root })));
        const pending = handler(new Request('http://localhost/read', { headers: { 'X-Chat-Visibility': '1' } }));
        await reached;
        const hiding = setChatVisibility(writer, p[0], change(a, root, true, 0));
        for (let i = 0; i < 100 && !writerPid; i++)
            await delay(5);
        await blocked(f.domainPool, writerPid, readerPid);
        release();
        const oldResponse = await pending;
        assert.equal(oldResponse.headers.get('X-Chat-Visibility-Revision'), '0');
        assert.ok((await oldResponse.json()).value.messages.some(m => m.id === root));
        assert.equal((await hiding).ok, true);
        const after = visibilityResponse(db, bound => async () => globalThis.Response.json(await reconcileChat(bound, p[0], { coupleId: a, membershipEpoch: 1, readId: randomUUID(), messageIds: [root], detailId: root })));
        const newResponse = await after(new Request('http://localhost/read', { headers: { 'X-Chat-Visibility': '1' } }));
        assert.equal(newResponse.headers.get('X-Chat-Visibility-Revision'), '1');
        const refreshed = (await newResponse.json()).value;
        assert.deepEqual(refreshed.messages, []);
        assert.deepEqual(refreshed.unavailableIds, [root]);
        assert.equal(refreshed.detail.message, null);
        assert.notEqual(refreshed.latestVisible.id, root);
    }
    finally {
        release();
        await f.close();
    }
});
test('reconciliation denies an expired session after proven pair lock wait without selecting bodies', async () => {
  const { f, a, db, principals: p } = await replyFixture();
  const lock = await f.domainPool.connect();
  try {
    const root = (await f.domainPool.query('SELECT id FROM chat_messages WHERE couple_id=$1 LIMIT 1', [a])).rows[0].id;
    await f.authPool.query(`UPDATE "session" SET "expiresAt"=clock_timestamp()+interval '2 seconds' WHERE id=$1`, [p[0].sessionId]);
    await lock.query('BEGIN');
    const locker = (await lock.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    await lock.query('SELECT id FROM couples WHERE id=$1 FOR UPDATE', [a]);
    let waiter, bodyQueries = 0;
    const tracked = { ...db, transaction: work => db.transaction(async tx => {
      waiter = (await tx.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      return work({ query(sql, params) {
        if (sql.includes('m.id=ANY($2::uuid[])')) bodyQueries++;
        return tx.query(sql, params);
      } });
    }) };
    const pending = reconcileChat(tracked, p[0], { coupleId: a, membershipEpoch: 1, readId: randomUUID(), messageIds: [root] });
    for (let i = 0; i < 100 && !waiter; i++) await delay(5);
    await blocked(f.domainPool, waiter, locker);
    await delay(2100);
    await lock.query('COMMIT');
    assert.deepEqual(await pending, { ok: false, error: 'unavailable' });
    assert.equal(bodyQueries, 0);
  } finally {
    await lock.query('ROLLBACK').catch(() => {});
    lock.release();
    await f.close();
  }
});
