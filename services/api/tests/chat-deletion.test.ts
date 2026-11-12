import { readFile } from "node:fs/promises";
import { beforeAll, afterAll, it, expect } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { adapter, createFixture, principal, identityPrincipal, u2, u3, c1, c2, id, failOn } from "./fixtures.ts";
import { sendMessage } from "../src/chat.ts";
import { sendChatReply, readChatMessage } from "../src/chat-replies.ts";
import { deleteChatMessage } from "../src/chat-deletion.ts";
import { createChatDeletionHandler } from "../src/chat-deletion-http.ts";
import { bindSessionAuthority } from "../src/auth-authority.ts";
import { createSyntheticAuthority } from "../src/synthetic-authority.ts";
let pg: PGlite;
let target: string;
const scope = {
    coupleId: c1,
    membershipEpoch: 1
};
const send = {
    ...scope,
    clientId: id(7000),
    body: "Synthetic own message"
};
const command = () => ({
    ...scope,
    messageId: target,
    commandId: id(7000),
    expectedVersion: 1,
    scope: "everyone"
});
beforeAll(async () => {
    pg = await createFixture();
    for (const file of ["020_chat_replies.sql"])
        await pg.exec(await readFile(new URL("../migrations/" + file, import.meta.url), "utf8"));
    const made = await sendMessage(adapter(pg), principal, send);
    if (!made.ok)
        throw Error("fixture");
    target = made.value.message.id;
    await pg.exec(await readFile(new URL("../migrations/021_chat_deletion_receipts.sql", import.meta.url), "utf8"));
});
afterAll(async () => { await pg.close(); });
it("only author can delete, rollback preserves body and retry returns canonical without retaining plaintext", async () => {
    const db = adapter(pg);
    for (const [p, value] of [[identityPrincipal(u2), command()], [principal, {
                ...command(),
                messageId: id(7999)
            }]] as const)
        expect(await deleteChatMessage(db, p, value)).toEqual({
            ok: false,
            error: "message_unavailable"
        });
    expect(await deleteChatMessage(db, principal, {
        ...command(),
        expectedVersion: 2
    })).toEqual({
        ok: false,
        error: "version_conflict"
    });
    await expect(deleteChatMessage(failOn(db, "INSERT INTO chat_deletion_receipts"), principal, command())).rejects.toThrow("simulated_failure");
    expect((await pg.query("SELECT body,version,deleted_at FROM chat_messages WHERE id=$1", [target])).rows[0]).toEqual({
        body: send.body,
        version: 1,
        deleted_at: null
    });
    const made = await deleteChatMessage(db, principal, command());
    expect(made).toMatchObject({
        ok: true,
        value: {
            commandId: id(7000),
            replay: false,
            message: {
                id: target,
                body: null,
                version: 2,
                deletedAt: expect.any(String)
            }
        }
    });
    expect(await deleteChatMessage(db, principal, command())).toMatchObject({
        ok: true,
        value: {
            replay: true,
            message: {
                body: null,
                version: 2
            }
        }
    });
    expect(await deleteChatMessage(db, principal, {
        ...command(),
        commandId: id(7001)
    })).toMatchObject({
        ok: false,
        error: "message_deleted", value: { commandId: id(7001), message: { id: target, body: null, version: 2, deletedAt: expect.any(String) } }
    });
    expect(await deleteChatMessage(db, principal, {
        ...command(),
        expectedVersion: 2
    })).toEqual({
        ok: false,
        error: "idempotency_conflict"
    });
    expect(await deleteChatMessage(db, principal, {
        ...command(),
        messageId: id(7999)
    })).toEqual({
        ok: false,
        error: "idempotency_conflict"
    });
    expect(await sendMessage(db, principal, send)).toEqual({
        ok: false,
        error: "unavailable"
    });
    expect((await pg.query("SELECT count(*)::int n FROM outbox_events")).rows[0]).toEqual({
        n: 1
    });
    expect((await pg.query("SELECT count(*)::int n FROM chat_deletion_receipts")).rows[0]).toEqual({
        n: 1
    });
    await expect(pg.exec("UPDATE chat_deletion_receipts SET scope='everyone'")).rejects.toThrow("immutable_chat_deletion_receipt");
    await expect(pg.exec("DELETE FROM chat_deletion_receipts")).rejects.toThrow("immutable_chat_deletion_receipt");
});
it("deletes own replies, never restores on send replay and keeps a current tombstone readable to partner", async () => {
    const db = adapter(pg);
    const root = await sendMessage(db, principal, {
        ...send,
        clientId: id(7010)
    });
    if (!root.ok)
        throw Error("fixture");
    const reply = {
        ...scope,
        clientId: id(7011),
        body: "Partner reply",
        replyToId: root.value.message.id
    };
    const made = await sendChatReply(db, identityPrincipal(u2), reply);
    if (!made.ok)
        throw Error("fixture");
    const remove = {
        ...command(),
        messageId: made.value.message.id,
        commandId: id(7012)
    };
    expect(await deleteChatMessage(db, identityPrincipal(u2), remove)).toMatchObject({
        ok: true
    });
    expect(await sendChatReply(db, identityPrincipal(u2), reply)).toEqual({
        ok: false,
        error: "reply_unavailable"
    });
    expect(await readChatMessage(db, principal, {
        ...scope,
        readId: id(7013),
        messageId: made.value.message.id
    })).toMatchObject({
        ok: true,
        value: {
            message: {
                body: null,
                version: 2
            }
        }
    });
});
it("validates strict shape and rechecks authority after locks, including replay", async () => {
    const db = adapter(pg);
    for (const value of [null, [], {}, {
            ...command(),
            scope: "me"
        }, {
            ...command(),
            expectedVersion: 0
        }, {
            ...command(),
            expectedVersion: 2147483647
        }, {
            ...command(),
            expectedVersion: 1.5
        }, {
            ...command(),
            extra: true
        }, {
            ...command(),
            messageId: "bad"
        }, {
            ...command(),
            commandId: "bad"
        }])
        expect(await deleteChatMessage(db, principal, value)).toEqual({
            ok: false,
            error: "invalid_request"
        });
    expect(await deleteChatMessage(db, {
        ...principal,
        userId: "bad"
    }, command())).toEqual({
        ok: false,
        error: "unavailable"
    });
    expect(await deleteChatMessage(db, {
        ...principal,
        tokenExpiresAt: 1
    }, command())).toEqual({
        ok: false,
        error: "unavailable"
    });
    expect(await deleteChatMessage(db, identityPrincipal(u3), command())).toEqual({
        ok: false,
        error: "unavailable"
    });
    expect(await deleteChatMessage(db, principal, {
        ...command(),
        coupleId: c2
    })).toEqual({
        ok: false,
        error: "unavailable"
    });
    expect(await deleteChatMessage(db, principal, {
        ...command(),
        membershipEpoch: 2
    })).toEqual({
        ok: false,
        error: "stale_membership"
    });
    let checks = 0;
    const revoked = {
        ...db,
        sessionAuthority: {
            ...db.sessionAuthority,
            recheck: async () => ++checks === 1
        }
    };
    expect(await deleteChatMessage(revoked, principal, command())).toEqual({
        ok: false,
        error: "unavailable"
    });
});
it("SQL shape includes author identity and exact tombstone version without any body snapshot", async () => {
    await expect(pg.query("INSERT INTO chat_deletion_receipts(actor_id,command_id,couple_id,membership_epoch,message_id,expected_version,operation,scope) VALUES($1,$2,$3,1,$4,1,'send','everyone')", [principal.userId, id(7020), c1, target])).rejects.toThrow();
    await expect(pg.query("INSERT INTO chat_deletion_receipts(actor_id,command_id,couple_id,membership_epoch,message_id,expected_version,operation,scope) VALUES($1,$2,$3,1,$4,1,'delete','everyone')", [u2, id(7021), c1, target])).rejects.toThrow("invalid_chat_deletion_receipt");
    const cols = (await pg.query<{
        column_name: string;
    }>("SELECT column_name FROM information_schema.columns WHERE table_name='chat_deletion_receipts'")).rows.map(r => r.column_name);
    expect(cols.sort()).toEqual(["actor_id", "command_id", "couple_id", "expected_version", "membership_epoch", "message_id", "operation", "scope"]);
});
it("HTTP strict DELETE, authentication, replay and deterministic errors", async () => {
    const db = bindSessionAuthority(adapter(pg), createSyntheticAuthority(async () => principal)), h = createChatDeletionHandler(db);
    const base = `http://localhost/v1/couples/${c1}/chat/messages/${target}`;
    const body = {
        membership_epoch: 1,
        command_id: id(7000),
        expected_version: 1,
        scope: "everyone"
    };
    const request = (value: unknown = body, headers = {}, suffix = "") => new Request(base + suffix, {
        method: "DELETE",
        headers: {
            authorization: "Bearer synthetic",
            "content-type": "application/json",
            "idempotency-key": id(7000),
            ...headers
        },
        body: JSON.stringify(value)
    });
    expect((await h(request())).status).toBe(200);
    expect((await h(request({
        ...body,
        expected_version: 2
    }))).status).toBe(409);
    for (const value of [null, [], {}, {
            ...body,
            actor_id: u2
        }, {
            ...body,
            scope: "me"
        }])
        expect((await h(request(value))).status).toBe(400);
    expect((await h(request(body, {
        "content-type": "text/plain"
    }))).status).toBe(415);
    expect((await h(request(body, {}, "?x=1"))).status).toBe(400);
    expect((await h(new Request(base, {
        headers: {
            authorization: "Bearer synthetic"
        }
    }))).status).toBe(405);
    expect((await h(new Request(base + "/bad"))).status).toBe(404);
    expect((await h(new Request(base, {
        method: "DELETE",
        headers: {
            authorization: "Bearer synthetic",
            "content-type": "application/json"
        },
        body: "{"
    }))).status).toBe(400);
    expect((await createChatDeletionHandler(bindSessionAuthority(adapter(pg), createSyntheticAuthority(async () => null)))(request())).status).toBe(401);
    expect((await createChatDeletionHandler(bindSessionAuthority(adapter(pg), createSyntheticAuthority(async () => identityPrincipal(u3))))(request())).status).toBe(403);
    expect((await createChatDeletionHandler(bindSessionAuthority(failOn(adapter(pg), "FROM couples"), createSyntheticAuthority(async () => principal)))(request())).status).toBe(503);
});
it('fresh already-deleted command returns only canonical terminal data, without a new receipt', async () => {
    const db=bindSessionAuthority(adapter(pg),createSyntheticAuthority(async()=>principal));
    const handler=createChatDeletionHandler(db),commandId=id(7030);
    const before=(await pg.query('SELECT count(*)::int n FROM chat_deletion_receipts')).rows[0];
    const response=await handler(new Request(`http://localhost/v1/couples/${c1}/chat/messages/${target}`,{
        method:'DELETE',headers:{authorization:'Bearer synthetic','content-type':'application/json','idempotency-key':commandId},
        body:JSON.stringify({membership_epoch:1,command_id:commandId,expected_version:1,scope:'everyone'}),
    }));
    expect(response.status).toBe(409);
    const result=await response.json() as Record<string,unknown>;
    expect(Object.keys(result).sort()).toEqual(['error','ok','value']);
    expect(Object.keys(result.value as Record<string,unknown>).sort()).toEqual(['commandId','message']);
    expect(result).toMatchObject({ok:false,error:'message_deleted',value:{commandId,message:{id:target,body:null,version:2,deletedAt:expect.any(String)}}});
    expect((await pg.query('SELECT count(*)::int n FROM chat_deletion_receipts')).rows[0]).toEqual(before);
});
