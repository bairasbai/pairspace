import type { AuthorizedDatabase, Principal, SqlExecutor } from './contracts.ts';
import { isUuid } from './validation.ts';
import { morningInput, morningScope, type MorningResult, type MorningScope } from './morning-scope.ts';
import { morningSlot, morningPreferences, slotColumns, readiness, openingColumn, slotMetadata, type MorningSlot, type SlotRow, type MorningPreference } from './morning-data.ts';
export type MorningDetail = {
    readId: string;
    serverNow: string;
    slot: MorningSlot;
    body?: string;
};
export async function morningBody(tx: SqlExecutor, scope: MorningScope, actor: string, id: string, now: Date): Promise<string | undefined> {
    const row = (await tx.query<{
        body: string;
    }>(`SELECT c.body FROM morning_content c JOIN morning_slots s ON s.id=c.slot_id
    WHERE s.id=$1 AND s.couple_id=$2 AND s.membership_epoch=$3
    AND ((s.sender_id=$4 AND s.release_at<=$5::timestamptz)
      OR (s.recipient_id=$4 AND EXISTS(SELECT 1 FROM morning_openings o WHERE o.slot_id=s.id AND o.recipient_id=$4)))`, [id, scope.coupleId, scope.membershipEpoch, actor, now.toISOString()])).rows[0];
    return row?.body;
}
export async function readMorning(db: AuthorizedDatabase, p: Principal, input: unknown): Promise<MorningResult<MorningDetail>> {
    const f = morningInput(input, ['coupleId', 'membershipEpoch', 'slotId', 'readId']);
    if (!f || !isUuid(f.slotId) || !isUuid(f.readId))
        return { ok: false, error: 'invalid_request' };
    const scope = { coupleId: String(f.coupleId).toLowerCase(), membershipEpoch: Number(f.membershipEpoch) };
    return morningScope(db, p, scope, false, async (tx, _partner, now) => {
        const slot = await morningSlot(tx, scope, p.userId, now, String(f.slotId));
        if (!slot)
            return { ok: false, error: 'unavailable' };
        // Never issue a body SELECT before the actor's disclosure condition is satisfied.
        const readable = slot.recipientId === p.userId ? Boolean(slot.openedAt) : slot.state === 'available';
        const body = readable ? await morningBody(tx, scope, p.userId, slot.id, now) : undefined;
        return { ok: true, value: { readId: String(f.readId).toLowerCase(), serverNow: now.toISOString(), slot, ...(body === undefined ? {} : { body }) } };
    });
}
type Cursor = {
    id: string;
    releaseAt: string;
};
export type MorningWindow = {
    readId: string;
    serverNow: string;
    preferences: MorningPreference[];
    slots: MorningSlot[];
    hasOlder: boolean;
    hasNewer: boolean;
    olderCursor: Cursor | null;
    newerCursor: Cursor | null;
    lastAvailableId: string | null;
};
export async function listMornings(db: AuthorizedDatabase, p: Principal, input: unknown): Promise<MorningResult<MorningWindow>> {
    const object = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    const anchored = object.direction === 'before' || object.direction === 'after';
    const f = morningInput(input, ['coupleId', 'membershipEpoch', 'readId', 'direction', ...(anchored ? ['anchorId', 'anchorReleaseAt'] : [])]);
    if (!f || !isUuid(f.readId) || !['latest', 'oldest', 'before', 'after'].includes(String(f.direction)))
        return { ok: false, error: 'invalid_request' };
    if (anchored && (!isUuid(f.anchorId) || typeof f.anchorReleaseAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(f.anchorReleaseAt)
        || !Number.isFinite(Date.parse(f.anchorReleaseAt)) || new Date(f.anchorReleaseAt).toISOString() !== f.anchorReleaseAt))
        return { ok: false, error: 'invalid_cursor' };
    const scope = { coupleId: String(f.coupleId).toLowerCase(), membershipEpoch: Number(f.membershipEpoch) };
    return morningScope(db, p, scope, false, async (tx, partner, now) => {
        const params: unknown[] = [scope.coupleId, scope.membershipEpoch, p.userId, now.toISOString(), partner];
        const where = `$4::timestamptz IS NOT NULL AND s.couple_id=$1 AND s.membership_epoch=$2 AND ((s.sender_id=$3 AND s.recipient_id=$5) OR (s.sender_id=$5 AND s.recipient_id=$3))`;
        if (anchored) {
            const anchor = (await tx.query<{
                release_at: string;
            }>(`SELECT s.release_at::text FROM morning_slots s WHERE ${where} AND s.id=$6`, [...params, f.anchorId])).rows[0];
            if (!anchor || new Date(anchor.release_at).toISOString() !== f.anchorReleaseAt)
                return { ok: false, error: 'invalid_cursor' };
            params.push(f.anchorId);
        }
        const ascending = f.direction === 'oldest' || f.direction === 'after';
        const boundary = anchored ? `AND (s.release_at,s.id) ${ascending ? '>' : '<'} (SELECT a.release_at,a.id FROM morning_slots a WHERE a.id=$6)` : '';
        const rows = (await tx.query<SlotRow>(`SELECT ${slotColumns},${readiness},${openingColumn} FROM morning_slots s WHERE ${where} ${boundary}
      ORDER BY s.release_at ${ascending ? 'ASC' : 'DESC'},s.id ${ascending ? 'ASC' : 'DESC'} LIMIT 30`, params)).rows;
        // Display newest first for all windows. "before" navigates toward older slots.
        if (ascending)
            rows.reverse();
        let hasOlder = false, hasNewer = false;
        if (rows.length) {
            const flags = (await tx.query<{
                older: boolean;
                newer: boolean;
            }>(`SELECT
        EXISTS(SELECT 1 FROM morning_slots s WHERE ${where} AND (s.release_at,s.id)<(SELECT release_at,id FROM morning_slots WHERE id=$6)) older,
        EXISTS(SELECT 1 FROM morning_slots s WHERE ${where} AND (s.release_at,s.id)>(SELECT release_at,id FROM morning_slots WHERE id=$7)) newer`, [...params.slice(0, 5), rows[rows.length - 1].id, rows[0].id])).rows[0];
            hasOlder = flags.older;
            hasNewer = flags.newer;
        }
        const last = (await tx.query<{
            id: string;
        }>(`SELECT s.id FROM morning_slots s WHERE ${where}
      AND s.recipient_id=$3 AND (EXISTS(SELECT 1 FROM morning_openings o WHERE o.slot_id=s.id AND o.recipient_id=$3)
      OR (s.release_at<=$4::timestamptz AND EXISTS(SELECT 1 FROM morning_content c WHERE c.slot_id=s.id)))
      ORDER BY s.release_at DESC,s.id DESC LIMIT 1`, params.slice(0, 5))).rows[0];
        const slots = rows.map(row => slotMetadata(row, p.userId, now));
        const cursor = (slot: MorningSlot) => ({ id: slot.id, releaseAt: slot.releaseAt });
        return { ok: true, value: { readId: String(f.readId).toLowerCase(), serverNow: now.toISOString(), preferences: await morningPreferences(tx, scope), slots,
                hasOlder, hasNewer, olderCursor: hasOlder ? cursor(slots[slots.length - 1]) : null, newerCursor: hasNewer ? cursor(slots[0]) : null, lastAvailableId: last?.id ?? null } };
    });
}
