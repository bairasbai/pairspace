import { createHash } from "node:crypto";
import type { AuthorizedDatabase, Principal, ApiError } from "./contracts.ts";
import { normalizeMessageText } from "../../../packages/domain/chat/text.ts";
import { authorizeChat } from "./chat.ts";
import { activeSession, validPrincipal } from "./session.ts";
import { isEpoch, isUuid } from "./validation.ts";
import { columns, convert, type Row, type ReplyMessage } from "./chat-replies.ts";
type Receipt = {
    couple_id: string;
    membership_epoch: number;
    message_id: string;
    expected_version: number;
    operation: string;
    body_hash: Uint8Array;
};
type Metadata = {
    sender_id: string;
    version: number;
    deleted_at: string | null;
    same_body: boolean | null;
};
export type EditChatOutcome = {
    ok: true;
    value: {
        commandId: string;
        replay: boolean;
        message: ReplyMessage;
    };
} | {
    ok: false;
    error: Exclude<ApiError, "message_deleted">;
} | {
    ok: false;
    error: "message_deleted";
    value: {
        commandId: string;
        message: ReplyMessage;
    };
};
export async function editChatMessage(db: AuthorizedDatabase, p: Principal, input: unknown): Promise<EditChatOutcome> {
    if (!validPrincipal(p))
        return {
            ok: false,
            error: "unavailable"
        };
    if (!input || typeof input !== "object" || Array.isArray(input))
        return {
            ok: false,
            error: "invalid_request"
        };
    const f = input as Record<string, unknown>;
    if (Object.keys(f).sort().join(",") !== "body,commandId,coupleId,expectedVersion,membershipEpoch,messageId" || !isUuid(f.coupleId) || !isUuid(f.messageId) || !isUuid(f.commandId) || !isEpoch(f.membershipEpoch) || !Number.isInteger(f.expectedVersion) || Number(f.expectedVersion) < 1 || Number(f.expectedVersion) >= 2147483647) {
        return {
            ok: false,
            error: "invalid_request"
        };
    }
    const normalized = normalizeMessageText(f.body);
    if (!normalized.ok)
        return normalized;
    const body = normalized.text, hash = createHash("sha256").update(body).digest();
    const coupleId = f.coupleId.toLowerCase(), messageId = f.messageId.toLowerCase();
    const commandId = f.commandId.toLowerCase(), epoch = f.membershipEpoch, version = Number(f.expectedVersion);
    return db.transaction(async (tx) => {
        if (!await activeSession(tx, db, p))
            return {
                ok: false,
                error: "unavailable"
            };
        const denied = await authorizeChat(tx, p, coupleId, epoch, true);
        if (denied)
            return {
                ok: false,
                error: denied
            };
        const row = (await tx.query<Metadata>(`SELECT sender_id,version,deleted_at::text AS deleted_at,body=$3 AS same_body
      FROM chat_messages WHERE couple_id=$1 AND id=$2 FOR UPDATE`, [coupleId, messageId, body])).rows[0];
        if (!await activeSession(tx, db, p))
            return {
                ok: false,
                error: "unavailable"
            };
        const old = (await tx.query<Receipt>(`SELECT couple_id,membership_epoch,message_id,expected_version,operation,body_hash
      FROM chat_edit_receipts WHERE actor_id=$1 AND command_id=$2`, [p.userId, commandId])).rows[0];
        if (old && (old.couple_id !== coupleId || old.membership_epoch !== epoch || old.message_id !== messageId || old.expected_version !== version || old.operation !== "edit" || !Buffer.from(old.body_hash).equals(hash))) {
            return {
                ok: false,
                error: "idempotency_conflict"
            };
        }
        if (!row || row.sender_id !== p.userId)
            return {
                ok: false,
                error: "message_unavailable"
            };
        const canonicalMessage = async () => {
            const current = (await tx.query<Row>(`SELECT ${columns} FROM chat_messages WHERE couple_id=$1 AND id=$2`, [coupleId, messageId])).rows[0];
            if (!current)
                throw new Error("missing_edit_canonical");
            return convert(current);
        };
        if (!old) {
            if (row.deleted_at !== null)
                return {
                    ok: false,
                    error: "message_deleted",
                    value: {
                        commandId,
                        message: await canonicalMessage()
                    }
                };
            if (row.version !== version)
                return {
                    ok: false,
                    error: "version_conflict"
                };
            const isNoop = row.same_body === true;
            if (!isNoop) {
                const updated = await tx.query<{
                    id: string;
                }>(`UPDATE chat_messages SET body=$4,version=version+1
            WHERE couple_id=$1 AND id=$2 AND version=$3 AND deleted_at IS NULL RETURNING id`, [coupleId, messageId, version, body]);
                if (updated.rows.length !== 1)
                    return {
                        ok: false,
                        error: "version_conflict"
                    };
            }
            await tx.query(`INSERT INTO chat_edit_receipts(actor_id,command_id,couple_id,membership_epoch,message_id,expected_version,operation,body_hash,applied_version,is_noop)
        VALUES($1,$2,$3,$4,$5,$6,'edit',$7,$8,$9)`, [p.userId, commandId, coupleId, epoch, messageId, version, hash, isNoop ? version : version + 1, isNoop]);
        }
        return {
            ok: true,
            value: {
                commandId,
                replay: Boolean(old),
                message: await canonicalMessage()
            }
        };
    });
}
