import { createHash } from 'node:crypto';
import { normalizeAskText } from '../../../packages/domain/asks/text.ts';
import type { AuthorizedDatabase, Principal, SqlExecutor } from './contracts.ts';
import { lockPair } from './pair-close.ts';
import { activeSession, validPrincipal } from './session.ts';
import { isEpoch, isUuid } from './validation.ts';
type QuestionState = 'active' | 'removed';
type ResponseState = 'waiting' | 'answered' | 'skipped' | 'withdrawn' | 'answer_removed';
export type AskQuestion = Readonly<{
    id: string;
    coupleId: string;
    authorId: string;
    recipientId: string;
    membershipEpoch: number;
    sequence: number;
    version: number;
    createdAt: string;
    questionState: QuestionState;
    responseState: ResponseState;
    question?: string;
    answer?: string;
    answeredAt?: string;
}>;
type ErrorCode = 'invalid_request' | 'unavailable' | 'stale_membership' | 'idempotency_conflict' | 'version_conflict' | 'capacity_reached';
type Failure = {
    ok: false;
    error: ErrorCode;
};
type Result<T> = {
    ok: true;
    value: T;
} | Failure;
type Mode = 'list' | 'create' | 'answer' | 'skip' | 'removeQuestion' | 'removeAnswer';
type Scope = {
    coupleId: string;
    membershipEpoch: number;
    commandId?: string;
    questionId?: string;
    expectedVersion?: number;
    text?: string;
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
    question_state: QuestionState;
    response_state: ResponseState;
    question: string | null;
    answer: string | null;
    answered_at: string | null;
};
const columns = 'id,couple_id,author_id,recipient_id,membership_epoch,sequence,version,created_at::text,question_state,response_state,question,answer,answered_at::text';
const fail = (error: ErrorCode): Failure => ({ ok: false, error });
function trustedNow(db: AuthorizedDatabase): Date {
    const now = db.now();
    if (!Number.isFinite(now.getTime()))
        throw Error('invalid_server_clock');
    return now;
}
function view(r: Row): AskQuestion {
    return { id: r.id, coupleId: r.couple_id, authorId: r.author_id, recipientId: r.recipient_id, membershipEpoch: r.membership_epoch,
        sequence: r.sequence, version: r.version, createdAt: new Date(r.created_at).toISOString(), questionState: r.question_state, responseState: r.response_state,
        ...(r.question_state === 'active' ? { question: r.question! } : {}), ...(r.response_state === 'answered' ? { answer: r.answer! } : {}),
        ...(r.answered_at !== null ? { answeredAt: new Date(r.answered_at).toISOString() } : {}) };
}
function parse(input: unknown, mode: Mode): Scope | null {
    if (!input || typeof input !== 'object' || Array.isArray(input))
        return null;
    const f = input as Record<string, unknown>;
    const required = ['coupleId', 'membershipEpoch', ...(mode === 'list' ? [] : ['commandId']),
        ...(!['create', 'list'].includes(mode) ? ['questionId', 'expectedVersion'] : []), ...(['create', 'answer'].includes(mode) ? ['text'] : [])];
    if (Object.keys(f).sort().join() !== required.sort().join() || !isUuid(f.coupleId) || !isEpoch(f.membershipEpoch))
        return null;
    const scope: Scope = { coupleId: f.coupleId.toLowerCase(), membershipEpoch: f.membershipEpoch };
    if (mode === 'list')
        return scope;
    if (!isUuid(f.commandId))
        return null;
    scope.commandId = f.commandId.toLowerCase();
    if (mode !== 'create') {
        if (!isUuid(f.questionId) || !Number.isInteger(f.expectedVersion) || Number(f.expectedVersion) < 1 || Number(f.expectedVersion) > 2147483646)
            return null;
        scope.questionId = f.questionId.toLowerCase();
        scope.expectedVersion = Number(f.expectedVersion);
    }
    if (mode === 'create' || mode === 'answer') {
        const text = normalizeAskText(f.text);
        if (text === null)
            return null;
        scope.text = text;
    }
    return scope;
}
async function authorize(tx: SqlExecutor, db: AuthorizedDatabase, principal: Principal, scope: Scope): Promise<Failure | {
    recipientId: string;
}> {
    const pair = await lockPair(tx, db, principal, scope.coupleId);
    if (typeof pair === 'string')
        return fail('unavailable');
    const active = pair.members.filter(member => member.status === 'active');
    if (pair.status !== 'active' || active.length !== 2 || !active.some(member => member.user_id === principal.userId))
        return fail('unavailable');
    return pair.epoch !== scope.membershipEpoch ? fail('stale_membership') : { recipientId: active.find(member => member.user_id !== principal.userId)!.user_id };
}
const select = async (tx: SqlExecutor, scope: Scope, id: string) => (await tx.query<Row>(`SELECT ${columns} FROM asks WHERE couple_id=$1 AND membership_epoch=$2 AND id=$3 FOR UPDATE`, [scope.coupleId, scope.membershipEpoch, id])).rows[0];
export async function listQuestions(db: AuthorizedDatabase, principal: Principal, input: unknown): Promise<Result<{
    questions: AskQuestion[];
    checkedAt: string;
    capacity: 100;
    used: number;
}>> {
    if (!validPrincipal(principal))
        return fail('unavailable');
    const scope = parse(input, 'list');
    if (!scope)
        return fail('invalid_request');
    return db.transaction(async (tx) => {
        const auth = await authorize(tx, db, principal, scope);
        if ('ok' in auth)
            return auth;
        const rows = (await tx.query<Row>(`SELECT ${columns} FROM asks WHERE couple_id=$1 AND membership_epoch=$2 ORDER BY (response_state='waiting') DESC,sequence DESC LIMIT 101`, [scope.coupleId, scope.membershipEpoch])).rows;
        if (rows.length > 100)
            throw Error('invalid_ask_capacity');
        if (!await activeSession(tx, db, principal))
            return fail('unavailable');
        return { ok: true, value: { questions: rows.map(view), checkedAt: trustedNow(db).toISOString(), capacity: 100, used: rows.length } };
    });
}
export const createQuestion = (db: AuthorizedDatabase, p: Principal, input: unknown) => mutate(db, p, input, 'create');
export const answerQuestion = (db: AuthorizedDatabase, p: Principal, input: unknown) => mutate(db, p, input, 'answer');
export const skipQuestion = (db: AuthorizedDatabase, p: Principal, input: unknown) => mutate(db, p, input, 'skip');
export const removeQuestion = (db: AuthorizedDatabase, p: Principal, input: unknown) => mutate(db, p, input, 'removeQuestion');
export const removeAnswer = (db: AuthorizedDatabase, p: Principal, input: unknown) => mutate(db, p, input, 'removeAnswer');
async function mutate(db: AuthorizedDatabase, principal: Principal, input: unknown, mode: Exclude<Mode, 'list'>): Promise<Result<{
    question: AskQuestion;
    commandId: string;
    replay: boolean;
}>> {
    if (!validPrincipal(principal))
        return fail('unavailable');
    const scope = parse(input, mode);
    if (!scope)
        return fail('invalid_request');
    const fingerprint = createHash('sha256').update(JSON.stringify([mode, scope.coupleId, scope.membershipEpoch, scope.questionId ?? null, scope.expectedVersion ?? null, scope.text ?? null])).digest('hex');
    const revoked = new Error('ask_session_ended');
    try {
        return await db.transaction(async (tx) => {
            const auth = await authorize(tx, db, principal, scope);
            if ('ok' in auth)
                return auth;
            const previous = (await tx.query<{
                fingerprint: string;
                question_id: string;
            }>('SELECT fingerprint,question_id FROM ask_commands WHERE actor_user_id=$1 AND command_id=$2', [principal.userId, scope.commandId])).rows[0];
            if (previous) {
                if (previous.fingerprint !== fingerprint)
                    return fail('idempotency_conflict');
                const current = await select(tx, scope, previous.question_id);
                if (!current || !await activeSession(tx, db, principal))
                    return fail('unavailable');
                return { ok: true, value: { question: view(current), commandId: scope.commandId!, replay: true } };
            }
            let current: Row;
            if (mode === 'create') {
                const used = Number((await tx.query<{
                    used: number;
                }>('SELECT count(*)::int AS used FROM asks WHERE couple_id=$1 AND membership_epoch=$2', [scope.coupleId, scope.membershipEpoch])).rows[0].used);
                if (used >= 100)
                    return fail('capacity_reached');
                if (!await activeSession(tx, db, principal))
                    return fail('unavailable');
                current = (await tx.query<Row>(`INSERT INTO asks(couple_id,author_id,recipient_id,membership_epoch,sequence,version,created_at,question_state,response_state,question)
        VALUES($1,$2,$3,$4,$5,1,$6,'active','waiting',$7) RETURNING ${columns}`, [scope.coupleId, principal.userId, auth.recipientId, scope.membershipEpoch, used + 1, trustedNow(db), scope.text])).rows[0];
            }
            else {
                const row = await select(tx, scope, scope.questionId!);
                if (!row || (mode === 'removeQuestion' ? row.author_id : row.recipient_id) !== principal.userId)
                    return fail('unavailable');
                const allowed = mode === 'removeQuestion' ? row.question_state === 'active' : mode === 'removeAnswer' ? row.response_state === 'answered' : row.response_state === 'waiting';
                if (!allowed || row.version !== scope.expectedVersion)
                    return fail('version_conflict');
                if (!await activeSession(tx, db, principal))
                    return fail('unavailable');
                const questionState = mode === 'removeQuestion' ? 'removed' : row.question_state;
                const responseState = mode === 'answer' ? 'answered' : mode === 'skip' ? 'skipped' : mode === 'removeAnswer' ? 'answer_removed' : row.response_state === 'waiting' ? 'withdrawn' : row.response_state;
                const question = mode === 'removeQuestion' ? null : row.question;
                const answer = mode === 'answer' ? scope.text : mode === 'removeAnswer' ? null : row.answer;
                current = (await tx.query<Row>(`UPDATE asks SET question_state=$2,response_state=$3,question=$4,answer=$5,answered_at=$6,version=version+1 WHERE id=$1 RETURNING ${columns}`, [row.id, questionState, responseState, question, answer, mode === 'answer' ? new Date(Math.max(trustedNow(db).getTime(), Date.parse(row.created_at))) : row.answered_at])).rows[0];
            }
            await tx.query('INSERT INTO ask_commands(actor_user_id,command_id,couple_id,membership_epoch,question_id,fingerprint) VALUES($1,$2,$3,$4,$5,$6)', [principal.userId, scope.commandId, scope.coupleId, scope.membershipEpoch, current.id, fingerprint]);
            // A receipt FK wait can cross session expiry. Throw, do not commit a failure result.
            if (!await activeSession(tx, db, principal))
                throw revoked;
            return { ok: true, value: { question: view(current), commandId: scope.commandId!, replay: false } };
        });
    }
    catch (error) {
        if (error === revoked)
            return fail('unavailable');
        throw error;
    }
}
