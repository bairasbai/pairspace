import type { AuthorizedDatabase, Principal, Result, SqlExecutor } from "./contracts.ts";
import { authorizeChat } from "./chat.ts";
import { activeSession, validPrincipal } from "./session.ts";
import { isEpoch, isUuid, parseSend } from "./validation.ts";
import { readChatWindow, type ReplyMessage, type ReplyWindow } from "./chat-history-window.ts";
export type { ReplyMessage, ReplyWindow } from "./chat-history-window.ts";
export type Row = {
    id: string;
    couple_id: string;
    sender_id: string;
    client_message_id: string;
    seq: string;
    body: string | null;
    deleted_at: string | null;
    version: number;
    created_at: string;
    reply_to_id: string | null;
};
export const columns = "id,couple_id,sender_id,client_message_id,seq::text AS seq,body,version,created_at::text AS created_at,reply_to_id,deleted_at::text AS deleted_at";
export const convert = (r: Row): ReplyMessage => ({
    id: r.id,
    coupleId: r.couple_id,
    senderId: r.sender_id,
    clientId: r.client_message_id,
    seq: Number(r.seq),
    body: r.body,
    version: r.version,
    createdAt: r.created_at,
    replyToId: r.reply_to_id,
    deletedAt: r.deleted_at ? new Date(r.deleted_at).toISOString() : null
});
async function target(tx: SqlExecutor, coupleId: string, id: string) {
    return (await tx.query<Row>(`SELECT ${columns} FROM chat_messages m WHERE couple_id=$1 AND id=$2
    AND EXISTS(SELECT 1 FROM couple_members cm WHERE cm.couple_id=m.couple_id AND cm.user_id=m.sender_id AND cm.status='active')`, [coupleId, id])).rows[0];
}
function fields(input: unknown, keys: string) {
    if (!input || typeof input !== "object" || Array.isArray(input))
        return null;
    return Object.keys(input).sort().join(",") === keys.split(",").sort().join(",") ? input as Record<string, unknown> : null;
}
export async function sendChatReply(db: AuthorizedDatabase, p: Principal, input: unknown): Promise<Result<{
    message: ReplyMessage;
    replay: boolean;
}>> {
    if (!validPrincipal(p))
        return {
            ok: false,
            error: "unavailable"
        };
    const f = fields(input, "coupleId,membershipEpoch,clientId,body,replyToId");
    if (!f || !isUuid(f.replyToId))
        return {
            ok: false,
            error: "invalid_request"
        };
    const parsed = parseSend(f);
    if (!parsed.ok)
        return parsed;
    const { coupleId, membershipEpoch, clientId, body } = parsed.value, replyToId = f.replyToId.toLowerCase();
    return db.transaction(async (tx) => {
        if (!await activeSession(tx, db, p))
            return {
                ok: false,
                error: "unavailable"
            };
        const denied = await authorizeChat(tx, p, coupleId, membershipEpoch, true);
        if (denied)
            return {
                ok: false,
                error: denied
            };
        if (!await activeSession(tx, db, p))
            return {
                ok: false,
                error: "unavailable"
            };
        const old = (await tx.query<Row>(`SELECT ${columns} FROM chat_messages WHERE couple_id=$1 AND sender_id=$2 AND client_message_id=$3`, [coupleId, p.userId, clientId])).rows[0];
        if (old) {
            if (old.deleted_at)
                return {
                    ok: false,
                    error: "reply_unavailable"
                };
            if (old.body !== body || old.reply_to_id !== replyToId)
                return {
                    ok: false,
                    error: "idempotency_conflict"
                };
            return {
                ok: true,
                value: {
                    message: convert(old),
                    replay: true
                }
            };
        }
        const parent = await target(tx, coupleId, replyToId);
        if (!parent || parent.deleted_at)
            return {
                ok: false,
                error: "reply_unavailable"
            };
        const seq = (await tx.query<{
            seq: string;
        }>("UPDATE couples SET next_chat_seq=next_chat_seq+1 WHERE id=$1 RETURNING (next_chat_seq-1)::text AS seq", [coupleId])).rows[0].seq;
        const made = (await tx.query<Row>(`INSERT INTO chat_messages(couple_id,sender_id,client_message_id,seq,body,reply_to_id)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING ${columns}`, [coupleId, p.userId, clientId, seq, body, replyToId])).rows[0];
        await tx.query("INSERT INTO outbox_events(couple_id,type,message_id) VALUES($1,'chat.message_created',$2)", [coupleId, made.id]);
        return {
            ok: true,
            value: {
                message: convert(made),
                replay: false
            }
        };
    });
}
export async function readChatMessage(db: AuthorizedDatabase, p: Principal, input: unknown): Promise<Result<{
    message: ReplyMessage;
    readId: string;
}>> {
    if (!validPrincipal(p))
        return {
            ok: false,
            error: "unavailable"
        };
    const f = fields(input, "coupleId,membershipEpoch,messageId,readId");
    if (!f || !isUuid(f.coupleId) || !isEpoch(f.membershipEpoch) || !isUuid(f.messageId) || !isUuid(f.readId))
        return {
            ok: false,
            error: "invalid_request"
        };
    const coupleId = f.coupleId, epoch = f.membershipEpoch, messageId = f.messageId, readId = f.readId.toLowerCase();
    return db.transaction(async (tx) => {
        if (!await activeSession(tx, db, p))
            return {
                ok: false,
                error: "unavailable"
            };
        const denied = await authorizeChat(tx, p, coupleId, epoch, false);
        if (denied)
            return {
                ok: false,
                error: denied
            };
        if (!await activeSession(tx, db, p))
            return {
                ok: false,
                error: "unavailable"
            };
        const row = await target(tx, coupleId, messageId);
        return row ? {
            ok: true,
            value: {
                message: convert(row),
                readId
            }
        } : {
            ok: false,
            error: "reply_unavailable"
        };
    });
}
export async function readReplyWindow(db: AuthorizedDatabase, p: Principal, input: unknown): Promise<Result<ReplyWindow>> {
    return await readChatWindow(db, p, input, true);
}
