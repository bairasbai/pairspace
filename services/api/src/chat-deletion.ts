import type { AuthorizedDatabase, Principal, ApiError } from "./contracts.ts";
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
    scope: string;
};
type Metadata = {
    id: string;
    sender_id: string;
    version: number;
    deleted_at: string | null;
};
export type DeleteChatResult = {
    commandId: string;
    replay: boolean;
    message: ReplyMessage;
};
export type DeleteChatOutcome =
    | { ok: true; value: DeleteChatResult }
    | { ok: false; error: Exclude<ApiError, 'message_deleted'> }
    | { ok: false; error: 'message_deleted'; value: { commandId: string; message: ReplyMessage } };

/** Own-author deletion; metadata-only receipts, no physical DELETE or historical body. */
export async function deleteChatMessage(db: AuthorizedDatabase, p: Principal, input: unknown): Promise<DeleteChatOutcome> {
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
    if (Object.keys(f).sort().join(",") !== "commandId,coupleId,expectedVersion,membershipEpoch,messageId,scope" || !isUuid(f.coupleId) || !isUuid(f.messageId) || !isUuid(f.commandId) || !isEpoch(f.membershipEpoch) || !Number.isInteger(f.expectedVersion) || Number(f.expectedVersion) < 1 || Number(f.expectedVersion) >= 2147483647 || f.scope !== "everyone")
        return {
            ok: false,
            error: "invalid_request"
        };
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
        const row = (await tx.query<Metadata>(`SELECT id,sender_id,version,deleted_at::text AS deleted_at
      FROM chat_messages WHERE couple_id=$1 AND id=$2 FOR UPDATE`, [coupleId, messageId])).rows[0];
        if (!await activeSession(tx, db, p))
            return {
                ok: false,
                error: "unavailable"
            };
        // The preceding session recheck occurs after both pair and message row locks.
        const old = (await tx.query<Receipt>(`SELECT couple_id,membership_epoch,message_id,expected_version,operation,scope
      FROM chat_deletion_receipts WHERE actor_id=$1 AND command_id=$2`, [p.userId, commandId])).rows[0];
        if (old && (old.couple_id !== coupleId || old.membership_epoch !== epoch || old.message_id !== messageId || old.expected_version !== version || old.operation !== "delete" || old.scope !== "everyone")) {
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
            const canonical = (await tx.query<Row>(`SELECT ${columns} FROM chat_messages WHERE couple_id=$1 AND id=$2`, [coupleId, messageId])).rows[0];
            if (!canonical || canonical.body !== null || canonical.deleted_at === null) throw new Error('invalid_deletion_canonical');
            return convert(canonical);
        };
        if (!old) {
            if (row.deleted_at !== null)
                return {
                    ok: false,
                    error: "message_deleted",
                    value: { commandId, message: await canonicalMessage() }
                };
            if (row.version !== version)
                return {
                    ok: false,
                    error: "version_conflict"
                };
            // Trusted SQL time rounded UP to milliseconds; preserve valid legacy microsecond created_at.
            // No client or injected service clock can backdate this terminal transition.
            const updated = await tx.query<{
                id: string;
            }>(`UPDATE chat_messages SET body=NULL,version=version+1,
        deleted_at=to_timestamp(ceil(extract(epoch FROM greatest(clock_timestamp(),created_at))*1000)/1000)
        WHERE couple_id=$1 AND id=$2 AND version=$3 AND deleted_at IS NULL RETURNING id`, [coupleId, messageId, version]);
            if (updated.rows.length !== 1)
                return {
                    ok: false,
                    error: "version_conflict"
                };
            await tx.query(`INSERT INTO chat_deletion_receipts(actor_id,command_id,couple_id,membership_epoch,message_id,expected_version,operation,scope)
        VALUES($1,$2,$3,$4,$5,$6,'delete','everyone')`, [p.userId, commandId, coupleId, epoch, messageId, version]);
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
