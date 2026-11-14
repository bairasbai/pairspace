import { createHash } from 'node:crypto';
import { normalizeStemText } from '../../../packages/domain/stems/text.ts';
import type { AuthorizedDatabase, Principal, SqlExecutor } from './contracts.ts';
import { lockPair } from './pair-close.ts';
import { activeSession, validPrincipal } from './session.ts';
import { isEpoch, isUuid } from './validation.ts';
type Phase = 'waiting' | 'completed' | 'skipped' | 'withdrawn';
type TextState = 'active' | 'removed';
export type StemRound = Readonly<{
    id: string;
    coupleId: string;
    authorId: string;
    recipientId: string;
    membershipEpoch: number;
    sequence: number;
    version: number;
    createdAt: string;
    phase: Phase;
    authorTextState: TextState;
    recipientTextState: TextState | 'absent';
    completedAt?: string;
    beginning?: string;
    authorContinuation?: string;
    recipientContinuation?: string;
}>;
type Failure = {
    ok: false;
    error: 'invalid_request' | 'unavailable' | 'stale_membership' | 'idempotency_conflict' | 'version_conflict' | 'capacity_reached';
    current?: StemRound;
};
type Result<T> = {
    ok: true;
    value: T;
} | Failure;
type Mode = 'list' | 'create' | 'complete' | 'skip' | 'removeAuthor' | 'removeRecipient';
type Scope = {
    coupleId: string;
    membershipEpoch: number;
    commandId?: string;
    roundId?: string;
    expectedVersion?: number;
    beginning?: string;
    ownContinuation?: string;
    continuation?: string;
};
type Row = {
    id: string;
    couple_id: string;
    author_id: string;
    recipient_id: string;
    membership_epoch: number;
    sequence: number;
    version: number;
    created_at: string;
    phase: Phase;
    author_text_state: TextState;
    recipient_text_state: TextState | 'absent';
    completed_at: string | null;
};
// Metadata only. Hidden author text is deliberately absent from every base query.
const columns = 'id,couple_id,author_id,recipient_id,membership_epoch,sequence,version,created_at::text,phase,author_text_state,recipient_text_state,completed_at::text';
const fail = (error: Failure['error']): Failure => ({ ok: false, error });
function parse(input: unknown, mode: Mode): Scope | null {
    if (!input || typeof input !== 'object' || Array.isArray(input))
        return null;
    const f = input as Record<string, unknown>;
    const keys = ['coupleId', 'membershipEpoch', ...(mode === 'list' ? [] : ['commandId']), ...(!['list', 'create'].includes(mode) ? ['roundId', 'expectedVersion'] : []), ...(mode === 'create' ? ['beginning', 'ownContinuation'] : []), ...(mode === 'complete' ? ['continuation'] : [])];
    if (Object.keys(f).sort().join() !== keys.sort().join() || !isUuid(f.coupleId) || !isEpoch(f.membershipEpoch))
        return null;
    const s: Scope = { coupleId: f.coupleId.toLowerCase(), membershipEpoch: f.membershipEpoch };
    if (mode === 'list')
        return s;
    if (!isUuid(f.commandId))
        return null;
    s.commandId = f.commandId.toLowerCase();
    if (mode !== 'create') {
        if (!isUuid(f.roundId) || !Number.isInteger(f.expectedVersion) || Number(f.expectedVersion) < 1 || Number(f.expectedVersion) > 4)
            return null;
        s.roundId = f.roundId.toLowerCase();
        s.expectedVersion = Number(f.expectedVersion);
    }
    if (mode === 'create') {
        const beginning = normalizeStemText(f.beginning, 'beginning'), own = normalizeStemText(f.ownContinuation, 'continuation');
        if (beginning === null || own === null)
            return null;
        s.beginning = beginning;
        s.ownContinuation = own;
    }
    if (mode === 'complete') {
        const text = normalizeStemText(f.continuation, 'continuation');
        if (text === null)
            return null;
        s.continuation = text;
    }
    return s;
}
function now(db: AuthorizedDatabase) { const instant = db.now(); if (!Number.isFinite(instant.getTime()))
    throw Error('invalid_server_clock'); return instant; }
async function authorize(tx: SqlExecutor, db: AuthorizedDatabase, p: Principal, s: Scope): Promise<Failure | {
    recipientId: string;
}> { const pair = await lockPair(tx, db, p, s.coupleId); if (typeof pair === 'string')
    return fail('unavailable'); const active = pair.members.filter(m => m.status === 'active'); if (pair.status !== 'active' || active.length !== 2 || !active.some(m => m.user_id === p.userId))
    return fail('unavailable'); return pair.epoch !== s.membershipEpoch ? fail('stale_membership') : { recipientId: active.find(m => m.user_id !== p.userId)!.user_id }; }
const select = async (tx: SqlExecutor, s: Scope, id: string) => (await tx.query<Row>(`SELECT ${columns} FROM stems WHERE couple_id=$1 AND membership_epoch=$2 AND id=$3 FOR UPDATE`, [s.coupleId, s.membershipEpoch, id])).rows[0];
async function project(tx: SqlExecutor, p: Principal, r: Row): Promise<StemRound> {
    const fields: string[] = [];
    if (r.author_text_state === 'active') {
        fields.push('beginning');
        if (p.userId === r.author_id || r.phase === 'completed')
            fields.push('author_continuation');
    }
    if (r.recipient_text_state === 'active')
        fields.push('recipient_continuation');
    // Phase was read under the held pair/row lock. A recipient waiting or skipped query
    // cannot even SELECT the private column; this is not read-then-strip protection.
    const body = fields.length ? (await tx.query<Record<string, string>>(`SELECT ${fields.join(',')} FROM stems WHERE id=$1`, [r.id])).rows[0] : {};
    return { id: r.id, coupleId: r.couple_id, authorId: r.author_id, recipientId: r.recipient_id, membershipEpoch: r.membership_epoch, sequence: r.sequence, version: r.version, createdAt: new Date(r.created_at).toISOString(), phase: r.phase, authorTextState: r.author_text_state, recipientTextState: r.recipient_text_state, ...(r.completed_at !== null ? { completedAt: new Date(r.completed_at).toISOString() } : {}), ...('beginning' in body ? { beginning: body.beginning } : {}), ...('author_continuation' in body ? { authorContinuation: body.author_continuation } : {}), ...('recipient_continuation' in body ? { recipientContinuation: body.recipient_continuation } : {}) };
}
export async function listStems(db: AuthorizedDatabase, p: Principal, input: unknown): Promise<Result<{
    rounds: StemRound[];
    checkedAt: string;
    capacity: 100;
    used: number;
}>> {
    if (!validPrincipal(p))
        return fail('unavailable');
    const s = parse(input, 'list');
    if (!s)
        return fail('invalid_request');
    return db.transaction(async (tx) => { const auth = await authorize(tx, db, p, s); if ('ok' in auth)
        return auth; const rows = (await tx.query<Row>(`SELECT ${columns} FROM stems WHERE couple_id=$1 AND membership_epoch=$2 ORDER BY (phase='waiting') DESC,sequence DESC LIMIT 101 FOR UPDATE`, [s.coupleId, s.membershipEpoch])).rows; if (rows.length > 100)
        throw Error('invalid_stem_capacity'); if (!await activeSession(tx, db, p))
        return fail('unavailable'); const rounds = []; for (const row of rows)
        rounds.push(await project(tx, p, row)); if (!await activeSession(tx, db, p))
        return fail('unavailable'); return { ok: true, value: { rounds, checkedAt: now(db).toISOString(), capacity: 100, used: rows.length } }; });
}
export const createStem = (db: AuthorizedDatabase, p: Principal, i: unknown) => mutate(db, p, i, 'create');
export const completeStem = (db: AuthorizedDatabase, p: Principal, i: unknown) => mutate(db, p, i, 'complete');
export const skipStem = (db: AuthorizedDatabase, p: Principal, i: unknown) => mutate(db, p, i, 'skip');
export const removeAuthorBundle = (db: AuthorizedDatabase, p: Principal, i: unknown) => mutate(db, p, i, 'removeAuthor');
export const removeRecipientContinuation = (db: AuthorizedDatabase, p: Principal, i: unknown) => mutate(db, p, i, 'removeRecipient');
async function mutate(db: AuthorizedDatabase, p: Principal, input: unknown, mode: Exclude<Mode, 'list'>): Promise<Result<{
    round: StemRound;
    commandId: string;
    replay: boolean;
}>> {
    if (!validPrincipal(p))
        return fail('unavailable');
    const s = parse(input, mode);
    if (!s)
        return fail('invalid_request');
    const fingerprint = createHash('sha256').update(JSON.stringify([mode, s.coupleId, s.membershipEpoch, s.roundId ?? null, s.expectedVersion ?? null, s.beginning ?? null, s.ownContinuation ?? null, s.continuation ?? null])).digest('hex');
    const revoked = new Error('stem_session_ended');
    try {
        return await db.transaction(async (tx) => {
            const auth = await authorize(tx, db, p, s);
            if ('ok' in auth)
                return auth;
            const previous = (await tx.query<{
                fingerprint: string;
                round_id: string;
            }>('SELECT fingerprint,round_id FROM stem_commands WHERE actor_user_id=$1 AND command_id=$2', [p.userId, s.commandId])).rows[0];
            if (previous) {
                if (previous.fingerprint !== fingerprint)
                    return fail('idempotency_conflict');
                const current = await select(tx, s, previous.round_id);
                if (!current || !await activeSession(tx, db, p))
                    return fail('unavailable');
                const round = await project(tx, p, current);
                if (!await activeSession(tx, db, p))
                    return fail('unavailable');
                return { ok: true, value: { round, commandId: s.commandId!, replay: true } };
            }
            let current: Row;
            if (mode === 'create') {
                const used = Number((await tx.query<{
                    used: number;
                }>('SELECT count(*)::int AS used FROM stems WHERE couple_id=$1 AND membership_epoch=$2', [s.coupleId, s.membershipEpoch])).rows[0].used);
                if (used >= 100)
                    return fail('capacity_reached');
                if (!await activeSession(tx, db, p))
                    return fail('unavailable');
                current = (await tx.query<Row>(`INSERT INTO stems(couple_id,author_id,recipient_id,membership_epoch,sequence,version,created_at,phase,author_text_state,recipient_text_state,beginning,author_continuation) VALUES($1,$2,$3,$4,$5,1,$6,'waiting','active','absent',$7,$8) RETURNING ${columns}`, [s.coupleId, p.userId, auth.recipientId, s.membershipEpoch, used + 1, now(db), s.beginning, s.ownContinuation])).rows[0];
            }
            else {
                const row = await select(tx, s, s.roundId!);
                if (!row || (mode === 'removeAuthor' ? row.author_id : row.recipient_id) !== p.userId || !await activeSession(tx, db, p))
                    return fail('unavailable');
                const allowed = mode === 'removeAuthor' ? row.author_text_state === 'active' : mode === 'removeRecipient' ? row.recipient_text_state === 'active' : row.phase === 'waiting';
                if (!allowed || row.version !== s.expectedVersion) {
                    const current = await project(tx, p, row);
                    if (!await activeSession(tx, db, p))
                        return fail('unavailable');
                    return { ok: false, error: 'version_conflict', current };
                }
                if (mode === 'complete')
                    current = (await tx.query<Row>(`UPDATE stems SET phase='completed',recipient_text_state='active',recipient_continuation=$2,completed_at=$3,version=version+1 WHERE id=$1 RETURNING ${columns}`, [row.id, s.continuation, new Date(Math.max(now(db).getTime(), Date.parse(row.created_at)))])).rows[0];
                else if (mode === 'skip')
                    current = (await tx.query<Row>(`UPDATE stems SET phase='skipped',version=version+1 WHERE id=$1 RETURNING ${columns}`, [row.id])).rows[0];
                else if (mode === 'removeAuthor')
                    current = (await tx.query<Row>(`UPDATE stems SET phase=CASE WHEN phase='waiting' THEN 'withdrawn' ELSE phase END,author_text_state='removed',beginning=NULL,author_continuation=NULL,version=version+1 WHERE id=$1 RETURNING ${columns}`, [row.id])).rows[0];
                else
                    current = (await tx.query<Row>(`UPDATE stems SET recipient_text_state='removed',recipient_continuation=NULL,version=version+1 WHERE id=$1 RETURNING ${columns}`, [row.id])).rows[0];
            }
            await tx.query('INSERT INTO stem_commands(actor_user_id,command_id,couple_id,membership_epoch,round_id,fingerprint) VALUES($1,$2,$3,$4,$5,$6)', [p.userId, s.commandId, s.coupleId, s.membershipEpoch, current.id, fingerprint]);
            if (!await activeSession(tx, db, p))
                throw revoked;
            const round = await project(tx, p, current);
            if (!await activeSession(tx, db, p))
                throw revoked;
            return { ok: true, value: { round, commandId: s.commandId!, replay: false } };
        });
    }
    catch (error) {
        if (error === revoked)
            return fail('unavailable');
        throw error;
    }
}
