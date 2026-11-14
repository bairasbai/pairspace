import { createHash } from 'node:crypto';
import type { AuthorizedDatabase, Principal, SqlExecutor } from './contracts.ts';
import { activeSession } from './session.ts';
import { isUuid } from './validation.ts';
import { normalizeMessageText } from '../../../packages/domain/chat/text.ts';
import { morningInput, morningScope, type MorningResult } from './morning-scope.ts';
import { morningSlot, type MorningSlot } from './morning-data.ts';
export type PreparedValue = {
    serverNow: string;
    slot: MorningSlot;
    body: string;
    version: number;
};
async function content(tx: SqlExecutor, slotId: string) {
    return (await tx.query<{
        body: string;
        version: number;
    }>('SELECT body,version FROM morning_content WHERE slot_id=$1', [slotId])).rows[0];
}
export async function preparedMorning(db: AuthorizedDatabase, p: Principal, input: unknown, edit: boolean): Promise<MorningResult<PreparedValue & {
    readId?: string;
    commandId?: string;
    replay?: boolean;
}>> {
    const f = morningInput(input, ['coupleId', 'membershipEpoch', 'slotId', ...(edit ? ['commandId', 'expectedVersion', 'body'] : ['readId'])]);
    const normalized = edit ? normalizeMessageText(f?.body) : null;
    if (!f || !isUuid(f.slotId) || !isUuid(edit ? f.commandId : f.readId)
        || (edit && (!normalized?.ok || !Number.isInteger(f.expectedVersion) || Number(f.expectedVersion) < 1 || Number(f.expectedVersion) >= 2147483646)))
        return { ok: false, error: 'invalid_request' };
    const slotId = f.slotId.toLowerCase(), scope = { coupleId: String(f.coupleId).toLowerCase(), membershipEpoch: Number(f.membershipEpoch) };
    const commandId = String(f.commandId).toLowerCase();
    const body = normalized?.ok ? normalized.text : '';
    const fingerprint = createHash('sha256').update(JSON.stringify([1, p.userId, scope, slotId, f.expectedVersion, body])).digest('hex');
    return morningScope<PreparedValue & {
        readId?: string;
        commandId?: string;
        replay?: boolean;
    }>(db, p, scope, edit, async (tx) => {
        await tx.query(`SELECT id FROM morning_slots WHERE id=$1 AND couple_id=$2 AND membership_epoch=$3 FOR ${edit ? 'UPDATE' : 'SHARE'}`, [slotId, scope.coupleId, scope.membershipEpoch]);
        if (!await activeSession(tx, db, p))
            return { ok: false, error: 'unavailable' };
        const now = db.now(), slot = await morningSlot(tx, scope, p.userId, now, slotId);
        if (!slot || slot.senderId !== p.userId)
            return { ok: false, error: 'unavailable' };
        const current = await content(tx, slotId);
        if (!current)
            return { ok: false, error: 'unavailable' };
        const value = () => ({ serverNow: now.toISOString(), slot, ...current });
        if (edit) {
            const receipt = (await tx.query<{
                fingerprint: string;
            }>('SELECT fingerprint FROM morning_prepared_receipts WHERE actor_id=$1 AND command_id=$2', [p.userId, commandId])).rows[0];
            if (receipt)
                return receipt.fingerprint === fingerprint ? { ok: true, value: { ...value(), commandId, replay: true } } : { ok: false, error: 'idempotency_conflict' };
        }
        const before = (await tx.query<{
            allowed: boolean;
        }>('SELECT clock_timestamp()<$1::timestamptz AS allowed', [slot.releaseAt])).rows[0].allowed;
        if (now.getTime() >= Date.parse(slot.releaseAt) || !before)
            return { ok: false, error: 'slot_closed' };
        if (!edit)
            return { ok: true, value: { ...value(), readId: String(f.readId).toLowerCase() } };
        if (current.version !== f.expectedVersion)
            return { ok: false, error: 'version_conflict' };
        if (current.body !== body) {
            const updated = (await tx.query<{
                body: string;
                version: number;
            }>(`UPDATE morning_content SET body=$2,version=version+1 WHERE slot_id=$1 AND version=$3
                AND clock_timestamp()<$4::timestamptz RETURNING body,version`, [slotId, body, current.version, slot.releaseAt])).rows[0];
            if (!updated)
                return { ok: false, error: 'slot_closed' };
            Object.assign(current, updated);
        }
        await tx.query('INSERT INTO morning_prepared_receipts(actor_id,command_id,slot_id,fingerprint) VALUES($1,$2,$3,$4)', [p.userId, commandId, slotId, fingerprint]);
        return { ok: true, value: { ...value(), commandId, replay: false } };
    }).catch((error: unknown) => {
        // A guard may observe the deadline after the earlier read. The transaction
        // has already rolled back, including any body change or no-op receipt.
        if (error instanceof Error && error.message === 'morning_slot_closed')
            return { ok: false as const, error: 'slot_closed' as const };
        throw error;
    });
}
