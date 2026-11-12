import { readFile } from "node:fs/promises";
import { beforeAll, afterAll, it, expect } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createFixture, adapter, principal, identityPrincipal, u2, u3, c1, c2, id, failOn } from "./fixtures.ts";
import { sendMessage, readHistory } from "../src/chat.ts";
import { sendChatReply, readChatMessage, readReplyWindow } from "../src/chat-replies.ts";
import { createChatRepliesHandler } from "../src/chat-replies-http.ts";
import { createChatWindowHandler } from "../src/chat-history-window-http.ts";
import { bindSessionAuthority } from "../src/auth-authority.ts";
import { createSyntheticAuthority } from "../src/synthetic-authority.ts";
let pg: PGlite, rootId: string, replyId: string;
const scope = {
    coupleId: c1,
    membershipEpoch: 1
}, read = {
    ...scope,
    readId: id(9000)
};
const old = {
    ...scope,
    clientId: id(8000),
    body: "Original synthetic\nmessage"
};
const reply = () => ({
    ...scope,
    clientId: id(8001),
    body: "  Reply\r\nbody ",
    replyToId: rootId
});
beforeAll(async () => {
    pg = await createFixture();
    const made = await sendMessage(adapter(pg), principal, old);
    if (!made.ok)
        throw Error("fixture");
    rootId = made.value.message.id;
    await pg.exec(await readFile(new URL("../migrations/020_chat_replies.sql", import.meta.url), "utf8"));
});
afterAll(async () => { await pg.close(); });
it("upgrades legacy messages, binds reply identity and retries, atomic outbox failure", async () => {
    const db = adapter(pg);
    expect(await readChatMessage(db, principal, {
        ...read,
        messageId: rootId
    })).toMatchObject({
        ok: true,
        value: {
            message: {
                replyToId: null,
                deletedAt: null,
                body: old.body
            }
        }
    });
    await expect(sendChatReply(failOn(db, "INSERT INTO outbox_events"), principal, reply())).rejects.toThrow("simulated_failure");
    expect((await pg.query("SELECT count(*)::int n FROM chat_messages")).rows[0]).toEqual({
        n: 1
    });
    const made = await sendChatReply(db, principal, reply());
    if (!made.ok)
        throw Error("fixture");
    replyId = made.value.message.id;
    expect(made.value.message).toMatchObject({
        replyToId: rootId,
        deletedAt: null,
        seq: 2,
        body: "  Reply\nbody "
    });
    expect(await sendChatReply(db, principal, reply())).toMatchObject({
        ok: true,
        value: {
            replay: true,
            message: {
                id: replyId
            }
        }
    });
    expect(await sendMessage(db, principal, {
        ...reply(),
        body: "  Reply\nbody "
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
    expect(await sendChatReply(db, principal, {
        ...reply(),
        clientId: old.clientId,
        body: old.body
    })).toEqual({
        ok: false,
        error: "idempotency_conflict"
    });
    expect(await sendChatReply(db, identityPrincipal(u2), {
        ...reply(),
        clientId: id(8002),
        replyToId: replyId
    })).toMatchObject({
        ok: true
    });
    const legacy = await readHistory(db, principal, {
        ...scope,
        limit: 50
    });
    if (!legacy.ok)
        throw Error("fixture");
    expect(Object.keys(legacy.value.messages[0])).not.toContain("replyToId");
    expect(await readReplyWindow(db, principal, {
        ...read,
        direction: "latest"
    })).toMatchObject({
        ok: true,
        value: {
            messages: [{
                    replyToId: null
                }, {
                    replyToId: rootId
                }, {
                    replyToId: replyId
                }]
        }
    });
});
// Synthetic SQL transitions below are not a product deletion endpoint.
it("terminal internal tombstone never resurrects on replay; old routes omit it and detail returns no body", async () => {
    const db = adapter(pg);
    await pg.query("UPDATE chat_messages SET body=NULL,deleted_at=date_trunc('milliseconds',clock_timestamp()),version=version+1 WHERE id=$1", [rootId]);
    expect(await readChatMessage(db, identityPrincipal(u2), {
        ...read,
        messageId: rootId
    })).toMatchObject({
        ok: true,
        value: {
            message: {
                id: rootId,
                body: null,
                version: 2,
                deletedAt: expect.any(String)
            }
        }
    });
    expect(await sendMessage(db, principal, old)).toEqual({
        ok: false,
        error: "unavailable"
    });
    expect(await sendChatReply(db, principal, {
        ...reply(),
        clientId: id(8003)
    })).toEqual({
        ok: false,
        error: "reply_unavailable"
    });
    const legacy = await readHistory(db, principal, {
        ...scope,
        limit: 50
    });
    if (!legacy.ok)
        throw Error("fixture");
    expect(legacy.value.messages.map(m => m.id)).not.toContain(rootId);
    expect(await sendChatReply(db, principal, reply())).toMatchObject({
        ok: true,
        value: {
            replay: true,
            message: {
                replyToId: rootId
            }
        }
    });
    await pg.query("UPDATE chat_messages SET body=NULL,deleted_at=date_trunc('milliseconds',clock_timestamp()),version=version+1 WHERE id=$1", [replyId]);
    expect(await sendChatReply(db, principal, reply())).toEqual({
        ok: false,
        error: "reply_unavailable"
    });
    for (const sql of ["UPDATE chat_messages SET body='restored' WHERE id=$1", "UPDATE chat_messages SET reply_to_id=NULL WHERE id=$1", "DELETE FROM chat_messages WHERE id=$1"]) {
        await expect(pg.query(sql, [replyId])).rejects.toThrow();
    }
});
it("rejects foreign/missing targets and malformed commands without existence leakage", async () => {
    const db = adapter(pg);
    for (const input of [null, {}, {
            ...reply(),
            replyToId: null
        }, {
            ...reply(),
            extra: true
        }, {
            ...reply(),
            body: " "
        }])
        expect((await sendChatReply(db, principal, input)).ok).toBe(false);
    expect(await sendChatReply(db, principal, {
        ...reply(),
        clientId: id(8004),
        replyToId: id(9999)
    })).toEqual({
        ok: false,
        error: "reply_unavailable"
    });
    expect(await sendChatReply(db, identityPrincipal(u3), reply())).toEqual({
        ok: false,
        error: "unavailable"
    });
    expect(await sendChatReply(db, principal, {
        ...reply(),
        membershipEpoch: 2
    })).toEqual({
        ok: false,
        error: "stale_membership"
    });
    expect(await readChatMessage(db, principal, {})).toEqual({
        ok: false,
        error: "invalid_request"
    });
    expect(await readChatMessage(db, principal, {
        ...read,
        messageId: id(9999)
    })).toEqual({
        ok: false,
        error: "reply_unavailable"
    });
    expect(await readChatMessage(db, principal, {
        ...read,
        coupleId: c2,
        messageId: rootId
    })).toEqual({
        ok: false,
        error: "unavailable"
    });
});
it("strict reply transport, detail nonce and distinct read projection", async () => {
    const db = bindSessionAuthority(adapter(pg), createSyntheticAuthority(async () => principal)), h = createChatRepliesHandler(db), base = `http://localhost/v1/couples/${c1}/chat/`;
    const detail = (query = "membership_epoch=1&message_id=" + rootId + "&read_id=" + id(9000)) => new Request(base + "message-detail?" + query, {
        headers: {
            authorization: "Bearer test"
        }
    });
    expect((await h(detail())).status).toBe(200);
    expect((await h(detail(""))).status).toBe(400);
    const post = (body: unknown, headers = {}) => new Request(base + "replies", {
        method: "POST",
        headers: {
            authorization: "Bearer test",
            "content-type": "application/json",
            "idempotency-key": id(8005),
            ...headers
        },
        body: JSON.stringify(body)
    });
    const raw = {
        membership_epoch: 1,
        client_message_id: id(8005),
        reply_to_id: rootId,
        body: "Reply"
    };
    expect((await h(post(raw))).status).toBe(409);
    expect((await h(post({
        ...raw,
        author_id: u2
    }))).status).toBe(400);
    expect((await h(post(null))).status).toBe(400);
    expect((await h(post(raw, {
        "content-type": "text/plain"
    }))).status).toBe(415);
    expect((await h(new Request(base + "replies"))).status).toBe(405);
    expect((await h(new Request(base + "other"))).status).toBe(404);
    expect((await createChatRepliesHandler(bindSessionAuthority(adapter(pg), createSyntheticAuthority(async () => null)))(detail())).status).toBe(401);
    expect((await createChatRepliesHandler(bindSessionAuthority(failOn(adapter(pg), "FROM couples"), createSyntheticAuthority(async () => principal)))(detail())).status).toBe(503);
    const window = createChatWindowHandler(db, true);
    expect((await window(new Request(base + "reply-window?membership_epoch=1&read_id=" + id(9000) + "&direction=latest", {
        headers: {
            authorization: "Bearer test"
        }
    }))).status).toBe(200);
});
it("checks identity and renewed session after pair lock for both new use cases", async () => {
    const db = adapter(pg);
    const live = (await pg.query<{
        id: string;
    }>("SELECT id FROM chat_messages WHERE deleted_at IS NULL LIMIT 1")).rows[0].id;
    const command = {
        ...reply(),
        clientId: id(8010),
        replyToId: live
    };
    const detail = {
        ...read,
        messageId: live
    };
    for (const p of [{
            ...principal,
            userId: "bad"
        }, {
            ...principal,
            tokenExpiresAt: 1
        }]) {
        expect(await sendChatReply(db, p, command)).toEqual({
            ok: false,
            error: "unavailable"
        });
        expect(await readChatMessage(db, p, detail)).toEqual({
            ok: false,
            error: "unavailable"
        });
    }
    for (const run of [sendChatReply, readChatMessage]) {
        let checks = 0;
        const revoked = {
            ...db,
            sessionAuthority: {
                ...db.sessionAuthority,
                recheck: async () => ++checks === 1
            }
        };
        expect(await run(revoked, principal, run === sendChatReply ? command : detail)).toEqual({
            ok: false,
            error: "unavailable"
        });
    }
    expect(await readChatMessage(db, principal, {
        ...detail,
        membershipEpoch: 2
    })).toEqual({
        ok: false,
        error: "stale_membership"
    });
});
it("successful reply HTTP and deterministic errors preserve transport envelopes", async () => {
    const db = bindSessionAuthority(adapter(pg), createSyntheticAuthority(async () => principal)), h = createChatRepliesHandler(db);
    const live = (await pg.query<{
        id: string;
    }>("SELECT id FROM chat_messages WHERE deleted_at IS NULL LIMIT 1")).rows[0].id;
    const base = `http://localhost/v1/couples/${c1}/chat/replies`;
    const value = {
        membership_epoch: 1,
        client_message_id: id(8011),
        reply_to_id: live,
        body: "HTTP reply"
    };
    const request = (body: string = JSON.stringify(value), suffix = "", key = id(8011)) => new Request(base + suffix, {
        method: "POST",
        headers: {
            authorization: "Bearer test",
            "content-type": "application/json",
            "idempotency-key": key
        },
        body
    });
    expect((await h(request())).status).toBe(201);
    expect((await h(request())).status).toBe(200);
    expect((await h(request(JSON.stringify({
        ...value,
        body: "changed"
    })))).status).toBe(409);
    expect((await h(request("{"))).status).toBe(400);
    expect((await h(request("{}", "?extra=1"))).status).toBe(400);
    expect((await h(request(JSON.stringify(value), "", id(8012)))).status).toBe(400);
    expect((await h(request(JSON.stringify({
        ...value,
        reply_to_id: null
    })))).status).toBe(400);
});
it('unauthenticated reply POST never reaches domain writes', async () => {
    const db = bindSessionAuthority(adapter(pg), createSyntheticAuthority(async () => null));
    const handler = createChatRepliesHandler(db);
    const request = new Request(`http://localhost/v1/couples/${c1}/chat/replies`, {
        method: 'POST',
        headers: { authorization: 'Bearer invalid', 'content-type': 'application/json', 'idempotency-key': id(8020) },
        body: JSON.stringify({ membership_epoch: 1, client_message_id: id(8020), reply_to_id: rootId, body: 'Unauthenticated' }),
    });
    expect((await handler(request)).status).toBe(401);
    expect((await pg.query('SELECT count(*)::int n FROM chat_messages WHERE client_message_id=$1', [id(8020)])).rows[0]).toEqual({ n: 0 });
});
