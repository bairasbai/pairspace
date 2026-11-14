import type { AuthorizedDatabase, Principal, Result, SqlExecutor } from './contracts.ts';
import { authorizeChat } from './chat.ts';
import { activeSession, validPrincipal } from './session.ts';
import { isEpoch, isUuid } from './validation.ts';
export type Visibility = {
    messageId: string;
    hidden: boolean;
    version: number;
};
export async function currentVisibility(tx: SqlExecutor, p: Principal, couple: string, epoch: number, id: string): Promise<Visibility> {
    const row = (await tx.query<{
        hidden: boolean;
        version: number;
    }>(`SELECT hidden,version FROM chat_message_visibility
    WHERE actor_id=$1 AND couple_id=$2 AND membership_epoch=$3 AND message_id=$4`, [p.userId, couple, epoch, id])).rows[0];
    return { messageId: id, hidden: row?.hidden ?? false, version: row?.version ?? 0 };
}
export async function visibilityTarget(tx: SqlExecutor, couple: string, id: string): Promise<boolean> {
    return (await tx.query(`SELECT m.id FROM chat_messages m JOIN couple_members cm ON cm.couple_id=m.couple_id
    AND cm.user_id=m.sender_id AND cm.status='active' WHERE m.couple_id=$1 AND m.id=$2`, [couple, id])).rows.length > 0;
}
function parse(input: unknown, write: boolean) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
        return null;
    const f = input as Record<string, unknown>;
    const keys = write ? 'commandId,coupleId,expectedVersion,hidden,membershipEpoch,messageId' : 'coupleId,membershipEpoch,messageId,readId';
    if (Object.keys(f).sort().join(',') !== keys || !isUuid(f.coupleId) || !isEpoch(f.membershipEpoch)
        || !isUuid(f.messageId) || !isUuid(write ? f.commandId : f.readId))
        return null;
    if (write && (typeof f.hidden !== 'boolean' || !Number.isInteger(f.expectedVersion)
        || Number(f.expectedVersion) < 0 || Number(f.expectedVersion) >= 2147483647))
        return null;
    return { couple: f.coupleId.toLowerCase(), epoch: f.membershipEpoch, id: f.messageId.toLowerCase(),
        nonce: String(write ? f.commandId : f.readId).toLowerCase(), hidden: f.hidden === true, expected: Number(f.expectedVersion) };
}
export async function readChatVisibility(db: AuthorizedDatabase, p: Principal, input: unknown): Promise<Result<{
    visibility: Visibility;
    readId: string;
}>> {
    const f = parse(input, false);
    if (!validPrincipal(p))
        return { ok: false, error: 'unavailable' };
    if (!f)
        return { ok: false, error: 'invalid_request' };
    return db.transaction(async (tx) => {
        if (!await activeSession(tx, db, p))
            return { ok: false, error: 'unavailable' };
        const denied = await authorizeChat(tx, p, f.couple, f.epoch, false);
        if (denied)
            return { ok: false, error: denied };
        if (!await activeSession(tx, db, p))
            return { ok: false, error: 'unavailable' };
        if (!await visibilityTarget(tx, f.couple, f.id))
            return { ok: false, error: 'message_unavailable' };
        return { ok: true, value: { visibility: await currentVisibility(tx, p, f.couple, f.epoch, f.id), readId: f.nonce } };
    });
}
type Receipt = {
    couple_id: string;
    membership_epoch: number;
    message_id: string;
    expected_version: number;
    hidden: boolean;
};
export async function setChatVisibility(db: AuthorizedDatabase, p: Principal, input: unknown): Promise<Result<{
    visibility: Visibility;
    commandId: string;
    replay: boolean;
}>> {
    const f = parse(input, true);
    if (!validPrincipal(p))
        return { ok: false, error: 'unavailable' };
    if (!f)
        return { ok: false, error: 'invalid_request' };
    return db.transaction(async (tx) => {
        if (!await activeSession(tx, db, p))
            return { ok: false, error: 'unavailable' };
        const denied = await authorizeChat(tx, p, f.couple, f.epoch, true);
        if (denied)
            return { ok: false, error: denied };
        await tx.query(`SELECT revision FROM chat_visibility_scopes WHERE actor_id=$1 AND couple_id=$2 AND membership_epoch=$3 FOR UPDATE`, [p.userId,f.couple,f.epoch]);
        await tx.query(`SELECT version FROM chat_message_visibility WHERE actor_id=$1 AND couple_id=$2 AND membership_epoch=$3 AND message_id=$4 FOR UPDATE`, [p.userId,f.couple,f.epoch,f.id]);
        if (!await activeSession(tx, db, p))
            return { ok: false, error: 'unavailable' };
        const receipt = (await tx.query<Receipt>(`SELECT couple_id,membership_epoch,message_id,expected_version,hidden
      FROM chat_visibility_receipts WHERE actor_id=$1 AND command_id=$2`, [p.userId, f.nonce])).rows[0];
        if (receipt && (receipt.couple_id !== f.couple || receipt.membership_epoch !== f.epoch || receipt.message_id !== f.id
            || receipt.expected_version !== f.expected || receipt.hidden !== f.hidden))
            return { ok: false, error: 'idempotency_conflict' };
        if (!await visibilityTarget(tx, f.couple, f.id))
            return { ok: false, error: 'message_unavailable' };
        let visibility = await currentVisibility(tx, p, f.couple, f.epoch, f.id);
        if (receipt)
            return { ok: true, value: { visibility, commandId: f.nonce, replay: true } };
        if (visibility.version !== f.expected)
            return { ok: false, error: 'version_conflict' };
        await tx.query(`INSERT INTO chat_visibility_scopes(actor_id,couple_id,membership_epoch) VALUES($1,$2,$3)
      ON CONFLICT DO NOTHING`, [p.userId, f.couple, f.epoch]);
        if (visibility.hidden !== f.hidden) {
            if (visibility.version === 0) {
                await tx.query(`INSERT INTO chat_message_visibility(actor_id,couple_id,membership_epoch,message_id,hidden,version)
          VALUES($1,$2,$3,$4,true,1)`, [p.userId, f.couple, f.epoch, f.id]);
            }
            else {
                await tx.query(`UPDATE chat_message_visibility SET hidden=$5,version=version+1
          WHERE actor_id=$1 AND couple_id=$2 AND membership_epoch=$3 AND message_id=$4`, [p.userId, f.couple, f.epoch, f.id, f.hidden]);
            }
            visibility = await currentVisibility(tx, p, f.couple, f.epoch, f.id);
        }
        await tx.query(`INSERT INTO chat_visibility_receipts(actor_id,command_id,couple_id,membership_epoch,message_id,
      expected_version,hidden,applied_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [p.userId, f.nonce, f.couple, f.epoch, f.id, f.expected, f.hidden, visibility.version]);
        return { ok: true, value: { visibility, commandId: f.nonce, replay: false } };
    });
}
