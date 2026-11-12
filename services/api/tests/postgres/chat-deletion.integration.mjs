import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { replyFixture } from './chat-replies-fixture.mjs';
import { withDeadline } from './async-bounds.mjs';
import { sendMessage, closeCouple } from '../../src/chat.ts';
import { sendChatReply } from '../../src/chat-replies.ts';
import { deleteChatMessage } from '../../src/chat-deletion.ts';

const deletion = (pair, message, commandId = randomUUID()) => ({
    coupleId: pair, membershipEpoch: 1, messageId: message, commandId, expectedVersion: 1, scope: 'everyone',
});
async function first(f, pair) {
    return (await f.domainPool.query('SELECT id,client_message_id,created_at FROM chat_messages WHERE couple_id=$1 ORDER BY seq LIMIT 1', [pair])).rows[0];
}
async function waitBlocked(f, pid, blocker) {
    const until = Date.now() + 1500;
    let observed = [];
    while (Date.now() < until) {
        if (pid()) {
            observed = (await f.admin.query('SELECT wait_event_type,pg_blocking_pids(pid) blockers FROM pg_stat_activity WHERE pid=$1', [pid()])).rows;
            if (observed[0]?.wait_event_type === 'Lock' && observed[0].blockers.includes(blocker)) return;
        }
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail(`Expected actual PostgreSQL blocker ${blocker}: ${JSON.stringify(observed)}`);
}
test('native own deletion binds author, target, version and separate command namespace; rollback and microseconds', async () => {
    const { f, a, b, db, principals: p, usersA } = await replyFixture();
    try {
        const root = await first(f, a);
        const input = deletion(a, root.id, root.client_message_id);
        assert.deepEqual(await deleteChatMessage(db, p[1], input), { ok: false, error: 'message_unavailable' });
        assert.deepEqual(await deleteChatMessage(db, p[0], deletion(a, (await first(f, b)).id)), { ok: false, error: 'message_unavailable' });
        assert.deepEqual(await deleteChatMessage(db, p[2], input), { ok: false, error: 'unavailable' });
        assert.deepEqual(await deleteChatMessage(db, p[0], { ...input, expectedVersion: 2 }), { ok: false, error: 'version_conflict' });
        const broken = {
            ...db,
            transaction: work => db.transaction(tx => work({
                query(sql, params) {
                    if (sql.includes('INSERT INTO chat_deletion_receipts')) throw Error('receipt_rollback');
                    return tx.query(sql, params);
                },
            })),
        };
        await assert.rejects(deleteChatMessage(broken, p[0], input), /receipt_rollback/);
        assert.equal((await f.domainPool.query('SELECT deleted_at FROM chat_messages WHERE id=$1', [root.id])).rows[0].deleted_at, null);
        const made = await deleteChatMessage(db, p[0], input);
        assert.equal(made.ok, true);
        assert.equal(made.value.message.body, null);
        assert.equal(made.value.message.version, 2);
        assert.equal((await deleteChatMessage(db, p[0], input)).value.replay, true);
        assert.deepEqual(await deleteChatMessage(db, p[0], { ...input, expectedVersion: 2 }), { ok: false, error: 'idempotency_conflict' });
        assert.deepEqual(await deleteChatMessage(db, p[0], { ...input, messageId: randomUUID() }), { ok: false, error: 'idempotency_conflict' });
        const freshCommand = randomUUID();
        const again = await deleteChatMessage(db, p[0], { ...input, commandId: freshCommand });
        assert.deepEqual(again, { ok: false, error: 'message_deleted', value: { commandId: freshCommand, message: made.value.message } });
        assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM chat_deletion_receipts')).rows[0].n, 1);
        const signedIn = await f.call('sign-in/email', { email: 'window-0@example.test', password: 'Synthetic-window-password-42!' });
        assert.equal(signedIn.status, 200);
        const cookie = signedIn.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
        const ownerAgain = await db.sessionAuthority.authenticate(new Request('http://localhost:3123', { headers: { origin: 'http://localhost:3123', cookie } }));
        assert.ok(ownerAgain);
        assert.notEqual(ownerAgain.sessionId, p[0].sessionId);
        const anotherCommand = randomUUID();
        assert.deepEqual(await deleteChatMessage(db, ownerAgain, { ...input, commandId: anotherCommand }), {
            ok: false, error: 'message_deleted', value: { commandId: anotherCommand, message: made.value.message },
        });
        assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM chat_deletion_receipts')).rows[0].n, 1);
        assert.deepEqual(await sendMessage(db, p[0], { coupleId: a, membershipEpoch: 1, clientId: input.commandId, body: 'Synthetic 1' }), { ok: false, error: 'unavailable' });
        const micro = randomUUID();
        await f.domainPool.query(`INSERT INTO chat_messages(id,couple_id,sender_id,client_message_id,seq,body,created_at)
          VALUES($1,$2,$3,$4,900,'Legacy microseconds','2026-01-01T00:00:00.123456Z')`, [micro, a, usersA[0], randomUUID()]);
        assert.equal((await deleteChatMessage(db, p[0], deletion(a, micro))).ok, true);
        assert.equal((await f.domainPool.query('SELECT deleted_at>=created_at AND deleted_at=date_trunc(\'milliseconds\',deleted_at) valid FROM chat_messages WHERE id=$1', [micro])).rows[0].valid, true);
        await assert.rejects(f.domainPool.query("UPDATE chat_deletion_receipts SET operation='send'"), /immutable_chat_deletion_receipt/);
        await assert.rejects(f.domainPool.query('DELETE FROM chat_deletion_receipts'), /immutable_chat_deletion_receipt/);
        assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM outbox_events')).rows[0].n, 0);
        assert.equal((await closeCouple(db, p[0], a, 1)).ok, true);
        assert.deepEqual(await deleteChatMessage(db, p[0], input), { ok: false, error: 'unavailable' });
        // A genuinely new pair context may not reuse the actor's existing deletion receipt key.
        const newPair = randomUUID();
        const tx = await f.domainPool.connect();
        try {
            await tx.query('BEGIN');
            await tx.query("INSERT INTO couples(id,status) VALUES($1,'waiting_partner')", [newPair]);
            for (const [index, user] of usersA.entries()) {
                await tx.query("INSERT INTO couple_members(couple_id,user_id,slot,status) VALUES($1,$2,$3,'active')", [newPair, user, index + 1]);
            }
            await tx.query("UPDATE couples SET status='active' WHERE id=$1", [newPair]);
            await tx.query('COMMIT');
        } catch (error) {
            await tx.query('ROLLBACK');
            throw error;
        } finally { tx.release(); }
        const newer = await sendMessage(db, p[0], { coupleId: newPair, membershipEpoch: 1, clientId: randomUUID(), body: 'New synthetic pair' });
        assert.equal(newer.ok, true);
        assert.deepEqual(await deleteChatMessage(db, p[0], deletion(newPair, newer.value.message.id, input.commandId)), { ok: false, error: 'idempotency_conflict' });
    } finally { await f.close(); }
});
test('native concurrent deletion CAS commits once and reply/delete serialize in both orders', async () => {
    const { f, a, db, principals: p } = await replyFixture();
    try {
        await f.domainPool.query('UPDATE couples SET next_chat_seq=754 WHERE id=$1', [a]);
        const root = await first(f, a);
        const results = await Promise.all([deleteChatMessage(db, p[0], deletion(a, root.id)), deleteChatMessage(db, p[0], deletion(a, root.id))]);
        assert.equal(results.filter(r => r.ok).length, 1);
        const terminal = results.find(r => !r.ok);
        assert.equal(terminal.error, 'message_deleted');
        assert.deepEqual(terminal.value.message, results.find(r => r.ok).value.message);
        for (const firstKind of ['reply', 'delete']) {
            const source = await sendMessage(db, p[0], { coupleId: a, membershipEpoch: 1, clientId: randomUUID(), body: 'Race source' });
            assert.equal(source.ok, true);
            const command = deletion(a, source.value.message.id);
            const reply = { coupleId: a, membershipEpoch: 1, clientId: randomUUID(), body: 'Race reply', replyToId: source.value.message.id };
            let release;
            let entered;
            const ready = new Promise(resolve => { entered = resolve; });
            const gate = new Promise(resolve => { release = resolve; });
            let blocker;
            let followerPid;
            const leading = { ...db, transaction: work => db.transaction(async tx => {
                blocker = (await tx.query('SELECT pg_backend_pid() pid')).rows[0].pid;
                const result = await work(tx);
                entered();
                await gate;
                return result;
            }) };
            const following = { ...db, transaction: work => db.transaction(async tx => {
                followerPid = (await tx.query('SELECT pg_backend_pid() pid')).rows[0].pid;
                return work(tx);
            }) };
            const lead = firstKind === 'reply' ? sendChatReply(leading, p[1], reply) : deleteChatMessage(leading, p[0], command);
            lead.catch(() => {});
            let follow;
            try {
                await withDeadline(ready, 3000, 'leading mutation readiness');
                follow = firstKind === 'reply' ? deleteChatMessage(following, p[0], command) : sendChatReply(following, p[1], reply);
                follow.catch(() => {});
                await waitBlocked(f, () => followerPid, blocker);
                release();
                assert.equal((await lead).ok, true);
                const second = await follow;
                if (firstKind === 'reply') assert.equal(second.ok, true);
                else assert.deepEqual(second, { ok: false, error: 'reply_unavailable' });
                const persisted = (await f.domainPool.query('SELECT count(*)::int n FROM chat_messages WHERE client_message_id=$1', [reply.clientId])).rows[0].n;
                assert.equal(persisted, firstKind === 'reply' ? 1 : 0);
            } finally {
                release();
                await withDeadline(Promise.allSettled([lead, ...(follow ? [follow] : [])]), 5000, 'race cleanup');
            }
        }
    } finally { await f.close(); }
});
test('native deletion rechecks actual session expiry after a proven message row lock', async () => {
    const { f, a, db, principals: p } = await replyFixture();
    const held = await f.domainPool.connect();
    let pending;
    try {
        const root = await first(f, a);
        await f.authPool.query('UPDATE "session" SET "expiresAt"=clock_timestamp()+interval \'2 seconds\' WHERE id=$1', [p[0].sessionId]);
        await held.query('BEGIN');
        await held.query('SELECT id FROM chat_messages WHERE id=$1 FOR UPDATE', [root.id]);
        const blocker = (await held.query('SELECT pg_backend_pid() pid')).rows[0].pid;
        let pid;
        const tracked = { ...db, transaction: work => db.transaction(async tx => {
            pid = (await tx.query('SELECT pg_backend_pid() pid')).rows[0].pid;
            return work(tx);
        }) };
        pending = deleteChatMessage(tracked, p[0], deletion(a, root.id));
        pending.catch(() => {});
        await waitBlocked(f, () => pid, blocker);
        await new Promise(resolve => setTimeout(resolve, 2100));
        await held.query('COMMIT');
        assert.deepEqual(await withDeadline(pending, 5000, 'deletion completion'), { ok: false, error: 'unavailable' });
        assert.equal((await f.domainPool.query('SELECT deleted_at FROM chat_messages WHERE id=$1', [root.id])).rows[0].deleted_at, null);
        assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM chat_deletion_receipts')).rows[0].n, 0);
    } finally {
        await held.query('ROLLBACK');
        held.release();
        if (pending) await withDeadline(Promise.allSettled([pending]), 5000, 'row wait cleanup');
        await f.close();
    }
});

test('native populated 020 archive survives transactional 021 upgrade with no fabricated receipts', async () => {
    const { f, a, db, principals: p } = await replyFixture({ skipChatDeletionMigration: true });
    const tx = await f.domainPool.connect();
    try {
        await f.domainPool.query('UPDATE couples SET next_chat_seq=754 WHERE id=$1', [a]);
        const root = await first(f, a);
        const reply = await sendChatReply(db, p[1], {
            coupleId: a, membershipEpoch: 1, clientId: randomUUID(), replyToId: root.id, body: 'Pre-upgrade reply remains live',
        });
        assert.equal(reply.ok, true);
        // Pre-existing accepted 020 internal transition, not a newly claimed user deletion endpoint.
        await tx.query('BEGIN');
        await tx.query('SELECT id FROM couples WHERE id=$1 FOR UPDATE', [a]);
        await tx.query("UPDATE chat_messages SET body=NULL,version=version+1,deleted_at=date_trunc('milliseconds',clock_timestamp()) WHERE id=$1", [root.id]);
        await tx.query('COMMIT');
        const snapshot = async () => (await tx.query('SELECT to_jsonb(m) AS row FROM chat_messages m ORDER BY couple_id,seq')).rows;
        const before = await snapshot();
        assert.equal(before.some(r => r.row.deleted_at !== null && r.row.body === null), true);
        assert.equal(before.some(r => r.row.reply_to_id === root.id && r.row.body !== null), true);
        const migration = await readFile(new URL('../../migrations/021_chat_deletion_receipts.sql', import.meta.url), 'utf8');
        await tx.query('BEGIN');
        await tx.query(migration);
        await tx.query('ROLLBACK');
        assert.equal((await tx.query("SELECT to_regclass('chat_deletion_receipts') AS table_name")).rows[0].table_name, null);
        assert.deepEqual(await snapshot(), before);
        await tx.query('BEGIN');
        await tx.query(migration);
        await tx.query('COMMIT');
        assert.deepEqual(await snapshot(), before, 'every original ID/body/version/time/reference remains byte-equivalent JSON');
        assert.equal((await tx.query('SELECT count(*)::int n FROM chat_deletion_receipts')).rows[0].n, 0);
        const terminal = await deleteChatMessage(db, p[0], deletion(a, root.id));
        assert.equal(terminal.ok, false);
        assert.equal(terminal.error, 'message_deleted');
        assert.equal(terminal.value.message.body, null);
        assert.equal((await tx.query('SELECT count(*)::int n FROM chat_deletion_receipts')).rows[0].n, 0);
    } finally {
        await tx.query('ROLLBACK');
        tx.release();
        await f.close();
    }
});
