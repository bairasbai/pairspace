import { createHash } from 'node:crypto';
import type { AuthorizedDatabase, Principal } from './contracts.ts';
import { activeSession } from './session.ts';
import { isUuid } from './validation.ts';
import { normalizeMessageText } from '../../../packages/domain/chat/text.ts';
import { morningInput, type MorningResult } from './morning-scope.ts';
import { access, allowed, columns, convertV2, type Row, type MorningDiscussionMessageV2 } from './morning-discussions.ts';
export type MorningMutationAck = {
    commandId: string;
    replay: boolean;
    message: MorningDiscussionMessageV2;
};
export type MorningMutationResult = MorningResult<MorningMutationAck> | {
    ok: false;
    error: 'message_deleted';
    value: {
        commandId: string;
        message: MorningDiscussionMessageV2;
    };
};
export async function mutateMorningDiscussion(db: AuthorizedDatabase, p: Principal, input: unknown, operation: 'edit' | 'delete'): Promise<MorningMutationResult> {
    const f = morningInput(input, ['coupleId', 'membershipEpoch', 'slotId', 'messageId', 'commandId', 'expectedVersion', operation === 'edit' ? 'body' : 'confirm']);
    if (!f || !isUuid(f.slotId) || !isUuid(f.messageId) || !isUuid(f.commandId) || !Number.isInteger(f.expectedVersion) || Number(f.expectedVersion) < 1 || Number(f.expectedVersion) >= 2147483646)
        return { ok: false, error: 'invalid_request' };
    const text = operation === 'edit' ? normalizeMessageText(f.body) : null;
    if (operation === 'edit' && !text?.ok || operation === 'delete' && f.confirm !== true)
        return { ok: false, error: 'invalid_request' };
    const body = text?.ok ? text.text : null;
    const digest = body === null ? null : createHash('sha256').update(body).digest('hex');
    const scope = { coupleId: String(f.coupleId).toLowerCase(), membershipEpoch: Number(f.membershipEpoch), slotId: f.slotId.toLowerCase() };
    const messageId = f.messageId.toLowerCase(), commandId = f.commandId.toLowerCase(), version = Number(f.expectedVersion);
    const fingerprint = createHash('sha256').update(JSON.stringify([1, operation, p.userId, scope.coupleId, scope.membershipEpoch, scope.slotId, messageId, version, digest])).digest('hex');
    // A terminal canonical outcome is carried separately so ordinary errors never gain a body.
    let terminal: {
        commandId: string;
        message: MorningDiscussionMessageV2;
    } | undefined;
    const result = await access<MorningMutationAck>(db, p, scope, true, async (tx) => {
        const locked = (await tx.query<{
            id: string;
            author_id: string;
        }>(`SELECT id,author_id FROM morning_discussion_messages WHERE id=$1 AND slot_id=$2 AND couple_id=$3 AND membership_epoch=$4 FOR UPDATE`, [messageId, scope.slotId, scope.coupleId, scope.membershipEpoch])).rows[0];
        if (!await activeSession(tx, db, p))
            return { ok: false, error: 'unavailable' };
        const now = db.now();
        if (!await allowed(tx, p, scope, now))
            return { ok: false, error: 'unavailable' };
        if (!locked || locked.author_id !== p.userId)
            return { ok: false, error: 'unavailable' };
        const target = (await tx.query<Row>(`SELECT ${columns} FROM morning_discussion_messages WHERE id=$1 AND slot_id=$2 AND couple_id=$3 AND membership_epoch=$4`, [messageId, scope.slotId, scope.coupleId, scope.membershipEpoch])).rows[0];
        if (!target)
            return { ok: false, error: 'unavailable' };
        const old = (await tx.query<{
            fingerprint: string;
        }>('SELECT fingerprint FROM morning_discussion_mutation_receipts WHERE actor_id=$1 AND command_id=$2', [p.userId, commandId])).rows[0];
        if (old) {
            if (old.fingerprint !== fingerprint)
                return { ok: false, error: 'idempotency_conflict' };
            return { ok: true, value: { commandId, replay: true, message: convertV2(target) } };
        }
        if (target.deleted_at) {
            terminal = { commandId, message: convertV2(target) };
            return { ok: false, error: 'unavailable' };
        }
        if (target.version !== version)
            return { ok: false, error: 'version_conflict' };
        const noop = operation === 'edit' && target.body === body;
        let current = target;
        if (!noop) {
            const changed = (await tx.query<Row>(`UPDATE morning_discussion_messages SET body=$5,version=version+1,
    edited_at=CASE WHEN $6='edit' THEN GREATEST($7::timestamptz,created_at,edited_at) ELSE edited_at END,
    deleted_at=CASE WHEN $6='delete' THEN GREATEST($7::timestamptz,created_at,edited_at) ELSE NULL END
    WHERE id=$1 AND slot_id=$2 AND couple_id=$3 AND version=$4 RETURNING ${columns}`, [messageId, scope.slotId, scope.coupleId, version, body, operation, now.toISOString()])).rows[0];
            if (!changed)
                return { ok: false, error: 'version_conflict' };
            current = changed;
        }
        await tx.query(`INSERT INTO morning_discussion_mutation_receipts(actor_id,command_id,couple_id,membership_epoch,slot_id,message_id,
   operation,expected_version,applied_version,is_noop,fingerprint,body_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [p.userId, commandId, scope.coupleId, scope.membershipEpoch, scope.slotId, messageId, operation, version, current.version, noop, fingerprint, digest]);
        return { ok: true, value: { commandId, replay: false, message: convertV2(current) } };
    });
    return terminal ? { ok: false, error: 'message_deleted', value: terminal } : result;
}
