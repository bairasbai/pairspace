import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { replyFixture } from "./chat-replies-fixture.mjs";
import { withDeadline } from "./async-bounds.mjs";
import { sendMessage, closeCouple } from "../../src/chat.ts";
import { sendChatReply } from "../../src/chat-replies.ts";
import { editChatMessage } from "../../src/chat-editing.ts";
import { deleteChatMessage } from "../../src/chat-deletion.ts";
const edit = (pair, target, body = "Edited synthetic", expectedVersion = 1, commandId = randomUUID()) => ({
    coupleId: pair,
    membershipEpoch: 1,
    messageId: target,
    body,
    expectedVersion,
    commandId,
});
const remove = (pair, target, expectedVersion = 1, commandId = randomUUID()) => ({
    coupleId: pair,
    membershipEpoch: 1,
    messageId: target,
    expectedVersion,
    commandId,
    scope: "everyone",
});
async function root(f, pair) {
    return (await f.domainPool.query("SELECT id,client_message_id,body FROM chat_messages WHERE couple_id=$1 ORDER BY seq LIMIT 1", [pair])).rows[0];
}
async function waitBlocked(f, pid, blocker) {
    const deadline = Date.now() + 1500;
    let observed = [];
    while (Date.now() < deadline) {
        if (pid()) {
            observed = (await f.admin.query("SELECT wait_event_type,pg_blocking_pids(pid) blockers FROM pg_stat_activity WHERE pid=$1", [pid()])).rows;
            if (observed[0]?.wait_event_type === "Lock" && observed[0].blockers.includes(blocker))
                return;
        }
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail(`Expected blocker ${blocker}, observed ${JSON.stringify(observed)}`);
}
test("native original send/reply identities survive edits, canonical replay and deletion without plaintext receipts", async () => {
    const { f, a, b, db, principals: p } = await replyFixture();
    try {
        await f.domainPool.query("UPDATE couples SET next_chat_seq=754 WHERE id=$1", [a]);
        const source = await root(f, a), foreign = await root(f, b);
        const command = edit(a, source.id, "Edited one", 1, source.client_message_id);
        assert.deepEqual(await editChatMessage(db, p[1], command), {
            ok: false,
            error: "message_unavailable"
        });
        assert.deepEqual(await editChatMessage(db, p[0], {
            ...command,
            messageId: foreign.id
        }), {
            ok: false,
            error: "message_unavailable"
        });
        assert.deepEqual(await editChatMessage(db, p[2], command), {
            ok: false,
            error: "unavailable"
        });
        const broken = {
            ...db,
            transaction: work => db.transaction(tx => work({
                query(sql, args) {
                    if (sql.includes("INSERT INTO chat_edit_receipts"))
                        throw Error("rollback_edit_receipt");
                    return tx.query(sql, args);
                }
            }))
        };
        await assert.rejects(editChatMessage(broken, p[0], command), /rollback_edit_receipt/);
        assert.equal((await f.domainPool.query("SELECT version FROM chat_messages WHERE id=$1", [source.id])).rows[0].version, 1);
        const noop = edit(a, source.id, source.body, 1);
        await assert.rejects(editChatMessage(broken, p[0], noop), /rollback_edit_receipt/);
        assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM chat_edit_receipts')).rows[0].n, 0);
        const noChange = await editChatMessage(db, p[0], noop);
        assert.equal(noChange.ok, true);
        assert.equal(noChange.value.message.version, 1, 'fresh same-body save does not create an edited marker');
        assert.deepEqual((await f.domainPool.query('SELECT is_noop,applied_version FROM chat_edit_receipts WHERE command_id=$1',[noop.commandId])).rows[0], {is_noop:true,applied_version:1});
        await assert.rejects(f.domainPool.query('UPDATE chat_messages SET body=body,version=version+1 WHERE id=$1',[source.id]), /unchanged_chat_body/);
        const made = await editChatMessage(db, p[0], command);
        assert.equal(made.ok, true);
        const original = {
            coupleId: a,
            membershipEpoch: 1,
            clientId: source.client_message_id,
            body: source.body
        };
        const replay = await sendMessage(db, p[0], original);
        assert.equal(replay.ok, true);
        assert.equal(replay.value.message.body, "Edited one");
        assert.deepEqual(await sendMessage(db, p[0], {
            ...original,
            body: "Edited one"
        }), {
            ok: false,
            error: "idempotency_conflict"
        });
        assert.equal((await editChatMessage(db, p[0], edit(a, source.id, "Edited one", 2))).value.message.version, 2, "same normalized body is a no-op");
        assert.equal((await editChatMessage(db, p[0], edit(a, source.id, source.body, 2))).value.message.version, 3, 'restoring original text remains an actual third version');
        assert.equal((await editChatMessage(db, p[0], noop)).value.message.version, 3, 'old no-op receipt returns current canonical revision');
        assert.equal((await editChatMessage(db, p[0], command)).value.message.version, 3);
        assert.deepEqual(await editChatMessage(db, p[0], {
            ...command,
            body: "Changed intent"
        }), {
            ok: false,
            error: "idempotency_conflict"
        });
        const reply = {
            coupleId: a,
            membershipEpoch: 1,
            clientId: randomUUID(),
            replyToId: source.id,
            body: "Original reply"
        };
        const sent = await sendChatReply(db, p[1], reply);
        assert.equal(sent.ok, true);
        const replyEdit = edit(a, sent.value.message.id, "Edited reply");
        assert.equal((await editChatMessage(db, p[1], replyEdit)).ok, true);
        assert.equal((await sendChatReply(db, p[1], reply)).value.message.body, "Edited reply");
        assert.deepEqual(await sendMessage(db, p[1], reply), {
            ok: false,
            error: "idempotency_conflict"
        });
        assert.equal((await deleteChatMessage(db, p[1], remove(a, sent.value.message.id, 2, replyEdit.commandId))).ok, true, "separate edit/delete namespaces");
        assert.equal((await editChatMessage(db, p[1], replyEdit)).value.message.body, null);
        assert.deepEqual(await sendChatReply(db, p[1], reply), {
            ok: false,
            error: "reply_unavailable"
        });
        assert.equal((await deleteChatMessage(db, p[0], remove(a, source.id, 3, command.commandId))).ok, true);
        assert.deepEqual(await sendMessage(db, p[0], original), {
            ok: false,
            error: "unavailable"
        });
        assert.equal((await editChatMessage(db, p[0], command)).value.message.body, null);
        assert.equal((await editChatMessage(db, p[0], noop)).value.message.body, null, 'no-op receipt never resurrects after deletion');
        assert.equal((await f.domainPool.query("SELECT count(*)::int n FROM outbox_events")).rows[0].n, 1, "editing/deleting adds no events");
        assert.equal((await closeCouple(db, p[0], a, 1)).ok, true);
        assert.deepEqual(await editChatMessage(db, p[0], command), {
            ok: false,
            error: "unavailable"
        });
    }
    finally {
        await f.close();
    }
});
test("native CAS edit/edit and edit/delete races are serialized in both orders", async () => {
    const { f, a, db, principals: p } = await replyFixture();
    try {
        await f.domainPool.query("UPDATE couples SET next_chat_seq=754 WHERE id=$1", [a]);
        const source = await root(f, a);
        const cas = await Promise.all([editChatMessage(db, p[0], edit(a, source.id, "A")), editChatMessage(db, p[0], edit(a, source.id, "B"))]);
        assert.equal(cas.filter(r => r.ok).length, 1);
        assert.deepEqual(cas.find(r => !r.ok), {
            ok: false,
            error: "version_conflict"
        });
        for (const firstKind of ["edit", "delete"]) {
            const sent = await sendMessage(db, p[0], {
                coupleId: a,
                membershipEpoch: 1,
                clientId: randomUUID(),
                body: "Race source"
            });
            assert.equal(sent.ok, true);
            const command = edit(a, sent.value.message.id), deletion = remove(a, sent.value.message.id);
            let release, entered, blocker, pid;
            const ready = new Promise(resolve => { entered = resolve; });
            const gate = new Promise(resolve => { release = resolve; });
            const leading = {
                ...db,
                transaction: work => db.transaction(async (tx) => {
                    blocker = (await tx.query("SELECT pg_backend_pid() pid")).rows[0].pid;
                    const result = await work(tx);
                    entered();
                    await gate;
                    return result;
                })
            };
            const following = {
                ...db,
                transaction: work => db.transaction(async (tx) => { pid = (await tx.query("SELECT pg_backend_pid() pid")).rows[0].pid; return work(tx); })
            };
            const lead = firstKind === "edit" ? editChatMessage(leading, p[0], command) : deleteChatMessage(leading, p[0], deletion);
            lead.catch(() => { });
            let follow;
            try {
                await withDeadline(ready, 3000, "race readiness");
                follow = firstKind === "edit" ? deleteChatMessage(following, p[0], deletion) : editChatMessage(following, p[0], command);
                follow.catch(() => { });
                await waitBlocked(f, () => pid, blocker);
                release();
                assert.equal((await lead).ok, true);
                const second = await follow;
                if (firstKind === "edit")
                    assert.deepEqual(second, {
                        ok: false,
                        error: "version_conflict"
                    });
                else {
                    assert.equal(second.error, "message_deleted");
                    assert.equal(second.value.message.body, null);
                }
            }
            finally {
                release();
                await withDeadline(Promise.allSettled([lead, ...(follow ? [follow] : [])]), 5000, "race cleanup");
            }
        }
    }
    finally {
        await f.close();
    }
});
test("native edit expires after real message row wait and leaves no mutation or receipt", async () => {
    const { f, a, db, principals: p } = await replyFixture();
    const held = await f.domainPool.connect();
    let pending;
    try {
        const source = await root(f, a), command = edit(a, source.id);
        await f.authPool.query("UPDATE \"session\" SET \"expiresAt\"=clock_timestamp()+interval '2 seconds' WHERE id=$1", [p[0].sessionId]);
        await held.query("BEGIN");
        await held.query("SELECT id FROM chat_messages WHERE id=$1 FOR UPDATE", [source.id]);
        const blocker = (await held.query("SELECT pg_backend_pid() pid")).rows[0].pid;
        let pid;
        const tracked = {
            ...db,
            transaction: work => db.transaction(async (tx) => { pid = (await tx.query("SELECT pg_backend_pid() pid")).rows[0].pid; return work(tx); })
        };
        pending = editChatMessage(tracked, p[0], command);
        pending.catch(() => { });
        await waitBlocked(f, () => pid, blocker);
        await new Promise(resolve => setTimeout(resolve, 2100));
        await held.query("COMMIT");
        assert.deepEqual(await withDeadline(pending, 5000, "edit completion"), {
            ok: false,
            error: "unavailable"
        });
        assert.equal((await f.domainPool.query("SELECT version FROM chat_messages WHERE id=$1", [source.id])).rows[0].version, 1);
        assert.equal((await f.domainPool.query("SELECT count(*)::int n FROM chat_edit_receipts")).rows[0].n, 0);
    }
    finally {
        await held.query("ROLLBACK");
        held.release();
        if (pending)
            await withDeadline(Promise.allSettled([pending]), 5000, "edit cleanup");
        await f.close();
    }
});
test("native 022 migration atomically backfills live originals and preserves unknown tombstones; rollback restores guard", async () => {
    const { f, a, db, principals: p } = await replyFixture({
        skipChatEditingMigration: true
    });
    const tx = await f.domainPool.connect();
    try {
        const source = await root(f, a);
        assert.equal((await deleteChatMessage(db, p[0], remove(a, source.id))).ok, true);
        const before = (await tx.query("SELECT to_jsonb(m) row FROM chat_messages m ORDER BY couple_id,seq")).rows;
        const guard = (await tx.query("SELECT pg_get_functiondef('guard_chat_reply()'::regprocedure) def")).rows[0].def;
        const migration = await readFile(new URL("../../migrations/022_chat_message_edits.sql", import.meta.url), "utf8");
        await tx.query("BEGIN");
        await tx.query(migration);
        await assert.rejects(tx.query("SELECT 1/0"));
        await tx.query("ROLLBACK");
        assert.equal((await tx.query("SELECT pg_get_functiondef('guard_chat_reply()'::regprocedure) def")).rows[0].def, guard);
        assert.deepEqual((await tx.query("SELECT to_jsonb(m) row FROM chat_messages m ORDER BY couple_id,seq")).rows, before);
        await assert.rejects(tx.query("UPDATE chat_messages SET body='forbidden',version=version+1 WHERE deleted_at IS NULL"), /invalid_chat_tombstone_transition/);
        await tx.query("BEGIN");
        await tx.query(migration);
        await tx.query("COMMIT");
        assert.deepEqual((await tx.query("SELECT to_jsonb(m)-'original_body_hash' row FROM chat_messages m ORDER BY couple_id,seq")).rows, before);
        assert.equal((await tx.query("SELECT original_body_hash FROM chat_messages WHERE id=$1", [source.id])).rows[0].original_body_hash, null);
        assert.equal((await tx.query("SELECT bool_and(original_body_hash=sha256(convert_to(body,'UTF8'))) valid FROM chat_messages WHERE deleted_at IS NULL")).rows[0].valid, true);
        await assert.rejects(tx.query("UPDATE chat_messages SET original_body_hash=sha256(convert_to('fabricated','UTF8')),version=version+1 WHERE id=$1", [source.id]), /immutable_chat_identity/);
        assert.equal((await tx.query("SELECT count(*)::int n FROM chat_edit_receipts")).rows[0].n, 0);
        await assert.rejects(tx.query(`INSERT INTO chat_messages(couple_id,sender_id,client_message_id,seq,body,version)
          SELECT couple_id,sender_id,gen_random_uuid(),900,'Forged revision',2 FROM chat_messages WHERE id=$1`, [source.id]), /new_chat_version_must_be_one/);
    }
    finally {
        await tx.query("ROLLBACK");
        tx.release();
        await f.close();
    }
});
