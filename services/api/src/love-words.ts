import { createHash } from 'node:crypto';
import { normalizeWordText } from '../../../packages/domain/words/text.ts';
import type { AuthorizedDatabase, Principal, SqlExecutor } from './contracts.ts';
import { lockPair } from './pair-close.ts';
import { activeSession, validPrincipal } from './session.ts';
import { isEpoch, isUuid } from './validation.ts';
type Identity = Readonly<{
    id: string;
    coupleId: string;
    authorId: string;
    membershipEpoch: number;
    sequence: number;
    version: number;
    createdAt: string;
}>;
export type LoveWord = Identity & ({
    state: 'active';
    word: string;
    meaning: string;
    saidWhen: string;
    edited: boolean;
} | {
    state: 'deleted';
});
type ErrorCode = 'invalid_request' | 'unavailable' | 'stale_membership' | 'idempotency_conflict' | 'version_conflict' | 'capacity_reached';
type Failure = {
    ok: false;
    error: ErrorCode;
};
type Result<T> = {
    ok: true;
    value: T;
} | Failure;
type Mode = 'list' | 'create' | 'edit' | 'delete';
type Scope = {
    coupleId: string;
    membershipEpoch: number;
    commandId?: string;
    wordId?: string;
    expectedVersion?: number;
    word?: string;
    meaning?: string;
    saidWhen?: string;
};
type Row = {
    id: string;
    couple_id: string;
    author_id: string;
    membership_epoch: number;
    sequence: number;
    version: number;
    created_at: string;
} & ({
    state: 'active';
    word: string;
    meaning: string;
    said_when: string;
    edited: boolean;
} | {
    state: 'deleted';
    word: null;
    meaning: null;
    said_when: null;
    edited: null;
});
const columns = 'id,couple_id,author_id,membership_epoch,sequence,version,created_at::text,state,word,meaning,said_when,edited';
const fail = (error: ErrorCode): Failure => ({ ok: false, error });
function view(row: Row): LoveWord {
    const identity: Identity = { id: row.id, coupleId: row.couple_id, authorId: row.author_id, membershipEpoch: row.membership_epoch,
        sequence: row.sequence, version: row.version, createdAt: new Date(row.created_at).toISOString() };
    return row.state === 'deleted' ? { ...identity, state: 'deleted' } : { ...identity, state: 'active', word: row.word,
        meaning: row.meaning, saidWhen: row.said_when, edited: row.edited };
}
function parse(input: unknown, mode: Mode): Scope | null {
    if (!input || typeof input !== 'object' || Array.isArray(input))
        return null;
    const f = input as Record<string, unknown>;
    const allowed = ['coupleId', 'membershipEpoch', ...(mode === 'list' ? [] : ['commandId']),
        ...(mode === 'edit' || mode === 'delete' ? ['wordId', 'expectedVersion'] : []),
        ...(mode === 'create' || mode === 'edit' ? ['word', 'meaning', 'saidWhen'] : [])];
    if (Object.keys(f).some(key => !allowed.includes(key)) || !isUuid(f.coupleId) || !isEpoch(f.membershipEpoch))
        return null;
    const scope: Scope = { coupleId: f.coupleId.toLowerCase(), membershipEpoch: f.membershipEpoch };
    if (mode === 'list')
        return scope;
    if (!isUuid(f.commandId))
        return null;
    scope.commandId = f.commandId.toLowerCase();
    if (mode === 'edit' || mode === 'delete') {
        if (!isUuid(f.wordId) || !Number.isInteger(f.expectedVersion) || Number(f.expectedVersion) < 1 || Number(f.expectedVersion) > 2147483646)
            return null;
        scope.wordId = f.wordId.toLowerCase();
        scope.expectedVersion = Number(f.expectedVersion);
    }
    if (mode === 'delete')
        return scope;
    const word = normalizeWordText(f.word, 'word'), meaning = normalizeWordText(f.meaning, 'optional'), saidWhen = normalizeWordText(f.saidWhen, 'optional');
    return word === null || meaning === null || saidWhen === null ? null : { ...scope, word, meaning, saidWhen };
}
async function authorize(tx: SqlExecutor, db: AuthorizedDatabase, principal: Principal, scope: Scope): Promise<Failure | null> {
    const pair = await lockPair(tx, db, principal, scope.coupleId);
    if (typeof pair === 'string')
        return fail('unavailable');
    const active = pair.members.filter(member => member.status === 'active');
    if (pair.status !== 'active' || active.length !== 2 || !active.some(member => member.user_id === principal.userId))
        return fail('unavailable');
    return pair.epoch === scope.membershipEpoch ? null : fail('stale_membership');
}
const select = async (tx: SqlExecutor, scope: Scope, id: string) => (await tx.query<Row>(`SELECT ${columns} FROM love_words WHERE couple_id=$1 AND membership_epoch=$2 AND id=$3 FOR UPDATE`, [scope.coupleId, scope.membershipEpoch, id])).rows[0];
export async function listLoveWords(db: AuthorizedDatabase, principal: Principal, input: unknown): Promise<Result<{
    words: LoveWord[];
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
        const denied = await authorize(tx, db, principal, scope);
        if (denied)
            return denied;
        const rows = (await tx.query<Row>(`SELECT ${columns} FROM love_words WHERE couple_id=$1 AND membership_epoch=$2 ORDER BY sequence DESC LIMIT 101`, [scope.coupleId, scope.membershipEpoch])).rows;
        if (rows.length > 100)
            throw Error('invalid_dictionary_capacity');
        if (!await activeSession(tx, db, principal))
            return fail('unavailable');
        return { ok: true, value: { words: rows.map(view), checkedAt: db.now().toISOString(), capacity: 100, used: rows.length } };
    });
}
export const createLoveWord = (db: AuthorizedDatabase, principal: Principal, input: unknown) => mutate(db, principal, input, 'create');
export const editLoveWord = (db: AuthorizedDatabase, principal: Principal, input: unknown) => mutate(db, principal, input, 'edit');
export const deleteLoveWord = (db: AuthorizedDatabase, principal: Principal, input: unknown) => mutate(db, principal, input, 'delete');
async function mutate(db: AuthorizedDatabase, principal: Principal, input: unknown, mode: Exclude<Mode, 'list'>): Promise<Result<{
    word: LoveWord;
    commandId: string;
    replay: boolean;
}>> {
    if (!validPrincipal(principal))
        return fail('unavailable');
    const scope = parse(input, mode);
    if (!scope)
        return fail('invalid_request');
    // Only this command fingerprint is retained in command receipts, never the text.
    const fingerprint = createHash('sha256').update(JSON.stringify([mode, scope.coupleId, scope.membershipEpoch,
        scope.wordId ?? null, scope.expectedVersion ?? null, scope.word ?? null, scope.meaning ?? null, scope.saidWhen ?? null])).digest('hex');
    const revoked = new Error('word_session_ended');
    try {
        return await db.transaction(async (tx) => {
            const denied = await authorize(tx, db, principal, scope);
            if (denied)
                return denied;
            const previous = (await tx.query<{
                fingerprint: string;
                word_id: string;
            }>('SELECT fingerprint,word_id FROM love_word_commands WHERE actor_user_id=$1 AND command_id=$2', [principal.userId, scope.commandId])).rows[0];
            if (previous) {
                if (previous.fingerprint !== fingerprint)
                    return fail('idempotency_conflict');
                const current = await select(tx, scope, previous.word_id);
                if (!current || !await activeSession(tx, db, principal))
                    return fail('unavailable');
                return { ok: true, value: { word: view(current), commandId: scope.commandId!, replay: true } };
            }
            let current: Row;
            if (mode === 'create') {
                const used = Number((await tx.query<{
                    used: number;
                }>('SELECT count(*)::int AS used FROM love_words WHERE couple_id=$1 AND membership_epoch=$2', [scope.coupleId, scope.membershipEpoch])).rows[0].used);
                if (used >= 100)
                    return fail('capacity_reached');
                if (!await activeSession(tx, db, principal))
                    return fail('unavailable');
                current = (await tx.query<Row>(`INSERT INTO love_words(couple_id,author_id,membership_epoch,sequence,created_at,state,word,meaning,said_when,edited)
          VALUES($1,$2,$3,$4,$5,'active',$6,$7,$8,false) RETURNING ${columns}`, [scope.coupleId, principal.userId, scope.membershipEpoch, used + 1, db.now(), scope.word, scope.meaning, scope.saidWhen])).rows[0];
            }
            else {
                const row = await select(tx, scope, scope.wordId!);
                if (!row || row.author_id !== principal.userId)
                    return fail('unavailable');
                if (row.state === 'deleted' || row.version !== scope.expectedVersion)
                    return fail('version_conflict');
                if (!await activeSession(tx, db, principal))
                    return fail('unavailable');
                if (mode === 'delete')
                    current = (await tx.query<Row>(`UPDATE love_words SET state='deleted',word=NULL,meaning=NULL,said_when=NULL,edited=NULL,version=version+1 WHERE id=$1 RETURNING ${columns}`, [row.id])).rows[0];
                else if (row.word === scope.word && row.meaning === scope.meaning && row.said_when === scope.saidWhen)
                    current = row;
                else
                    current = (await tx.query<Row>(`UPDATE love_words SET word=$2,meaning=$3,said_when=$4,edited=true,version=version+1 WHERE id=$1 RETURNING ${columns}`, [row.id, scope.word, scope.meaning, scope.saidWhen])).rows[0];
            }
            await tx.query('INSERT INTO love_word_commands(actor_user_id,command_id,couple_id,membership_epoch,word_id,fingerprint) VALUES($1,$2,$3,$4,$5,$6)', [principal.userId, scope.commandId, scope.coupleId, scope.membershipEpoch, current.id, fingerprint]);
            // FK waits may outlive authentication; returning a failure inside the tx would commit.
            if (!await activeSession(tx, db, principal))
                throw revoked;
            return { ok: true, value: { word: view(current), commandId: scope.commandId!, replay: false } };
        });
    }
    catch (error) {
        if (error === revoked)
            return fail('unavailable');
        throw error;
    }
}
