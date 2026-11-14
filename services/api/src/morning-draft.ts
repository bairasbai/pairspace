import { createHash } from 'node:crypto';
import type { AuthorizedDatabase, Principal } from './contracts.ts';
import { activeSession } from './session.ts';
import { isUuid } from './validation.ts';
import { normalizeMessageText } from '../../../packages/domain/chat/text.ts';
import { morningInput, morningScope, type MorningResult } from './morning-scope.ts';
import { morningSlot, type MorningSlot } from './morning-data.ts';
export type MorningDraftValue = {
    serverNow: string; slot: MorningSlot; body: string | null; version: number;
    readId?: string; commandId?: string; replay?: boolean;
};
/** Private storage is independent of ready content and has no release transition. */
export async function draftMorning(db: AuthorizedDatabase, p: Principal, input: unknown, write: boolean): Promise<MorningResult<MorningDraftValue>> {
    const f = morningInput(input, ['coupleId', 'membershipEpoch', 'slotId', ...(write ? ['commandId', 'expectedVersion', 'body'] : ['readId'])]);
    const normalized = write ? normalizeMessageText(f?.body) : null;
    if (!f || !isUuid(f.slotId) || !isUuid(write ? f.commandId : f.readId)
        || (write && (!normalized?.ok || !Number.isInteger(f.expectedVersion) || Number(f.expectedVersion) < 0 || Number(f.expectedVersion) >= 2147483646)))
        return { ok: false, error: 'invalid_request' };
    const slotId = f.slotId.toLowerCase(), scope = { coupleId: String(f.coupleId).toLowerCase(), membershipEpoch: Number(f.membershipEpoch) };
    const commandId = String(f.commandId).toLowerCase(), body = normalized?.ok ? normalized.text : '';
    const fingerprint = createHash('sha256').update(JSON.stringify([1, p.userId, scope, slotId, f.expectedVersion, body])).digest('hex');
    return morningScope<MorningDraftValue>(db, p, scope, write, async tx => {
        await tx.query(`SELECT id FROM morning_slots WHERE id=$1 AND couple_id=$2 AND membership_epoch=$3 FOR ${write ? 'UPDATE' : 'SHARE'}`, [slotId, scope.coupleId, scope.membershipEpoch]);
        if (!await activeSession(tx, db, p)) return { ok: false, error: 'unavailable' };
        const now = db.now(), slot = await morningSlot(tx, scope, p.userId, now, slotId);
        if (!slot || slot.senderId !== p.userId) return { ok: false, error: 'unavailable' };
        const row = (await tx.query<{ body: string | null; version: number }>('SELECT body,version FROM morning_drafts WHERE slot_id=$1 AND actor_id=$2', [slotId, p.userId])).rows[0];
        if (row && row.body === null) return { ok: false, error: 'draft_deleted' };
        // Never create a new private draft from already published/prepared content.
        if (!row && slot.prepared) return { ok: false, error: 'slot_filled' };
        const current: { body: string | null; version: number } = row ?? { body: null, version: 0 };
        const value = () => ({ serverNow: now.toISOString(), slot, ...current });
        if (!write) return { ok: true, value: { ...value(), readId: String(f.readId).toLowerCase() } };
        const receipt = (await tx.query<{ fingerprint: string }>('SELECT fingerprint FROM morning_draft_receipts WHERE actor_id=$1 AND command_id=$2', [p.userId, commandId])).rows[0];
        if (receipt) return receipt.fingerprint === fingerprint ? { ok: true, value: { ...value(), commandId, replay: true } } : { ok: false, error: 'idempotency_conflict' };
        if (current.version !== f.expectedVersion) return { ok: false, error: 'version_conflict' };
        if (!row) {
            await tx.query('INSERT INTO morning_drafts(slot_id,actor_id,body,version) VALUES($1,$2,$3,1)', [slotId, p.userId, body]);
            current.body = body; current.version = 1;
        } else if (current.body !== body) {
            await tx.query('UPDATE morning_drafts SET body=$2,version=version+1 WHERE slot_id=$1', [slotId, body]);
            current.body = body; current.version++;
        }
        await tx.query('INSERT INTO morning_draft_receipts(actor_id,command_id,slot_id,fingerprint) VALUES($1,$2,$3,$4)', [p.userId, commandId, slotId, fingerprint]);
        return { ok: true, value: { ...value(), commandId, replay: false } };
    });
}
