import { withDeadline } from './async-bounds.mjs';
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { replyFixture } from "./chat-replies-fixture.mjs";
import { sendMessage, readHistory, closeCouple } from "../../src/chat.ts";
import { sendChatReply, readChatMessage, readReplyWindow } from "../../src/chat-replies.ts";
// Synthetic internal transition only; not a user deletion API or an author-authorization test.
async function remove(f, pair, id) {
    const tx = await f.domainPool.connect();
    try {
        await tx.query("BEGIN");
        await tx.query("SELECT id FROM couples WHERE id=$1 FOR UPDATE", [pair]);
        await tx.query("UPDATE chat_messages SET body=NULL,deleted_at=date_trunc('milliseconds',clock_timestamp()),version=version+1 WHERE id=$1", [id]);
        await tx.query("COMMIT");
    }
    catch (error) {
        await tx.query("ROLLBACK");
        throw error;
    }
    finally {
        tx.release();
    }
}
test("native replies bind exact far-away source, both roles, retries and terminal canonical tombstones", async () => {
    const { f, a, b, db, principals: p } = await replyFixture();
    try {
        // Direct fixture seed uses seq gaps; synchronize the ordinary allocator before sending.
        await f.domainPool.query("UPDATE couples SET next_chat_seq=754 WHERE id=$1", [a]);
        const root = (await f.domainPool.query("SELECT id FROM chat_messages WHERE couple_id=$1 AND seq=3", [a])).rows[0].id;
        const foreign = (await f.domainPool.query("SELECT id FROM chat_messages WHERE couple_id=$1 AND seq=3", [b])).rows[0].id;
        const command = {
            coupleId: a,
            membershipEpoch: 1,
            clientId: randomUUID(),
            body: "Synthetic reply",
            replyToId: root
        };
        const made = await sendChatReply(db, p[1], command);
        assert.equal(made.ok, true);
        assert.equal(made.value.message.replyToId, root);
        assert.equal((await sendChatReply(db, p[1], command)).value.replay, true);
        assert.deepEqual(await sendMessage(db, p[1], command), {
            ok: false,
            error: "idempotency_conflict"
        });
        assert.deepEqual(await sendChatReply(db, p[1], {
            ...command,
            replyToId: foreign
        }), {
            ok: false,
            error: "idempotency_conflict"
        });
        for (const target of [foreign, randomUUID()])
            assert.deepEqual(await sendChatReply(db, p[0], {
                ...command,
                clientId: randomUUID(),
                replyToId: target
            }), {
                ok: false,
                error: "reply_unavailable"
            });
        const detail = await readChatMessage(db, p[0], {
            coupleId: a,
            membershipEpoch: 1,
            readId: randomUUID(),
            messageId: root
        });
        assert.equal(detail.ok, true);
        assert.equal(detail.value.message.seq, 3);
        assert.deepEqual(await readChatMessage(db, p[2], {
            coupleId: a,
            membershipEpoch: 1,
            readId: randomUUID(),
            messageId: root
        }), {
            ok: false,
            error: "unavailable"
        });
        const window = await readReplyWindow(db, p[0], {
            coupleId: a,
            membershipEpoch: 1,
            readId: randomUUID(),
            direction: "latest"
        });
        assert.equal(window.ok, true);
        assert.equal(window.value.messages.length, 50);
        assert.equal(window.value.messages.at(-1).replyToId, root);
        await remove(f, a, root);
        assert.equal((await readChatMessage(db, p[0], {
            coupleId: a,
            membershipEpoch: 1,
            readId: randomUUID(),
            messageId: root
        })).value.message.body, null);
        assert.deepEqual(await sendChatReply(db, p[0], {
            ...command,
            clientId: randomUUID()
        }), {
            ok: false,
            error: "reply_unavailable"
        });
        assert.equal((await sendChatReply(db, p[1], command)).value.replay, true, "existing reply retained when only its source is removed");
        await remove(f, a, made.value.message.id);
        assert.deepEqual(await sendChatReply(db, p[1], command), {
            ok: false,
            error: "reply_unavailable"
        });
        assert.deepEqual(await sendMessage(db, p[1], command), {
            ok: false,
            error: "unavailable"
        });
        const legacy = await readHistory(db, p[0], {
            coupleId: a,
            membershipEpoch: 1,
            limit: 100
        });
        assert.equal(legacy.ok, true);
        assert.ok(legacy.value.messages.every(m => typeof m.body === "string" && !("deletedAt" in m)));
        await assert.rejects(f.domainPool.query("DELETE FROM chat_messages WHERE id=$1", [root]), /immutable_chat_identity/);
        await assert.rejects(f.domainPool.query("UPDATE chat_messages SET body='restore',deleted_at=NULL WHERE id=$1", [root]), /invalid_chat_tombstone_transition/);
    }
    finally {
        await f.close();
    }
});
test("native SQL rejects parent/identity edits, self/cycle/cross-pair targets and rolls back partial reply writes", async () => {
    const { f, a, b, db, principals: p, usersA } = await replyFixture();
    try {
        // Direct fixture seed uses seq gaps; synchronize the ordinary allocator before sending.
        await f.domainPool.query("UPDATE couples SET next_chat_seq=754 WHERE id=$1", [a]);
        const root = (await f.domainPool.query("SELECT id FROM chat_messages WHERE couple_id=$1 AND seq=3", [a])).rows[0].id;
        for (const update of ["seq=seq+10000", "created_at=created_at+interval '1 day'", "reply_to_id=id"])
            await assert.rejects(f.domainPool.query("UPDATE chat_messages SET " + update + " WHERE id=$1", [root]), /immutable_chat_identity/);
        const self = randomUUID();
        await assert.rejects(f.domainPool.query("INSERT INTO chat_messages(id,couple_id,sender_id,client_message_id,seq,body,reply_to_id)VALUES($1,$2,$3,$4,754,'x',$1)", [self, a, usersA[0], randomUUID()]), /invalid_chat_reply_target/);
        const foreign = (await f.domainPool.query("SELECT id FROM chat_messages WHERE couple_id=$1 LIMIT 1", [b])).rows[0].id;
        await assert.rejects(f.domainPool.query("INSERT INTO chat_messages(couple_id,sender_id,client_message_id,seq,body,reply_to_id)VALUES($1,$2,$3,754,'x',$4)", [a, usersA[0], randomUUID(), foreign]), /invalid_chat_reply_target/);
        const x = randomUUID(), y = randomUUID();
        await assert.rejects(f.domainPool.query("INSERT INTO chat_messages(id,couple_id,sender_id,client_message_id,seq,body,reply_to_id)VALUES($1,$3,$4,gen_random_uuid(),754,'x',$2),($2,$3,$4,gen_random_uuid(),755,'y',$1)", [x, y, a, usersA[0]]), /invalid_chat_reply_target/);
        const broken = {
            ...db,
            transaction: work => db.transaction(tx => work({
                query(sql, params) { if (sql.includes("INSERT INTO outbox_events"))
                    throw Error("injected_outbox"); return tx.query(sql, params); }
            }))
        };
        await assert.rejects(sendChatReply(broken, p[0], {
            coupleId: a,
            membershipEpoch: 1,
            clientId: randomUUID(),
            replyToId: root,
            body: "Rollback"
        }), /injected_outbox/);
        assert.equal((await f.domainPool.query("SELECT next_chat_seq::int n FROM couples WHERE id=$1", [a])).rows[0].n, 754);
        assert.equal((await f.domainPool.query("SELECT count(*)::int n FROM chat_messages WHERE couple_id=$1", [a])).rows[0].n, 251);
    }
    finally {
        await f.close();
    }
});

test('reply and detail reauthorize after independently proven pair-lock waits', async () => {
    const { f, a, b, db, principals: p } = await replyFixture();
    const held = await f.domainPool.connect();
    const tasks = [];
    try {
        const root = (await f.domainPool.query('SELECT id FROM chat_messages WHERE couple_id=$1 ORDER BY seq LIMIT 1', [a])).rows[0].id;
        const detail = { coupleId: a, membershipEpoch: 1, messageId: root, readId: randomUUID() };
        const command = { coupleId: a, membershipEpoch: 1, clientId: randomUUID(), replyToId: root, body: 'Must not persist after expiry' };
        assert.deepEqual(await readChatMessage(db, p[0], { ...detail, membershipEpoch: 2 }), { ok: false, error: 'stale_membership' });
        assert.deepEqual(await sendChatReply(db, p[0], { ...command, membershipEpoch: 2 }), { ok: false, error: 'stale_membership' });
        const rootB = (await f.domainPool.query('SELECT id FROM chat_messages WHERE couple_id=$1 ORDER BY seq LIMIT 1', [b])).rows[0].id;
        assert.equal((await closeCouple(db, p[2], b, 1)).ok, true);
        assert.deepEqual(await readChatMessage(db, p[2], { ...detail, coupleId: b, messageId: rootB }), { ok: false, error: 'unavailable' });
        assert.deepEqual(await sendChatReply(db, p[2], { ...command, coupleId: b, replyToId: rootB }), { ok: false, error: 'unavailable' });
        const before = (await f.domainPool.query('SELECT count(*)::int n FROM outbox_events')).rows[0].n;
        // Separate sessions and pair lockers avoid confusing tuple-lock queue edges with the root blocker.
        for (const [index, useCase] of ['reply', 'detail'].entries()) {
            const actor = p[index];
            await f.authPool.query('UPDATE "session" SET "expiresAt"=clock_timestamp()+interval \'2 seconds\' WHERE id=$1', [actor.sessionId]);
            await held.query('BEGIN');
            await held.query('SELECT id FROM couples WHERE id=$1 FOR UPDATE', [a]);
            const blocker = (await held.query('SELECT pg_backend_pid() pid')).rows[0].pid;
            let reader;
            const tracked = {
                ...db,
                transaction: work => db.transaction(async tx => {
                    reader = (await tx.query('SELECT pg_backend_pid() pid')).rows[0].pid;
                    return work(tx);
                }),
            };
            const task = useCase === 'reply' ? sendChatReply(tracked, actor, command) : readChatMessage(tracked, actor, detail);
            task.catch(() => {});
            tasks.push(task);
            const deadline = Date.now() + 1500;
            let blocked = false;
            let observed = [];
            while (Date.now() < deadline) {
                if (reader) {
                    observed = (await f.admin.query('SELECT pid,wait_event_type,pg_blocking_pids(pid) blockers FROM pg_stat_activity WHERE pid=$1', [reader])).rows;
                    if (observed[0]?.wait_event_type === 'Lock' && observed[0].blockers.includes(blocker)) {
                        blocked = true;
                        break;
                    }
                }
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            assert.equal(blocked, true, `${useCase} must actually wait on blocker ${blocker}: ${JSON.stringify(observed)}`);
            await new Promise(resolve => setTimeout(resolve, 2100));
            await held.query('COMMIT');
            assert.deepEqual(await withDeadline(task, 5000, `${useCase} completion`), { ok: false, error: 'unavailable' });
        }
        assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM chat_messages WHERE client_message_id=$1', [command.clientId])).rows[0].n, 0);
        assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM outbox_events')).rows[0].n, before);
    } finally {
        await held.query('ROLLBACK');
        held.release();
        await withDeadline(Promise.allSettled(tasks), 5000, 'reply/detail cleanup');
        await f.close();
    }
});
