import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { replyFixture } from './chat-replies-fixture.mjs';
import { setChatVisibility, readChatVisibility } from '../../src/chat-visibility.ts';
import { readHiddenWindow } from '../../src/chat-hidden-window.ts';
import { readChatWindow } from '../../src/chat-history-window.ts';
import { readChatMessage, sendChatReply } from '../../src/chat-replies.ts';
import { createChatRepliesHandler } from '../../src/chat-replies-http.ts';
import { readHistory, closeCouple } from '../../src/chat.ts';
import { visibilityResponse } from '../../src/chat-visibility-scope.ts';
import { deleteChatMessage } from '../../src/chat-deletion.ts';
const scope = pair => ({ coupleId: pair, membershipEpoch: 1 });
const change = (pair, messageId, hidden, expectedVersion, commandId = randomUUID()) => ({ ...scope(pair), messageId, hidden, expectedVersion, commandId });
const win = (pair, direction = 'latest') => ({ ...scope(pair), direction, readId: randomUUID() });
const detail = (pair, messageId) => ({ ...scope(pair), messageId, readId: randomUUID() });
function failReceipt(db) {
    return { ...db, transaction: work => db.transaction(tx => work({ query(sql, params) {
                if (sql.includes('INSERT INTO chat_visibility_receipts'))
                    throw Error('synthetic_receipt_failure');
                return tx.query(sql, params);
            } })) };
}
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
test('personal visibility: 61 hidden rows, all native windows, no partner fact, CAS/retry/rollback and terminal restore', async () => {
    const { f, a, b, db, principals: p } = await replyFixture();
    try {
        const roots = (await f.domainPool.query('SELECT id,seq::text FROM chat_messages WHERE couple_id=$1 ORDER BY chat_messages.seq LIMIT 61', [a])).rows;
        const oldEvents = (await f.domainPool.query('SELECT count(*)::int n FROM outbox_events')).rows[0].n;
        await assert.rejects(setChatVisibility(failReceipt(db), p[0], change(a, roots[0].id, true, 0)), /synthetic_receipt_failure/);
        assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM chat_message_visibility')).rows[0].n, 0);
        const first = change(a, roots[0].id, true, 0);
        assert.equal((await setChatVisibility(db, p[0], first)).ok, true);
        assert.equal((await setChatVisibility(db, p[0], first)).value.replay, true);
        assert.equal((await setChatVisibility(db, p[0], change(a, roots[0].id, true, 1))).value.visibility.version, 1);
        assert.equal((await setChatVisibility(db, p[0], change(a, roots[0].id, false, 0))).error, 'version_conflict');
        assert.equal((await setChatVisibility(db, p[0], { ...first, hidden: false })).error, 'idempotency_conflict');
        for (const r of roots.slice(1))
            assert.equal((await setChatVisibility(db, p[0], change(a, r.id, true, 0))).ok, true);
        const firstPage = await readHiddenWindow(db, p[0], win(a));
        assert.equal(firstPage.ok, true);
        assert.equal(firstPage.value.messages.length, 50);
        assert.equal(firstPage.value.hasOlder, true);
        assert.equal(firstPage.value.hasNewer, false);
        assert.ok(firstPage.value.messages.every(m => !Object.hasOwn(m, 'body')));
        const cursor = firstPage.value.olderCursor;
        const second = await readHiddenWindow(db, p[0], { ...win(a, 'before'), anchorId: cursor.id, anchorSeq: cursor.seq, visibilityRevision: 61 });
        assert.equal(second.value.messages.length, 11);
        assert.equal(second.value.hasOlder, false);
        assert.equal(second.value.hasNewer, true);
        const oldest = await readHiddenWindow(db, p[0], win(a, 'oldest'));
        const newest = await readHiddenWindow(db, p[0], { ...win(a, 'after'), anchorId: oldest.value.newerCursor.id, anchorSeq: oldest.value.newerCursor.seq, visibilityRevision: 61 });
        assert.equal(newest.value.messages.length, 11);
        assert.equal((await readHiddenWindow(db, p[1], win(a))).value.messages.length, 0);
        assert.equal((await readChatWindow(db, p[0], win(a, 'oldest'), true)).value.messages[0].seq, 186);
        const legacyLatest = await readHistory(db, p[0], { ...scope(a), limit: 100 });
        assert.equal(legacyLatest.ok, true);
        assert.equal(legacyLatest.value.messages.length, 100);
        assert.equal(legacyLatest.value.nextBeforeSeq, 456);
        const legacyOlder = await readHistory(db, p[0], {
            ...scope(a), limit: 100, beforeSeq: legacyLatest.value.nextBeforeSeq
        });
        assert.equal(legacyOlder.ok, true);
        assert.equal(legacyOlder.value.messages.length, 90);
        assert.equal(legacyOlder.value.nextBeforeSeq, null);
        const legacyVisible = [...legacyOlder.value.messages, ...legacyLatest.value.messages];
        assert.deepEqual(legacyVisible.map(m => m.seq), Array.from({ length: 190 }, (_, i) => (62 + i) * 3));
        assert.equal(new Set(legacyVisible.map(m => m.id)).size, 190);
        const hiddenIds = new Set(roots.map(r => r.id));
        assert.ok(legacyVisible.every(m => !hiddenIds.has(m.id)));
        assert.equal((await readChatMessage(db, p[0], detail(a, roots[0].id))).error, 'message_hidden');
        assert.equal((await readChatMessage(db, p[1], detail(a, roots[0].id))).ok, true);
        assert.equal((await readChatWindow(db, p[0], { ...win(a, 'after'), anchorId: roots[0].id, anchorSeq: 3 }, true)).error, 'invalid_cursor');
        assert.equal((await sendChatReply(db, p[0], { ...scope(a), clientId: randomUUID(), replyToId: roots[0].id, body: 'Not sent' })).error, 'message_hidden');
        assert.equal((await setChatVisibility(db, p[0], change(a, roots[0].id, false, 1))).value.visibility.version, 2);
        assert.equal((await readHiddenWindow(db, p[0], { ...win(a, 'before'), anchorId: cursor.id, anchorSeq: cursor.seq, visibilityRevision: 61 })).error, 'visibility_changed');
        const deletion = await deleteChatMessage(db, p[0], { ...scope(a), messageId: roots[0].id, commandId: randomUUID(), expectedVersion: 1, scope: 'everyone' });
        assert.equal(deletion.ok, true);
        await setChatVisibility(db, p[0], change(a, roots[0].id, true, 2));
        await setChatVisibility(db, p[0], change(a, roots[0].id, false, 3));
        assert.equal((await readChatMessage(db, p[0], detail(a, roots[0].id))).value.message.body, null);
        assert.equal((await setChatVisibility(db, p[2], change(a, roots[0].id, true, 0))).error, 'unavailable');
        assert.equal((await setChatVisibility(db, p[0], { ...change(a, roots[0].id, true, 4), membershipEpoch: 2 })).error, 'stale_membership');
        const foreign = (await f.domainPool.query('SELECT id FROM chat_messages WHERE couple_id=$1 LIMIT 1', [b])).rows[0].id;
        assert.equal((await setChatVisibility(db, p[0], change(a, foreign, true, 0))).error, 'message_unavailable');
        assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM outbox_events')).rows[0].n, oldEvents);
        await closeCouple(db, p[2], b, 1);
        assert.equal((await readChatVisibility(db, p[2], detail(b, foreign))).error, 'unavailable');
    }
    finally {
        await f.close();
    }
});
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
                        if (sql.includes('m.seq::text AS seq,m.body')) {
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
        const handler = visibilityResponse(reader, bound => async () => globalThis.Response.json(await readChatWindow(bound, p[0], win(a), true)));
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
        const after = visibilityResponse(db, bound => async () => globalThis.Response.json(await readChatWindow(bound, p[0], win(a), true)));
        const newResponse = await after(new Request('http://localhost/read', { headers: { 'X-Chat-Visibility': '1' } }));
        assert.equal(newResponse.headers.get('X-Chat-Visibility-Revision'), '1');
        assert.ok(!(await newResponse.json()).value.messages.some(m => m.id === root));
    }
    finally {
        release();
        await f.close();
    }
});
test('hide CAS races, session expires after contended pair lock, immutable receipt and no body rewrite', async () => {
    const { f, a, db, principals: p } = await replyFixture();
    const lock = await f.domainPool.connect();
    try {
        const root = (await f.domainPool.query('SELECT id,body FROM chat_messages WHERE couple_id=$1 ORDER BY seq LIMIT 1', [a])).rows[0];
        const result = await Promise.all([setChatVisibility(db, p[0], change(a, root.id, true, 0)), setChatVisibility(db, p[0], change(a, root.id, true, 0))]);
        assert.equal(result.filter(r => r.ok).length, 1);
        assert.equal(result.find(r => !r.ok).error, 'version_conflict');
        await assert.rejects(f.domainPool.query('UPDATE chat_visibility_receipts SET hidden=false'), /immutable_visibility_receipt/);
        assert.equal((await f.domainPool.query('SELECT body FROM chat_messages WHERE id=$1', [root.id])).rows[0].body, root.body);
        await f.authPool.query(`UPDATE "session" SET "expiresAt"=clock_timestamp()+interval '2 seconds' WHERE id=$1`, [p[0].sessionId]);
        await lock.query('BEGIN');
        const locker = (await lock.query('SELECT pg_backend_pid() pid')).rows[0].pid;
        await lock.query('SELECT version FROM chat_message_visibility WHERE message_id=$1 FOR UPDATE', [root.id]);
        let waiter;
        const tracked = { ...db, transaction: work => db.transaction(async (tx) => { waiter = (await tx.query('SELECT pg_backend_pid() pid')).rows[0].pid; return work(tx); }) };
        const pending = setChatVisibility(tracked, p[0], change(a, root.id, false, 1));
        for (let i = 0; i < 100 && !waiter; i++)
            await delay(5);
        await blocked(f.domainPool, waiter, locker);
        await delay(2100);
        await lock.query('COMMIT');
        assert.equal((await pending).error, 'unavailable');
        assert.equal((await f.domainPool.query('SELECT hidden FROM chat_message_visibility WHERE message_id=$1', [root.id])).rows[0].hidden, true);
        const unauthenticated = await createChatRepliesHandler(db)(new Request(
            `http://localhost:3123/v1/couples/${a}/chat/message-detail?message_id=${root.id}&membership_epoch=1&read_id=${randomUUID()}`,
            { headers: { origin: 'http://localhost:3123' } }
        ));
        assert.equal(unauthenticated.status, 401);
        const denied = await unauthenticated.json();
        assert.equal(denied.error, 'unauthenticated');
        assert.equal(Object.hasOwn(denied, 'value'), false);
    }
    finally {
        await lock.query('ROLLBACK').catch(() => { });
        lock.release();
        await f.close();
    }
});
