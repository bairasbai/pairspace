import type { AuthorizedDatabase } from "./contracts.ts";
import { readJson } from "./http.ts";
import { isUuid } from "./validation.ts";
import { deleteChatMessage } from "./chat-deletion.ts";
export function createChatDeletionHandler(db: AuthorizedDatabase) {
    return async (request: Request): Promise<Response> => {
        const response = (status: number, body: unknown) => Response.json(body, {
            status,
            headers: {
                "cache-control": "no-store",
                "x-content-type-options": "nosniff"
            }
        });
        const fail = (status: number, error: string) => response(status, {
            ok: false,
            error
        });
        try {
            const url = new URL(request.url), route = url.pathname.match(/^\/v1\/couples\/([^/]+)\/chat\/messages\/([^/]+)$/);
            if (!route)
                return fail(404, "not_found");
            if (request.method !== "DELETE")
                return fail(405, "method_not_allowed");
            const p = await db.sessionAuthority.authenticate(request);
            if (!p || p.source !== db.sessionAuthority.source || !isUuid(p.userId))
                return fail(401, "unauthenticated");
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
            if (Object.keys(f).sort().join(",") !== "command_id,expected_version,membership_epoch,scope" || !isUuid(f.command_id) || f.command_id !== request.headers.get("idempotency-key"))
                return fail(400, "invalid_request");
            const result = await deleteChatMessage(db, p, {
                coupleId: route[1],
                messageId: route[2],
                membershipEpoch: f.membership_epoch,
                commandId: f.command_id,
                expectedVersion: f.expected_version,
                scope: f.scope
            });
            if (!result.ok && result.error === "message_deleted") return response(409, result);
        if (!result.ok)
                return fail(result.error === "unavailable" ? 403 : result.error === "invalid_request" ? 400 : 409, result.error);
            return response(200, result);
        }
        catch {
            return fail(503, "temporarily_unavailable");
        }
    };
}
