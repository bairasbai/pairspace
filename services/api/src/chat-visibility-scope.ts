import { isUuid, isEpoch } from './validation.ts';
import type { AuthorizedDatabase, Principal, SqlExecutor } from './contracts.ts';
type Scope = {
    actor: string;
    couple: string;
    epoch: number;
};
const scopes = new WeakMap<SqlExecutor, Scope>();
const capabilities = new WeakMap<SqlExecutor, boolean>();
export function rememberChatScope(tx: SqlExecutor, p: Principal, couple: string, epoch: number) {
    if (!isUuid(p.userId) || !isUuid(couple) || !isEpoch(epoch))
        throw new Error('invalid_visibility_scope');
    scopes.set(tx, { actor: p.userId, couple, epoch });
}
export async function hasVisibilitySchema(tx: SqlExecutor): Promise<boolean> {
    if (!capabilities.has(tx)) {
        const row = (await tx.query<{
            available: boolean;
        }>("SELECT to_regclass('chat_visibility_scopes') IS NOT NULL AS available")).rows[0];
        capabilities.set(tx, row?.available === true);
    }
    return capabilities.get(tx) === true;
}
/** Only validated, locked authorization scope is interpolated; no request strings. */
export async function visibleChatPredicate(tx: SqlExecutor, alias = 'chat_messages'): Promise<string> {
    const scope = scopes.get(tx);
    if (!scope || !await hasVisibilitySchema(tx))
        return 'TRUE';
    if (!/^[a-z_]+$/.test(alias))
        throw new Error('invalid_visibility_alias');
    return `NOT EXISTS(SELECT 1 FROM chat_message_visibility v WHERE v.message_id=${alias}.id
    AND v.actor_id='${scope.actor}'::uuid AND v.couple_id='${scope.couple}'::uuid
    AND v.membership_epoch=${scope.epoch} AND v.hidden)`;
}
export async function chatMessageHidden(tx: SqlExecutor, id: string): Promise<boolean> {
    const scope = scopes.get(tx);
    if (!scope || !await hasVisibilitySchema(tx))
        return false;
    return (await tx.query(`SELECT 1 FROM chat_message_visibility WHERE actor_id=$1 AND couple_id=$2
    AND membership_epoch=$3 AND message_id=$4 AND hidden`, [scope.actor, scope.couple, scope.epoch, id])).rows.length > 0;
}
export async function chatVisibilityRevision(tx: SqlExecutor): Promise<number | undefined> {
    const scope = scopes.get(tx);
    if (!scope || !await hasVisibilitySchema(tx))
        return undefined;
    const row = (await tx.query<{
        revision: string;
    }>(`SELECT revision::text AS revision FROM chat_visibility_scopes
    WHERE actor_id=$1 AND couple_id=$2 AND membership_epoch=$3`, [scope.actor, scope.couple, scope.epoch])).rows[0];
    const revision = Number(row?.revision ?? 0);
    if (!Number.isSafeInteger(revision))
        throw new Error('visibility_revision_overflow');
    return revision;
}
/** Request-local capture: revision and result are obtained before the same transaction releases its pair lock. */
export function visibilityResponse(db: AuthorizedDatabase, factory: (bound: AuthorizedDatabase) => (request: Request) => Promise<Response>) {
    return async (request: Request): Promise<Response> => {
        let revision: number | undefined;
        let hidden: HiddenReplay | undefined;
        const bound: AuthorizedDatabase = {
            now: () => db.now(), sessionAuthority: db.sessionAuthority,
            transaction: work => db.transaction(async (tx) => {
                const result = await work(tx);
                if (result && typeof result === 'object')
                    hidden = hiddenResults.get(result);
                if (!(result && typeof result === 'object' && 'error' in result && result.error === 'unavailable')) {
                    revision = await chatVisibilityRevision(tx);
                }
                return result;
            }),
        };
        const response = await factory(bound)(request);
        const opted = request.headers.get('x-chat-visibility') === '1';
        let output = response;
        if (opted && hidden)
            output = Response.json({ ok: true, value: hidden }, { status: 200, headers: response.headers });
        const json: unknown = await response.clone().json().catch(() => null);
        if ((!hidden || !opted) && json && typeof json === 'object' && 'error' in json && json.error === 'message_hidden') {
            const plain = new URL(request.url).pathname.endsWith('/messages');
            output = Response.json({ ...json, error: opted ? 'message_hidden' : plain ? 'unavailable' : 'reply_unavailable' }, { status: opted || !plain ? 409 : 403, headers: response.headers });
        }
        if (opted && revision !== undefined && output.status !== 401 && output.status !== 403) {
            output.headers.set('X-Chat-Visibility-Revision', String(revision));
        }
        return output;
    };
}
type HiddenMessage = {
    id: string;
    coupleId: string;
    senderId: string;
    clientId: string;
    seq: number;
    version: number;
    createdAt: string;
    replyToId: string | null;
    deletedAt: string | null;
};
type HiddenReplay = {
    replay: true;
    hiddenMessage: HiddenMessage;
    commandId?: string;
};
const hiddenResults = new WeakMap<object, HiddenReplay>();
export async function hiddenChatReplay(tx: SqlExecutor, id: string, commandId?: string): Promise<{
    ok: false;
    error: 'message_hidden';
}> {
    const scope = scopes.get(tx);
    if (!scope)
        throw new Error('missing_visibility_scope');
    const r = (await tx.query<{
        id: string;
        couple_id: string;
        sender_id: string;
        client_message_id: string;
        seq: string;
        version: number;
        created_at: string;
        reply_to_id: string | null;
        deleted_at: string | null;
    }>(`SELECT id,couple_id,sender_id,
    client_message_id,seq::text,version,created_at::text,reply_to_id,deleted_at::text FROM chat_messages
    WHERE couple_id=$1 AND id=$2`, [scope.couple, id])).rows[0];
    if (!r)
        throw new Error('missing_hidden_replay');
    const result = { ok: false as const, error: 'message_hidden' as const };
    hiddenResults.set(result, { replay: true, ...(commandId ? { commandId } : {}), hiddenMessage: { id: r.id, coupleId: r.couple_id,
            senderId: r.sender_id, clientId: r.client_message_id, seq: Number(r.seq), version: r.version, createdAt: r.created_at,
            replyToId: r.reply_to_id, deletedAt: r.deleted_at ? new Date(r.deleted_at).toISOString() : null } });
    return result;
}
export async function hiddenOriginal(tx: SqlExecutor, id: string) {
    return (await tx.query<{
        body: null;
        has_original_body_hash: boolean;
        original_body_hash: string | null;
        reply_to_id: string | null;
    }>(`SELECT NULL::text AS body,true AS has_original_body_hash,to_jsonb(chat_messages)->>'original_body_hash' AS original_body_hash,
      reply_to_id FROM chat_messages WHERE id=$1`, [id])).rows[0];
}
