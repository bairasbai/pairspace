import type { AuthorizedDatabase, Principal, SqlExecutor } from './contracts.ts';
import { activeSession, validPrincipal } from './session.ts';
import { isEpoch, isUuid } from './validation.ts';
export type MorningError = 'invalid_request' | 'unavailable' | 'stale_membership' | 'version_conflict' | 'idempotency_conflict' | 'slot_exists' | 'slot_filled' | 'slot_closed' | 'invalid_cursor' | 'draft_deleted' | 'draft_missing';
export type MorningResult<T> = {
    ok: true;
    value: T;
} | {
    ok: false;
    error: MorningError;
};
export type MorningScope = {
    coupleId: string;
    membershipEpoch: number;
};
export function morningInput(value: unknown, keys: string[]): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;
    const f = value as Record<string, unknown>;
    return Object.keys(f).sort().join(',') === keys.sort().join(',') && isUuid(f.coupleId)
        && isEpoch(f.membershipEpoch) ? f : null;
}
export async function morningScope<T>(db: AuthorizedDatabase, p: Principal, scope: MorningScope, write: boolean, work: (tx: SqlExecutor, partner: string, now: Date) => Promise<MorningResult<T>>): Promise<MorningResult<T>> {
    if (!validPrincipal(p))
        return { ok: false, error: 'unavailable' };
    return db.transaction(async (tx) => {
        if (!await activeSession(tx, db, p))
            return { ok: false, error: 'unavailable' };
        const pair = (await tx.query<{
            status: string;
            membership_epoch: number;
        }>(`SELECT status,membership_epoch FROM couples WHERE id=$1 FOR ${write ? 'UPDATE' : 'SHARE'}`, [scope.coupleId])).rows[0];
        if (!pair || pair.status !== 'active')
            return { ok: false, error: 'unavailable' };
        const members = (await tx.query<{
            user_id: string;
        }>("SELECT user_id FROM couple_members WHERE couple_id=$1 AND status='active' ORDER BY user_id FOR SHARE", [scope.coupleId])).rows;
        if (members.length !== 2 || !members.some(m => m.user_id === p.userId))
            return { ok: false, error: 'unavailable' };
        if (pair.membership_epoch !== scope.membershipEpoch)
            return { ok: false, error: 'stale_membership' };
        if (!await activeSession(tx, db, p))
            return { ok: false, error: 'unavailable' };
        return work(tx, members.find(m => m.user_id !== p.userId)!.user_id, db.now());
    });
}
