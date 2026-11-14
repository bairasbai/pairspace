import type { SqlExecutor } from './contracts.ts';
import type { MorningScope } from './morning-scope.ts';
export type MorningPreference = {
    userId: string;
    timezone: string;
    localTime: string;
    version: number;
};
export type MorningSlot = {
    id: string;
    coupleId: string;
    membershipEpoch: number;
    senderId: string;
    recipientId: string;
    localDate: string;
    localTime: string;
    timezone: string;
    offset: string;
    releaseAt: string;
    preferenceVersion: number;
    createdAt: string;
    state: 'sealed' | 'available' | 'missed';
    prepared?: boolean;
    openedAt?: string | null;
};
export type SlotRow = {
    id: string;
    couple_id: string;
    membership_epoch: number;
    sender_id: string;
    recipient_id: string;
    local_date: string;
    local_time: string;
    timezone: string;
    utc_offset: string;
    release_at: string;
    preference_version: number;
    created_at: string;
    prepared: boolean | null;
    opened_at: string | null;
};
export const slotColumns = `s.id,s.couple_id,s.membership_epoch,s.sender_id,s.recipient_id,
  s.local_date::text,s.local_time,s.timezone,s.utc_offset,s.release_at::text,s.preference_version,s.created_at::text`;
/** No content access at all for an unreleased recipient row, including existence/readiness. */
export const openingColumn = `CASE WHEN s.recipient_id=$3 THEN
  (SELECT o.opened_at::text FROM morning_openings o WHERE o.slot_id=s.id AND o.recipient_id=$3) ELSE NULL END AS opened_at`;
export const readiness = `CASE WHEN s.sender_id=$3 OR s.release_at<=$4::timestamptz
  THEN EXISTS(SELECT 1 FROM morning_content c WHERE c.slot_id=s.id) ELSE NULL END AS prepared`;
export function slotMetadata(row: SlotRow, actor: string, now: Date): MorningSlot {
    return { id: row.id, coupleId: row.couple_id, membershipEpoch: row.membership_epoch,
        senderId: row.sender_id, recipientId: row.recipient_id, localDate: row.local_date,
        localTime: row.local_time, timezone: row.timezone, offset: row.utc_offset,
        releaseAt: new Date(row.release_at).toISOString(), preferenceVersion: row.preference_version,
        createdAt: new Date(row.created_at).toISOString(), state: row.opened_at ? 'available' : Date.parse(row.release_at) > now.getTime()
            ? 'sealed' : row.prepared ? 'available' : 'missed',
        ...(row.sender_id === actor ? { prepared: row.prepared === true } : { openedAt: row.opened_at ? new Date(row.opened_at).toISOString() : null }) };
}
export async function morningSlot(tx: SqlExecutor, scope: MorningScope, actor: string, now: Date, id: string): Promise<MorningSlot | null> {
    const row = (await tx.query<SlotRow>(`SELECT ${slotColumns},${readiness},${openingColumn} FROM morning_slots s
    WHERE s.couple_id=$1 AND s.membership_epoch=$2 AND (s.sender_id=$3 OR s.recipient_id=$3) AND s.id=$5
    AND EXISTS(SELECT 1 FROM couple_members m WHERE m.couple_id=s.couple_id AND m.user_id=s.sender_id AND m.status='active')
    AND EXISTS(SELECT 1 FROM couple_members m WHERE m.couple_id=s.couple_id AND m.user_id=s.recipient_id AND m.status='active')`, [scope.coupleId, scope.membershipEpoch, actor, now.toISOString(), id])).rows[0];
    return row ? slotMetadata(row, actor, now) : null;
}
export async function morningPreferences(tx: SqlExecutor, scope: MorningScope): Promise<MorningPreference[]> {
    const rows = (await tx.query<{
        user_id: string;
        timezone: string;
        local_time: string;
        version: number;
    }>('SELECT user_id,timezone,local_time,version FROM morning_preferences WHERE couple_id=$1 AND membership_epoch=$2 ORDER BY user_id', [scope.coupleId, scope.membershipEpoch])).rows;
    return rows.map(r => ({ userId: r.user_id, timezone: r.timezone, localTime: r.local_time, version: r.version }));
}
