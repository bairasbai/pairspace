import { createHash } from 'node:crypto';
import type { AuthorizedDatabase, Principal } from './contracts.ts';
import { activeSession } from './session.ts';
import { isUuid } from './validation.ts';
import { normalizeMessageText } from '../../../packages/domain/chat/text.ts';
import { morningInput, morningScope, type MorningResult } from './morning-scope.ts';
import { morningSlot, type MorningSlot } from './morning-data.ts';
export type MorningDraftV2Value = {
    serverNow: string; slot: MorningSlot; body: string | null; version: number;
    state: 'missing' | 'live' | 'deleted'; readId?: string; commandId?: string; replay?: boolean;
};
/** Private storage is independent of ready content and has no release transition. */
export async function draftMorningV2(db: AuthorizedDatabase, p: Principal, input: unknown, operation: 'read' | 'save' | 'delete'): Promise<MorningResult<MorningDraftV2Value> | { ok: false; error: 'draft_deleted'; value: MorningDraftV2Value }> {
    const write = operation !== 'read', remove = operation === 'delete';
    const f = morningInput(input, ['coupleId', 'membershipEpoch', 'slotId', ...(write ? ['commandId', 'expectedVersion', ...(remove ? ['confirm'] : ['body'])] : ['readId'])]);
    const normalized = write && !remove ? normalizeMessageText(f?.body) : null;
    if (!f || !isUuid(f.slotId) || !isUuid(write ? f.commandId : f.readId)
        || (write && ((remove ? f.confirm !== true : !normalized?.ok) || !Number.isInteger(f.expectedVersion) || Number(f.expectedVersion) < (remove ? 1 : 0) || Number(f.expectedVersion) >= 2147483646)))
        return { ok: false, error: 'invalid_request' };
    const slotId = f.slotId.toLowerCase(), scope = { coupleId: String(f.coupleId).toLowerCase(), membershipEpoch: Number(f.membershipEpoch) };
    const commandId = String(f.commandId).toLowerCase(), body = normalized?.ok ? normalized.text : '';
    const fingerprint = createHash('sha256').update(JSON.stringify([1, p.userId, scope, slotId, f.expectedVersion, remove ? 'delete' : body])).digest('hex');
    return morningScope<MorningDraftV2Value>(db, p, scope, write, async tx => {
        await tx.query(`SELECT id FROM morning_slots WHERE id=$1 AND couple_id=$2 AND membership_epoch=$3 FOR ${write ? 'UPDATE' : 'SHARE'}`, [slotId, scope.coupleId, scope.membershipEpoch]);
        if (!await activeSession(tx, db, p)) return { ok: false, error: 'unavailable' };
        const now = db.now(), slot = await morningSlot(tx, scope, p.userId, now, slotId);
        if (!slot || slot.senderId !== p.userId) return { ok: false, error: 'unavailable' };
        const row = (await tx.query<{ body: string | null; version: number; state: 'live' | 'deleted' }>('SELECT body,version,state FROM morning_drafts WHERE slot_id=$1 AND actor_id=$2', [slotId, p.userId])).rows[0];
        // Never create a new private draft from already published/prepared content.
        if (!row && slot.prepared && !remove) return { ok: false, error: 'slot_filled' };
        const current: { body: string | null; version: number; state: 'missing' | 'live' | 'deleted' } = row ?? { body: null, version: 0, state: 'missing' };
        const value = () => ({ serverNow: now.toISOString(), slot, ...current });
        if (!write) return { ok: true, value: { ...value(), readId: String(f.readId).toLowerCase() } };
        const table = remove ? 'morning_draft_delete_receipts' : 'morning_draft_receipts';
        const receipt = (await tx.query<{ fingerprint: string }>(`SELECT fingerprint FROM ${table} WHERE actor_id=$1 AND command_id=$2`, [p.userId, commandId])).rows[0];
        if (receipt) return receipt.fingerprint === fingerprint ? { ok: true, value: { ...value(), commandId, replay: true } } : { ok: false, error: 'idempotency_conflict' };
        if (current.state === 'deleted') return { ok: false, error: 'draft_deleted', value: { ...value(), commandId, replay: false } };
        if (remove && !row) return { ok: false, error: 'draft_missing' };
        if (current.version !== f.expectedVersion) return { ok: false, error: 'version_conflict' };
        if (remove) {
            await tx.query("UPDATE morning_drafts SET body=NULL,state='deleted',version=version+1 WHERE slot_id=$1", [slotId]);
            current.body = null; current.state = 'deleted'; current.version++;
        } else if (!row) {
            await tx.query('INSERT INTO morning_drafts(slot_id,actor_id,body,version) VALUES($1,$2,$3,1)', [slotId, p.userId, body]);
            current.body = body; current.version = 1; current.state = 'live';
        } else if (current.body !== body) {
            await tx.query('UPDATE morning_drafts SET body=$2,version=version+1 WHERE slot_id=$1', [slotId, body]);
            current.body = body; current.version++;
        }
        await tx.query(`INSERT INTO ${table}(actor_id,command_id,slot_id,fingerprint) VALUES($1,$2,$3,$4)`, [p.userId, commandId, slotId, fingerprint]);
        return { ok: true, value: { ...value(), commandId, replay: false } };
    });
}
