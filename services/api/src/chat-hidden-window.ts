import type { AuthorizedDatabase, Principal, Result } from './contracts.ts';
import { authorizeChat } from './chat.ts';
import { activeSession, validPrincipal } from './session.ts';
import { isEpoch, isUuid } from './validation.ts';
import { chatVisibilityRevision } from './chat-visibility-scope.ts';
export type HiddenMetadata = {
    id: string;
    coupleId: string;
    clientId: string;
    replyToId: string | null;
    seq: number;
    createdAt: string;
    senderId: string;
    deletedAt: string | null;
    version: number;
    visibilityVersion: number;
};
export type HiddenWindow = {
    messages: HiddenMetadata[];
    readId: string;
    hasOlder: boolean;
    hasNewer: boolean;
    olderCursor: {
        id: string;
        seq: number;
    } | null;
    newerCursor: {
        id: string;
        seq: number;
    } | null;
};
type Row = {
    id: string;
    couple_id: string;
    client_message_id: string;
    reply_to_id: string | null;
    seq: string;
    created_at: string;
    sender_id: string;
    deleted_at: string | null;
    version: number;
    visibility_version: number;
};
export async function readHiddenWindow(db: AuthorizedDatabase, p: Principal, input: unknown): Promise<Result<HiddenWindow>> {
    if (!validPrincipal(p))
        return { ok: false, error: 'unavailable' };
    if (!input || typeof input !== 'object' || Array.isArray(input))
        return { ok: false, error: 'invalid_request' };
    const f = input as Record<string, unknown>;
    const anchored = f.direction === 'before' || f.direction === 'after';
    const keys = ['coupleId', 'membershipEpoch', 'readId', 'direction', ...(anchored ? ['anchorId', 'anchorSeq', 'visibilityRevision'] : [])].sort();
    if (Object.keys(f).sort().join(',') !== keys.join(',') || !isUuid(f.coupleId) || !isEpoch(f.membershipEpoch) || !isUuid(f.readId)
        || !['latest', 'oldest', 'before', 'after'].includes(String(f.direction)))
        return { ok: false, error: 'invalid_request' };
    if (anchored && (!isUuid(f.anchorId) || !Number.isSafeInteger(f.anchorSeq) || Number(f.anchorSeq) < 1
        || !Number.isSafeInteger(f.visibilityRevision) || Number(f.visibilityRevision) < 0))
        return { ok: false, error: 'invalid_cursor' };
    const couple = f.coupleId.toLowerCase(), epoch = f.membershipEpoch, readId = f.readId.toLowerCase();
    return db.transaction(async (tx) => {
        if (!await activeSession(tx, db, p))
            return { ok: false, error: 'unavailable' };
        const denied = await authorizeChat(tx, p, couple, epoch, false);
        if (denied)
            return { ok: false, error: denied };
        if (!await activeSession(tx, db, p))
            return { ok: false, error: 'unavailable' };
        if (anchored && await chatVisibilityRevision(tx) !== f.visibilityRevision)
            return { ok: false, error: 'visibility_changed' };
        const from = `FROM chat_messages m JOIN chat_message_visibility v ON v.message_id=m.id AND v.couple_id=m.couple_id
      WHERE m.couple_id=$1 AND v.actor_id=$2 AND v.membership_epoch=$3 AND v.hidden
      AND EXISTS(SELECT 1 FROM couple_members cm WHERE cm.couple_id=m.couple_id AND cm.user_id=m.sender_id AND cm.status='active')`;
        const params = [couple, p.userId, epoch];
        if (anchored && !(await tx.query(`SELECT m.id ${from} AND m.id=$4 AND m.seq=$5`, [...params, f.anchorId, f.anchorSeq])).rows.length)
            return { ok: false, error: 'invalid_cursor' };
        const asc = f.direction === 'oldest' || f.direction === 'after';
        const rows = (await tx.query<Row>(`SELECT m.id,m.couple_id,m.client_message_id,m.reply_to_id,m.seq::text,m.created_at::text,m.sender_id,m.deleted_at::text,m.version,
      v.version AS visibility_version ${from} ${anchored ? `AND m.seq ${asc ? '>' : '<'} $4` : ''}
      ORDER BY m.seq ${asc ? 'ASC' : 'DESC'} LIMIT 50`, [...params, ...(anchored ? [f.anchorSeq] : [])])).rows;
        if (!asc)
            rows.reverse();
        let hasOlder = false, hasNewer = false;
        if (rows.length) {
            const flags = (await tx.query<{
                older: boolean;
                newer: boolean;
            }>(`SELECT EXISTS(SELECT 1 ${from} AND m.seq<$4) older,
        EXISTS(SELECT 1 ${from} AND m.seq>$5) newer`, [...params, rows[0].seq, rows[rows.length - 1].seq])).rows[0];
            hasOlder = flags.older;
            hasNewer = flags.newer;
        }
        const messages = rows.map(r => ({ id: r.id, coupleId: r.couple_id, clientId: r.client_message_id, replyToId: r.reply_to_id, seq: Number(r.seq), createdAt: r.created_at, senderId: r.sender_id,
            deletedAt: r.deleted_at ? new Date(r.deleted_at).toISOString() : null, version: r.version, visibilityVersion: r.visibility_version }));
        return { ok: true, value: { messages, readId, hasOlder, hasNewer,
                olderCursor: hasOlder ? { id: messages[0].id, seq: messages[0].seq } : null,
                newerCursor: hasNewer ? { id: messages[messages.length - 1].id, seq: messages[messages.length - 1].seq } : null } };
    });
}
