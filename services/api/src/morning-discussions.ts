import { createHash } from 'node:crypto';
import type { AuthorizedDatabase, Principal, SqlExecutor } from './contracts.ts';
import { activeSession } from './session.ts';
import { isUuid } from './validation.ts';
import { normalizeMessageText } from '../../../packages/domain/chat/text.ts';
import { morningInput, morningScope, type MorningScope, type MorningResult } from './morning-scope.ts';
export type MorningDiscussionMessage = {
    id: string;
    slotId: string;
    coupleId: string;
    membershipEpoch: number;
    authorId: string;
    clientId: string;
    seq: number;
    body: string;
    createdAt: string;
};
export type Row = {
    id: string;
    slot_id: string;
    couple_id: string;
    membership_epoch: number;
    author_id: string;
    client_id: string;
    seq: string;
    body: string | null;
    version?: number;
    edited_at?: string | null;
    deleted_at?: string | null;
    created_at: string;
};
export const columns = "id,slot_id,couple_id,membership_epoch,author_id,client_id,seq::text AS seq,body,created_at::text AS created_at, COALESCE((to_jsonb(morning_discussion_messages)->>'version')::int,1) AS version, to_jsonb(morning_discussion_messages)->>'edited_at' AS edited_at, to_jsonb(morning_discussion_messages)->>'deleted_at' AS deleted_at";
export const convert = (r: Row): MorningDiscussionMessage => {
    if (r.body === null)
        throw Error('legacy_discussion_tombstone');
    return ({ id: r.id, slotId: r.slot_id, coupleId: r.couple_id, membershipEpoch: r.membership_epoch, authorId: r.author_id, clientId: r.client_id, seq: Number(r.seq), body: r.body, createdAt: new Date(r.created_at).toISOString() });
};
export type DiscussionScope = MorningScope & {
    slotId: string;
};
export async function allowed(tx: SqlExecutor, p: Principal, scope: DiscussionScope, now: Date): Promise<boolean> {
    const row = (await tx.query(`SELECT s.id FROM morning_slots s WHERE s.id=$1 AND s.couple_id=$2 AND s.membership_epoch=$3
  AND EXISTS(SELECT 1 FROM morning_content c WHERE c.slot_id=s.id)
  AND ((s.sender_id=$4 AND s.release_at<=$5::timestamptz)
    OR (s.recipient_id=$4 AND EXISTS(SELECT 1 FROM morning_openings o WHERE o.slot_id=s.id AND o.recipient_id=$4)))
  AND EXISTS(SELECT 1 FROM couple_members m WHERE m.couple_id=s.couple_id AND m.user_id=s.sender_id AND m.status='active')
  AND EXISTS(SELECT 1 FROM couple_members m WHERE m.couple_id=s.couple_id AND m.user_id=s.recipient_id AND m.status='active')`, [scope.slotId, scope.coupleId, scope.membershipEpoch, p.userId, now.toISOString()])).rows[0];
    return Boolean(row);
}
export async function access<T>(db: AuthorizedDatabase, p: Principal, scope: DiscussionScope, write: boolean, work: (tx: SqlExecutor, now: Date) => Promise<MorningResult<T>>): Promise<MorningResult<T>> {
    return morningScope(db, p, scope, write, async (tx) => {
        await tx.query(`SELECT id FROM morning_slots WHERE id=$1 AND couple_id=$2 AND membership_epoch=$3 FOR ${write ? 'UPDATE' : 'SHARE'}`, [scope.slotId, scope.coupleId, scope.membershipEpoch]);
        if (!await activeSession(tx, db, p))
            return { ok: false, error: 'unavailable' };
        const now = db.now();
        if (!await allowed(tx, p, scope, now))
            return { ok: false, error: 'unavailable' };
        return work(tx, now);
    });
}
export type MorningDiscussionMessageV2 = Omit<MorningDiscussionMessage, 'body'> & {
    body: string | null;
    version: number;
    editedAt: string | null;
    deletedAt: string | null;
};
export const convertV2 = (r: Row): MorningDiscussionMessageV2 => ({ id: r.id, slotId: r.slot_id, coupleId: r.couple_id, membershipEpoch: r.membership_epoch, authorId: r.author_id, clientId: r.client_id, seq: Number(r.seq), body: r.body, createdAt: new Date(r.created_at).toISOString(), version: r.version ?? 1, editedAt: r.edited_at ? new Date(r.edited_at).toISOString() : null, deletedAt: r.deleted_at ? new Date(r.deleted_at).toISOString() : null });
type Ack<T> = {
    commandId: string;
    replay: boolean;
    message: T;
};
export function sendMorningDiscussion(db: AuthorizedDatabase, p: Principal, input: unknown, v2: true): Promise<MorningResult<Ack<MorningDiscussionMessageV2>>>;
export function sendMorningDiscussion(db: AuthorizedDatabase, p: Principal, input: unknown, v2?: false): Promise<MorningResult<Ack<MorningDiscussionMessage>>>;
export async function sendMorningDiscussion(db: AuthorizedDatabase, p: Principal, input: unknown, v2 = false): Promise<MorningResult<Ack<MorningDiscussionMessage | MorningDiscussionMessageV2>>> {
    const f = morningInput(input, ['coupleId', 'membershipEpoch', 'slotId', 'commandId', 'body']);
    if (!f || !isUuid(f.slotId) || !isUuid(f.commandId))
        return { ok: false, error: 'invalid_request' };
    const normalized = normalizeMessageText(f.body);
    if (!normalized.ok)
        return { ok: false, error: 'invalid_request' };
    const scope = { coupleId: String(f.coupleId).toLowerCase(), membershipEpoch: Number(f.membershipEpoch), slotId: f.slotId.toLowerCase() };
    const commandId = f.commandId.toLowerCase();
    const fingerprint = createHash('sha256').update(JSON.stringify([1, 'morning-discussion', p.userId, scope.coupleId, scope.membershipEpoch, scope.slotId, normalized.text])).digest('hex');
    return access<Ack<MorningDiscussionMessage | MorningDiscussionMessageV2>>(db, p, scope, true, async (tx, now) => {
        const old = (await tx.query<{
            fingerprint: string;
            message_id: string;
        }>('SELECT fingerprint,message_id FROM morning_discussion_receipts WHERE actor_id=$1 AND command_id=$2', [p.userId, commandId])).rows[0];
        if (old) {
            if (old.fingerprint !== fingerprint)
                return { ok: false, error: 'idempotency_conflict' };
            const message = (await tx.query<Row>(`SELECT ${columns} FROM morning_discussion_messages WHERE id=$1 AND slot_id=$2 AND couple_id=$3 AND membership_epoch=$4`, [old.message_id, scope.slotId, scope.coupleId, scope.membershipEpoch])).rows[0];
            if (!message)
                throw Error('morning_discussion_receipt_invariant');
            if (!v2 && message.deleted_at)
                return { ok: false, error: 'unavailable' };
            return { ok: true, value: { commandId, replay: true, message: v2 ? convertV2(message) : convert(message) } };
        }
        const row = (await tx.query<Row>(`INSERT INTO morning_discussion_messages(slot_id,couple_id,membership_epoch,author_id,client_id,body,created_at)
   VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING ${columns}`, [scope.slotId, scope.coupleId, scope.membershipEpoch, p.userId, commandId, normalized.text, now.toISOString()])).rows[0];
        await tx.query(`INSERT INTO morning_discussion_receipts(actor_id,command_id,couple_id,membership_epoch,slot_id,message_id,fingerprint)
   VALUES($1,$2,$3,$4,$5,$6,$7)`, [p.userId, commandId, scope.coupleId, scope.membershipEpoch, scope.slotId, row.id, fingerprint]);
        return { ok: true, value: { commandId, replay: false, message: v2 ? convertV2(row) : convert(row) } };
    });
}
type Cursor = {
    id: string;
    seq: number;
};
export type MorningDiscussionWindow = {
    readId: string;
    slotId: string;
    messages: MorningDiscussionMessage[];
    hasPrevious: boolean;
    hasNext: boolean;
    previousCursor: Cursor | null;
    nextCursor: Cursor | null;
};
export type MorningDiscussionWindowV2 = Omit<MorningDiscussionWindow, 'messages'> & {
    messages: MorningDiscussionMessageV2[];
};
export function readMorningDiscussion(db: AuthorizedDatabase, p: Principal, input: unknown, v2: true): Promise<MorningResult<MorningDiscussionWindowV2>>;
export function readMorningDiscussion(db: AuthorizedDatabase, p: Principal, input: unknown, v2?: false): Promise<MorningResult<MorningDiscussionWindow>>;
export async function readMorningDiscussion(db: AuthorizedDatabase, p: Principal, input: unknown, v2 = false): Promise<MorningResult<MorningDiscussionWindow | MorningDiscussionWindowV2>> {
    const v = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    const anchored = v.direction === 'before' || v.direction === 'after';
    const f = morningInput(input, ['coupleId', 'membershipEpoch', 'slotId', 'readId', 'direction', ...(anchored ? ['anchorId', 'anchorSeq'] : [])]);
    if (!f || !isUuid(f.slotId) || !isUuid(f.readId) || !['first', 'last', 'before', 'after'].includes(String(f.direction)))
        return { ok: false, error: 'invalid_request' };
    if (anchored && (!isUuid(f.anchorId) || !Number.isSafeInteger(f.anchorSeq) || Number(f.anchorSeq) < 1))
        return { ok: false, error: 'invalid_cursor' };
    const scope = { coupleId: String(f.coupleId).toLowerCase(), membershipEpoch: Number(f.membershipEpoch), slotId: f.slotId.toLowerCase() };
    return access<MorningDiscussionWindow | MorningDiscussionWindowV2>(db, p, scope, false, async (tx) => {
        const params: unknown[] = [scope.slotId, scope.coupleId, scope.membershipEpoch];
        const where = 'slot_id=$1 AND couple_id=$2 AND membership_epoch=$3';
        if (anchored) {
            const found = (await tx.query(`SELECT id FROM morning_discussion_messages WHERE ${where} AND id=$4 AND seq=$5`, [...params, f.anchorId, f.anchorSeq])).rows.length;
            if (!found)
                return { ok: false, error: 'invalid_cursor' };
            params.push(f.anchorSeq);
        }
        const visible = v2 ? where : where + " AND to_jsonb(morning_discussion_messages)->>'deleted_at' IS NULL";
        const asc = f.direction === 'first' || f.direction === 'after';
        const rows = (await tx.query<Row>(`SELECT ${columns} FROM morning_discussion_messages WHERE ${visible}
   ${anchored ? `AND seq${asc ? '>' : '<'}$4` : ''} ORDER BY morning_discussion_messages.seq ${asc ? 'ASC' : 'DESC'} LIMIT 30`, params)).rows;
        if (!asc)
            rows.reverse();
        let hasPrevious = false, hasNext = false;
        if (rows.length) {
            const flags = (await tx.query<{
                previous: boolean;
                next: boolean;
            }>(`SELECT
    EXISTS(SELECT 1 FROM morning_discussion_messages WHERE ${visible} AND seq<$4) previous,
    EXISTS(SELECT 1 FROM morning_discussion_messages WHERE ${visible} AND seq>$5) next`, [...params.slice(0, 3), rows[0].seq, rows[rows.length - 1].seq])).rows[0];
            hasPrevious = flags.previous;
            hasNext = flags.next;
        }
        const metadata = { readId: String(f.readId).toLowerCase(), slotId: scope.slotId, hasPrevious, hasNext,
            previousCursor: hasPrevious ? { id: rows[0].id, seq: Number(rows[0].seq) } : null,
            nextCursor: hasNext ? { id: rows[rows.length - 1].id, seq: Number(rows[rows.length - 1].seq) } : null };
        if (v2)
            return { ok: true, value: { ...metadata, messages: rows.map(convertV2) } };
        return { ok: true, value: { ...metadata, messages: rows.map(convert) } };
    });
}
export async function readMorningDiscussionMessage(db: AuthorizedDatabase, p: Principal, input: unknown): Promise<MorningResult<{
    readId: string;
    message: MorningDiscussionMessageV2;
}>> {
    const f = morningInput(input, ['coupleId', 'membershipEpoch', 'slotId', 'messageId', 'readId']);
    if (!f || !isUuid(f.slotId) || !isUuid(f.messageId) || !isUuid(f.readId))
        return { ok: false, error: 'invalid_request' };
    const scope = { coupleId: String(f.coupleId).toLowerCase(), membershipEpoch: Number(f.membershipEpoch), slotId: f.slotId.toLowerCase() };
    return access(db, p, scope, false, async (tx) => {
        const row = (await tx.query<Row>(`SELECT ${columns} FROM morning_discussion_messages WHERE id=$1 AND slot_id=$2 AND couple_id=$3 AND membership_epoch=$4`, [String(f.messageId).toLowerCase(), scope.slotId, scope.coupleId, scope.membershipEpoch])).rows[0];
        return row ? { ok: true, value: { readId: String(f.readId).toLowerCase(), message: convertV2(row) } } : { ok: false, error: 'unavailable' };
    });
}
