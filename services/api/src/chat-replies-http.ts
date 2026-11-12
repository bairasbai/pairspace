import type { AuthorizedDatabase } from "./contracts.ts";
import { readJson } from "./http.ts";
import { isUuid } from "./validation.ts";
import { windowReadId } from "./chat-history-window-http.ts";
import { readChatMessage, sendChatReply } from "./chat-replies.ts";
export function createChatRepliesHandler(db: AuthorizedDatabase) {
    return async (request: Request): Promise<Response> => {
        const url = new URL(request.url), reading = url.pathname.endsWith("/message-detail");
        const response = (status: number, body: unknown) => Response.json(body, {
            status,
            headers: {
                "cache-control": "no-store",
                "x-content-type-options": "nosniff"
            }
        });
        const fail = (status: number, error: string) => response(status, {
            ok: false,
            error,
            ...(reading ? {
                readId: windowReadId(request)
            } : {})
        });
        try {
            const route = url.pathname.match(/^\/v1\/couples\/([^/]+)\/chat\/(replies|message-detail)$/);
            if (!route)
                return fail(404, "not_found");
            if (request.method !== (reading ? "GET" : "POST"))
                return fail(405, "method_not_allowed");
            const p = await db.sessionAuthority.authenticate(request);
            if (!p || p.source !== db.sessionAuthority.source || !isUuid(p.userId))
                return fail(401, "unauthenticated");
            let input: unknown;
            if (reading) {
                const q = url.searchParams, keys = ["membership_epoch", "message_id", "read_id"];
                if ([...q.keys()].length !== 3 || keys.some(k => q.getAll(k).length !== 1) || !windowReadId(request) || !/^[1-9][0-9]*$/.test(q.get("membership_epoch") ?? ""))
                    return fail(400, "invalid_request");
                input = {
                    coupleId: route[1],
                    membershipEpoch: Number(q.get("membership_epoch")),
                    messageId: q.get("message_id"),
                    readId: windowReadId(request)
                };
            }
            else {
                if (url.search)
                    return fail(400, "invalid_request");
                if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json")
                    return fail(415, "unsupported_media_type");
                let raw: unknown;
                try {
                    raw = await readJson(request);
                }
                catch {
                    return fail(400, "invalid_request");
                }
                if (!raw || typeof raw !== "object" || Array.isArray(raw))
                    return fail(400, "invalid_request");
                const f = raw as Record<string, unknown>;
                if (Object.keys(f).sort().join(",") !== "body,client_message_id,membership_epoch,reply_to_id" || !isUuid(f.client_message_id) || request.headers.get("idempotency-key") !== f.client_message_id)
                    return fail(400, "invalid_request");
                input = {
                    coupleId: route[1],
                    membershipEpoch: f.membership_epoch,
                    clientId: f.client_message_id,
                    replyToId: f.reply_to_id,
                    body: f.body
                };
            }
            const result = reading ? await readChatMessage(db, p, input) : await sendChatReply(db, p, input);
            if (!result.ok)
                return fail(result.error === "unavailable" ? 403 : result.error === "stale_membership" || result.error === "idempotency_conflict" || result.error === "reply_unavailable" ? 409 : 400, result.error);
            return response("replay" in result.value && !result.value.replay ? 201 : 200, result);
        }
        catch {
            return fail(503, "temporarily_unavailable");
        }
    };
}
