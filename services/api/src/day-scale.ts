import { createHash } from 'node:crypto';
import { validScaleValue, validScaleDate, validScaleZone, scaleDateAt } from '../../../packages/domain/scale/value.ts';
import type { AuthorizedDatabase, Principal, SqlExecutor } from './contracts.ts';
import { lockPair } from './pair-close.ts';
import { activeSession, validPrincipal } from './session.ts';
import { isEpoch, isUuid } from './validation.ts';
type Common = {
    id: string;
    coupleId: string;
    authorId: string;
    membershipEpoch: number;
    localDate: string;
    timezone: string;
    version: number;
    createdAt: string;
};
export type ScaleSlot = Common & ({
    state: 'active';
    value: number;
} | {
    state: 'removed';
});
type ErrorCode = 'invalid_request' | 'unavailable' | 'stale_membership' | 'idempotency_conflict' | 'version_conflict' | 'capacity_reached' | 'date_mismatch';
type Failure = {
    ok: false;
    error: ErrorCode;
    current?: ScaleSlot;
};
type Result<T> = {
    ok: true;
    value: T;
} | Failure;
type Mode = 'list' | 'create' | 'publish' | 'remove';
type Scope = {
    coupleId: string;
    membershipEpoch: number;
    commandId?: string;
    slotId?: string;
    expectedVersion?: number;
    expectedDate?: string;
    timezone?: string;
    value?: number;
};
type Row = {
    id: string;
    couple_id: string;
    author_id: string;
    membership_epoch: number;
    local_date: string;
    timezone: string;
    version: number;
    created_at: string;
    state: 'active' | 'removed';
    value: number | null;
};
const columns = 'id,couple_id,author_id,membership_epoch,local_date,timezone,version,created_at::text,state,value';
const fail = (error: ErrorCode): Failure => ({ ok: false, error });
const view = (r: Row): ScaleSlot => ({ id: r.id, coupleId: r.couple_id, authorId: r.author_id, membershipEpoch: r.membership_epoch, localDate: r.local_date, timezone: r.timezone, version: r.version, createdAt: new Date(r.created_at).toISOString(), ...(r.state === 'active' ? { state: 'active' as const, value: r.value! } : { state: 'removed' as const }) });
function parse(input: unknown, mode: Mode): Scope | null {
    if (!input || typeof input !== 'object' || Array.isArray(input))
        return null;
    const f = input as Record<string, unknown>;
    const keys = ['coupleId', 'membershipEpoch', ...(mode === 'list' ? [] : ['commandId']), ...(mode === 'create' ? ['expectedDate', 'timezone', 'value'] : []), ...(['publish', 'remove'].includes(mode) ? ['slotId', 'expectedVersion'] : []), ...(mode === 'publish' ? ['value'] : [])];
    if (Object.keys(f).sort().join() !== keys.sort().join() || !isUuid(f.coupleId) || !isEpoch(f.membershipEpoch))
        return null;
    const scope: Scope = { coupleId: f.coupleId.toLowerCase(), membershipEpoch: f.membershipEpoch };
    if (mode === 'list')
        return scope;
    if (!isUuid(f.commandId))
        return null;
    scope.commandId = f.commandId.toLowerCase();
    if (mode === 'create') {
        if (!validScaleDate(f.expectedDate) || !validScaleZone(f.timezone))
            return null;
        scope.expectedDate = f.expectedDate;
        scope.timezone = f.timezone;
    }
    else {
        if (!isUuid(f.slotId) || !Number.isInteger(f.expectedVersion) || Number(f.expectedVersion) < 1 || Number(f.expectedVersion) > 2147483646)
            return null;
        scope.slotId = f.slotId.toLowerCase();
        scope.expectedVersion = Number(f.expectedVersion);
    }
    if (mode !== 'remove') {
        if (!validScaleValue(f.value))
            return null;
        scope.value = f.value;
    }
    return scope;
}
async function authorize(tx: SqlExecutor, db: AuthorizedDatabase, p: Principal, s: Scope): Promise<Failure | null> {
    const pair = await lockPair(tx, db, p, s.coupleId);
    if (typeof pair === 'string')
        return fail('unavailable');
    const active = pair.members.filter(m => m.status === 'active');
    if (pair.status !== 'active' || active.length !== 2 || !active.some(m => m.user_id === p.userId))
        return fail('unavailable');
    return pair.epoch === s.membershipEpoch ? null : fail('stale_membership');
}
function now(db: AuthorizedDatabase) { const date = db.now(); if (!Number.isFinite(date.getTime()))
    throw Error('invalid_server_clock'); return date; }
const select = async (tx: SqlExecutor, s: Scope, id: string) => (await tx.query<Row>(`SELECT ${columns} FROM day_scale WHERE couple_id=$1 AND membership_epoch=$2 AND id=$3 FOR UPDATE`, [s.coupleId, s.membershipEpoch, id])).rows[0];
export async function listScaleSlots(db: AuthorizedDatabase, p: Principal, input: unknown): Promise<Result<{
    slots: ScaleSlot[];
    checkedAt: string;
    capacityPerAuthor: 100;
    ownUsed: number;
}>> {
    if (!validPrincipal(p))
        return fail('unavailable');
    const s = parse(input, 'list');
    if (!s)
        return fail('invalid_request');
    return db.transaction(async (tx) => {
        const denied = await authorize(tx, db, p, s);
        if (denied)
            return denied;
        const rows = (await tx.query<Row>(`SELECT ${columns} FROM day_scale WHERE couple_id=$1 AND membership_epoch=$2 ORDER BY local_date DESC,author_id ASC LIMIT 201`, [s.coupleId, s.membershipEpoch])).rows;
        if (rows.length > 200)
            throw Error('invalid_scale_capacity');
        if (!await activeSession(tx, db, p))
            return fail('unavailable');
        return { ok: true, value: { slots: rows.map(view), checkedAt: now(db).toISOString(), capacityPerAuthor: 100, ownUsed: rows.filter(r => r.author_id === p.userId).length } };
    });
}
export const createScaleSlot = (db: AuthorizedDatabase, p: Principal, input: unknown) => mutate(db, p, input, 'create');
export const publishScaleSlot = (db: AuthorizedDatabase, p: Principal, input: unknown) => mutate(db, p, input, 'publish');
export const removeScaleSlot = (db: AuthorizedDatabase, p: Principal, input: unknown) => mutate(db, p, input, 'remove');
async function mutate(db: AuthorizedDatabase, p: Principal, input: unknown, mode: Exclude<Mode, 'list'>): Promise<Result<{
    slot: ScaleSlot;
    commandId: string;
    replay: boolean;
}>> {
    if (!validPrincipal(p))
        return fail('unavailable');
    const s = parse(input, mode);
    if (!s)
        return fail('invalid_request');
    const fingerprint = createHash('sha256').update(JSON.stringify([mode, s.coupleId, s.membershipEpoch, s.slotId ?? null, s.expectedVersion ?? null, s.expectedDate ?? null, s.timezone ?? null, s.value ?? null])).digest('hex');
    const revoked = new Error('scale_session_ended'), midnight = new Error('scale_date_changed');
    try {
        return await db.transaction(async (tx) => {
            const denied = await authorize(tx, db, p, s);
            if (denied)
                return denied;
            const receipt = (await tx.query<{
                slot_id: string;
                fingerprint: string;
            }>('SELECT slot_id,fingerprint FROM day_scale_commands WHERE actor_user_id=$1 AND command_id=$2', [p.userId, s.commandId])).rows[0];
            if (receipt) {
                if (receipt.fingerprint !== fingerprint)
                    return fail('idempotency_conflict');
                const current = await select(tx, s, receipt.slot_id);
                if (!current || !await activeSession(tx, db, p))
                    return fail('unavailable');
                return { ok: true, value: { slot: view(current), commandId: s.commandId!, replay: true } };
            }
            let current: Row;
            if (mode === 'create') {
                const existing = (await tx.query<Row>(`SELECT ${columns} FROM day_scale WHERE couple_id=$1 AND membership_epoch=$2 AND author_id=$3 AND local_date=$4 FOR UPDATE`, [s.coupleId, s.membershipEpoch, p.userId, s.expectedDate])).rows[0];
                if (!await activeSession(tx, db, p))
                    return fail('unavailable');
                if (existing)
                    return { ok: false, error: 'version_conflict', current: view(existing) };
                const zone = (await tx.query<{
                    known: boolean;
                }>('SELECT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=$1) AS known', [s.timezone])).rows[0].known;
                if (!zone)
                    return fail('invalid_request');
                const used = Number((await tx.query<{
                    used: number;
                }>('SELECT count(*)::int AS used FROM day_scale WHERE couple_id=$1 AND membership_epoch=$2 AND author_id=$3', [s.coupleId, s.membershipEpoch, p.userId])).rows[0].used);
                if (used >= 100)
                    return fail('capacity_reached');
                const instant = now(db);
                if (scaleDateAt(instant, s.timezone!) !== s.expectedDate)
                    return fail('date_mismatch');
                current = (await tx.query<Row>(`INSERT INTO day_scale(couple_id,author_id,membership_epoch,local_date,timezone,version,created_at,state,value) VALUES($1,$2,$3,$4,$5,1,$6,'active',$7) RETURNING ${columns}`, [s.coupleId, p.userId, s.membershipEpoch, s.expectedDate, s.timezone, instant, s.value])).rows[0];
            }
            else {
                const row = await select(tx, s, s.slotId!);
                if (!row || row.author_id !== p.userId || !await activeSession(tx, db, p))
                    return fail('unavailable');
                if (row.version !== s.expectedVersion)
                    return { ok: false, error: 'version_conflict', current: view(row) };
                const state = mode === 'remove' ? 'removed' : 'active', value = mode === 'remove' ? null : s.value;
                current = row.state === state && row.value === value ? row : (await tx.query<Row>(`UPDATE day_scale SET state=$2,value=$3,version=version+1 WHERE id=$1 RETURNING ${columns}`, [row.id, state, value])).rows[0];
            }
            await tx.query('INSERT INTO day_scale_commands(actor_user_id,command_id,couple_id,membership_epoch,slot_id,fingerprint) VALUES($1,$2,$3,$4,$5,$6)', [p.userId, s.commandId, s.coupleId, s.membershipEpoch, current.id, fingerprint]);
            if (!await activeSession(tx, db, p))
                throw revoked;
            // Check again after FK waits: a new-day publication may never silently cross midnight.
            if (mode === 'create' && scaleDateAt(now(db), s.timezone!) !== s.expectedDate)
                throw midnight;
            return { ok: true, value: { slot: view(current), commandId: s.commandId!, replay: false } };
        });
    }
    catch (error) {
        if (error === revoked)
            return fail('unavailable');
        if (error === midnight)
            return fail('date_mismatch');
        throw error;
    }
}
