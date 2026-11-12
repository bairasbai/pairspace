import { readFile } from "node:fs/promises";
import { beforeAll, afterAll, it, expect } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createFixture, adapter, principal, identityPrincipal, u2, u3, c1, c2, id, failOn } from "./fixtures.ts";
import { sendMessage } from "../src/chat.ts";
import { sendChatReply } from "../src/chat-replies.ts";
import { deleteChatMessage } from "../src/chat-deletion.ts";
import { editChatMessage } from "../src/chat-editing.ts";
import { originalChatBodyMatches } from "../src/chat-send-identity.ts";
import { createChatEditingHandler } from "../src/chat-editing-http.ts";
import { bindSessionAuthority } from "../src/auth-authority.ts";
import { createSyntheticAuthority } from "../src/synthetic-authority.ts";
let pg: PGlite, root: string, replyId: string, tomb: string;
const scope = {
    coupleId: c1,
    membershipEpoch: 1
};
const plain = {
    ...scope,
    clientId: id(6000),
    body: "Original plain"
};
const reply = () => ({
    ...scope,
    clientId: id(6001),
    body: "Original reply",
    replyToId: root
});
const edit = (messageId = root, commandId = id(6100), expectedVersion = 1, body = " Edited\r\ntext ") => ({
    ...scope,
    messageId,
    commandId,
    expectedVersion,
    body
});
const remove = (messageId: string, expectedVersion: number) => ({
    ...scope,
    messageId,
    expectedVersion,
    commandId: id(6200),
    scope: "everyone"
});
beforeAll(async () => {
    pg = await createFixture();
    for (const file of ["020_chat_replies.sql", "021_chat_deletion_receipts.sql"])
        await pg.exec(await readFile(new URL("../migrations/" + file, import.meta.url), "utf8"));
    const a = await sendMessage(adapter(pg), principal, plain);
    if (!a.ok)
        throw Error("fixture");
    root = a.value.message.id;
    const b = await sendChatReply(adapter(pg), principal, reply());
    if (!b.ok)
        throw Error("fixture");
    replyId = b.value.message.id;
    const c = await sendMessage(adapter(pg), principal, {
        ...plain,
        clientId: id(6002)
    });
    if (!c.ok)
        throw Error("fixture");
    tomb = c.value.message.id;
    expect(await deleteChatMessage(adapter(pg), principal, remove(tomb, 1))).toMatchObject({
        ok: true
    });
    const sql = await readFile(new URL("../migrations/022_chat_message_edits.sql", import.meta.url), "utf8");
    await pg.transaction(async (tx) => { await tx.exec(sql); });
});
afterAll(async () => { await pg.close(); });
it("backfills live original digests only and preserves original sends after edits, with atomic receipt failure", async () => {
    const db = adapter(pg);
    expect((await pg.query("SELECT original_body_hash FROM chat_messages WHERE id=$1", [tomb])).rows[0]).toEqual({
        original_body_hash: null
    });
    const before = (await pg.query("SELECT encode(original_body_hash,'hex') hash FROM chat_messages WHERE id=$1", [root])).rows[0];
    await expect(editChatMessage(failOn(db, "INSERT INTO chat_edit_receipts"), principal, edit())).rejects.toThrow("simulated_failure");
    expect((await pg.query("SELECT body,version FROM chat_messages WHERE id=$1", [root])).rows[0]).toEqual({
        body: plain.body,
        version: 1
    });
    expect(await editChatMessage(db, principal, edit())).toMatchObject({
        ok: true,
        value: {
            replay: false,
            message: {
                body: " Edited\ntext ",
                version: 2
            }
        }
    });
    expect(await sendMessage(db, principal, plain)).toMatchObject({
        ok: true,
        value: {
            replay: true,
            message: {
                body: " Edited\ntext ",
                version: 2
            }
        }
    });
    expect(await sendMessage(db, principal, {
        ...plain,
        body: " Edited\ntext "
    })).toEqual({
        ok: false,
        error: "idempotency_conflict"
    });
    expect(await editChatMessage(db, principal, edit(root, id(6101), 2, " Edited\r\ntext "))).toMatchObject({
        ok: true, value: { replay: false, message: { version: 2 } }
    });
    expect(await editChatMessage(db, principal, edit(root, id(6102), 2, plain.body))).toMatchObject({
        ok: true, value: { message: { version: 3, body: plain.body } }
    });
    expect(await editChatMessage(db, principal, edit())).toMatchObject({
        ok: true, value: { replay: true, message: { body: plain.body, version: 3 } }
    });
    expect((await pg.query('SELECT is_noop,applied_version FROM chat_edit_receipts WHERE command_id=$1',[id(6101)])).rows[0])
        .toEqual({ is_noop: true, applied_version: 2 });
    expect((await pg.query("SELECT encode(original_body_hash,'hex') hash FROM chat_messages WHERE id=$1", [root])).rows[0]).toEqual(before);
    expect(await editChatMessage(db, principal, edit(root, id(6100), 1, "Other intent"))).toEqual({
        ok: false,
        error: "idempotency_conflict"
    });
    expect(await editChatMessage(db, principal, edit(root, id(6110), 2))).toEqual({
        ok: false,
        error: "version_conflict"
    });
    await expect(pg.query("UPDATE chat_messages SET original_body_hash=sha256(convert_to('changed','UTF8')),version=version+1 WHERE id=$1", [root])).rejects.toThrow("immutable_chat_identity");
});
it("reply replay remains typed and parent-bound; edits retry tombstone canonical without resurrection", async () => {
    const db = adapter(pg);
    const command = edit(replyId, id(6103), 1, "Reply edited");
    expect(await editChatMessage(db, principal, command)).toMatchObject({
        ok: true
    });
    expect(await sendChatReply(db, principal, reply())).toMatchObject({
        ok: true,
        value: {
            replay: true,
            message: {
                body: "Reply edited",
                version: 2,
                replyToId: root
            }
        }
    });
    expect(await sendChatReply(db, principal, {
        ...reply(),
        body: "Reply edited"
    })).toEqual({
        ok: false,
        error: "idempotency_conflict"
    });
    expect(await sendChatReply(db, principal, {
        ...reply(),
        replyToId: replyId
    })).toEqual({
        ok: false,
        error: "idempotency_conflict"
    });
    expect(await sendMessage(db, principal, reply())).toEqual({
        ok: false,
        error: "idempotency_conflict"
    });
    expect(await deleteChatMessage(db, principal, {
        ...remove(replyId, 2),
        commandId: id(6201)
    })).toMatchObject({
        ok: true
    });
    expect(await editChatMessage(db, principal, command)).toMatchObject({
        ok: true,
        value: {
            replay: true,
            message: {
                body: null,
                version: 3,
                deletedAt: expect.any(String)
            }
        }
    });
    expect(await editChatMessage(db, principal, edit(replyId, id(6104), 2))).toMatchObject({
        ok: false,
        error: "message_deleted",
        value: {
            commandId: id(6104),
            message: {
                body: null,
                version: 3
            }
        }
    });
    expect(await sendChatReply(db, principal, reply())).toEqual({
        ok: false,
        error: "reply_unavailable"
    });
    expect(await sendMessage(db, principal, {
        ...plain,
        clientId: id(6002)
    })).toEqual({
        ok: false,
        error: "unavailable"
    });
    expect((await pg.query("SELECT count(*)::int n FROM outbox_events")).rows[0]).toEqual({
        n: 3
    });
});
it("strict input, author/scope/recheck and digest behavior", async () => {
    const db = adapter(pg);
    for (const value of [null, [], {}, {
            ...edit(),
            extra: true
        }, {
            ...edit(),
            expectedVersion: 0
        }, {
            ...edit(),
            expectedVersion: 2147483647
        }, {
            ...edit(),
            expectedVersion: 1.2
        }, {
            ...edit(),
            messageId: "bad"
        }])
        expect(await editChatMessage(db, principal, value)).toEqual({
            ok: false,
            error: "invalid_request"
        });
    for (const body of ["", " ", "x".repeat(8001), "\0"])
        expect((await editChatMessage(db, principal, edit(root, id(6120), 3, body))).ok).toBe(false);
    expect(await editChatMessage(db, principal, edit(id(6999), id(6199)))).toEqual({
        ok: false,
        error: "message_unavailable"
    });
    expect(await editChatMessage(db, identityPrincipal(u2), edit())).toEqual({
        ok: false,
        error: "message_unavailable"
    });
    expect(await editChatMessage(db, identityPrincipal(u3), edit())).toEqual({
        ok: false,
        error: "unavailable"
    });
    expect(await editChatMessage(db, principal, {
        ...edit(),
        coupleId: c2
    })).toEqual({
        ok: false,
        error: "unavailable"
    });
    expect(await editChatMessage(db, principal, {
        ...edit(),
        membershipEpoch: 2
    })).toEqual({
        ok: false,
        error: "stale_membership"
    });
    expect(await editChatMessage(db, {
        ...principal,
        userId: "bad"
    }, edit())).toEqual({
        ok: false,
        error: "unavailable"
    });
    expect(await editChatMessage(db, {
        ...principal,
        tokenExpiresAt: 1
    }, edit())).toEqual({
        ok: false,
        error: "unavailable"
    });
    let checks = 0;
    const revoked = {
        ...db,
        sessionAuthority: {
            ...db.sessionAuthority,
            recheck: async () => ++checks === 1
        }
    };
    expect(await editChatMessage(revoked, principal, edit())).toEqual({
        ok: false,
        error: "unavailable"
    });
    expect(originalChatBodyMatches({
        body: "old"
    }, "old")).toBe(true);
    expect(originalChatBodyMatches({
        body: "new",
        has_original_body_hash: true,
        original_body_hash: null
    }, "new")).toBe(false);
    await expect(pg.exec("DELETE FROM chat_edit_receipts")).rejects.toThrow("immutable_chat_edit_receipt");
    await expect(pg.exec("UPDATE chat_edit_receipts SET expected_version=expected_version")).rejects.toThrow("immutable_chat_edit_receipt");
});
it("PATCH transport pins the exact command and returns canonical terminal errors", async () => {
    const db = bindSessionAuthority(adapter(pg), createSyntheticAuthority(async () => principal)), handler = createChatEditingHandler(db);
    const base = `http://localhost/v1/couples/${c1}/chat/messages/`;
    const value = {
        membership_epoch: 1,
        command_id: id(6130),
        expected_version: 3,
        body: "HTTP edit"
    };
    const req = (body: unknown = value, messageId = root, headers = {}, suffix = "") => new Request(base + messageId + suffix, {
        method: "PATCH",
        headers: {
            authorization: "Bearer test",
            "content-type": "application/json",
            "idempotency-key": id(6130),
            ...headers
        },
        body: JSON.stringify(body)
    });
    expect((await handler(req())).status).toBe(200);
    expect((await handler(req())).status).toBe(200);
    expect((await handler(req({
        ...value,
        body: "Another"
    }))).status).toBe(409);
    const deleted = await handler(req(value, tomb));
    expect(deleted.status).toBe(409);
    expect(await deleted.json()).toMatchObject({
        error: "idempotency_conflict"
    });
    const terminal = await handler(req({
        ...value,
        command_id: id(6131)
    }, tomb, {
        "idempotency-key": id(6131)
    }));
    expect(await terminal.json()).toMatchObject({
        error: "message_deleted",
        value: {
            message: {
                body: null
            }
        }
    });
    for (const body of [null, [], {}, {
            ...value,
            author: u2
        }, {
            ...value,
            body: " "
        }])
        expect((await handler(req(body))).status).toBe(400);
    expect((await handler(req(value, root, {
        "content-type": "text/plain"
    }))).status).toBe(415);
    expect((await handler(req(value, root, {}, "?x=1"))).status).toBe(400);
    expect((await handler(new Request(base + root))).status).toBe(405);
    expect((await handler(new Request(base))).status).toBe(404);
    expect((await handler(new Request(base + root, {
        method: "PATCH",
        headers: {
            authorization: "Bearer test",
            "content-type": "application/json"
        },
        body: "{"
    }))).status).toBe(400);
    expect((await createChatEditingHandler(bindSessionAuthority(adapter(pg), createSyntheticAuthority(async () => null)))(req())).status).toBe(401);
    expect((await createChatEditingHandler(bindSessionAuthority(adapter(pg), createSyntheticAuthority(async () => identityPrincipal(u3))))(req())).status).toBe(403);
    expect((await createChatEditingHandler(bindSessionAuthority(failOn(adapter(pg), "FROM couples"), createSyntheticAuthority(async () => principal)))(req())).status).toBe(503);
});
it('normalized same-body saves preserve version one and immutable no-op receipts survive later changes', async () => {
    const db=adapter(pg);
    const made=await sendMessage(db,principal,{...scope,clientId:id(6400),body:' Same\nbody '});
    if(!made.ok)throw Error('fixture');
    const target=made.value.message.id;
    const command=edit(target,id(6401),1,' Same\r\nbody ');
    await expect(editChatMessage(failOn(db,'INSERT INTO chat_edit_receipts'),principal,command)).rejects.toThrow('simulated_failure');
    expect((await pg.query('SELECT body,version FROM chat_messages WHERE id=$1',[target])).rows[0]).toEqual({body:' Same\nbody ',version:1});
    expect((await pg.query('SELECT count(*)::int n FROM chat_edit_receipts WHERE command_id=$1',[id(6401)])).rows[0]).toEqual({n:0});
    expect(await editChatMessage(failOn(db,'UPDATE chat_messages'),principal,command)).toMatchObject({ok:true,value:{replay:false,message:{version:1,body:' Same\nbody '}}});
    expect(await editChatMessage(db,principal,{...command,body:'Different intent'})).toEqual({ok:false,error:'idempotency_conflict'});
    expect(await editChatMessage(db,principal,{...command,commandId:id(6402),expectedVersion:2})).toEqual({ok:false,error:'version_conflict'});
    expect(await editChatMessage(db,principal,edit(target,id(6403),1,'Edited'))).toMatchObject({ok:true,value:{message:{version:2}}});
    expect(await editChatMessage(db,principal,edit(target,id(6404),2,'Edited'))).toMatchObject({ok:true,value:{message:{version:2}}});
    expect(await editChatMessage(db,principal,edit(target,id(6405),2,' Same\nbody '))).toMatchObject({ok:true,value:{message:{version:3}}});
    expect(await editChatMessage(db,principal,command)).toMatchObject({ok:true,value:{replay:true,message:{version:3}}});
    expect(await deleteChatMessage(db,principal,{...remove(target,3),commandId:id(6406)})).toMatchObject({ok:true});
    expect(await editChatMessage(db,principal,command)).toMatchObject({ok:true,value:{replay:true,message:{body:null,version:4}}});
});
