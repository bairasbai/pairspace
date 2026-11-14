import { createHash } from 'node:crypto';
import type { AuthorizedDatabase, Principal } from './contracts.ts';
import { activeSession } from './session.ts';
import { isUuid } from './validation.ts';
import { morningInput, morningScope, type MorningResult } from './morning-scope.ts';
import { morningSlot, type MorningSlot } from './morning-data.ts';
import { morningBody } from './morning-read.ts';
export type MorningOpenAck = {
    commandId: string;
    replay: boolean;
    slot: MorningSlot;
    body: string;
};
export async function openMorning(db: AuthorizedDatabase, p: Principal, input: unknown): Promise<MorningResult<MorningOpenAck>> {
    const f = morningInput(input, ['coupleId', 'membershipEpoch', 'slotId', 'commandId', 'confirm']);
    if (!f || !isUuid(f.slotId) || !isUuid(f.commandId) || f.confirm !== true)
        return { ok: false, error: 'invalid_request' };
    const scope = { coupleId: String(f.coupleId).toLowerCase(), membershipEpoch: Number(f.membershipEpoch) };
    const slotId = f.slotId.toLowerCase(), commandId = f.commandId.toLowerCase();
    const fingerprint = createHash('sha256').update(JSON.stringify([1, 'open', p.userId, scope.coupleId, scope.membershipEpoch, slotId, true])).digest('hex');
    return morningScope(db, p, scope, true, async (tx) => {
        await tx.query('SELECT id FROM morning_slots WHERE id=$1 AND couple_id=$2 AND membership_epoch=$3 FOR UPDATE', [slotId, scope.coupleId, scope.membershipEpoch]);
        if (!await activeSession(tx, db, p))
            return { ok: false, error: 'unavailable' };
        const now = db.now();
        const old = (await tx.query<{
            fingerprint: string;
        }>('SELECT fingerprint FROM morning_command_receipts WHERE actor_id=$1 AND command_id=$2', [p.userId, commandId])).rows[0];
        if (old && old.fingerprint !== fingerprint)
            return { ok: false, error: 'idempotency_conflict' };
        let slot = await morningSlot(tx, scope, p.userId, now, slotId);
        if (!slot || slot.recipientId !== p.userId)
            return { ok: false, error: 'unavailable' };
        if (!slot.openedAt) {
            if (slot.state !== 'available')
                return { ok: false, error: 'slot_closed' };
            const inserted = (await tx.query(`INSERT INTO morning_openings(slot_id,recipient_id,opened_at)
        SELECT $1,$2,$3 WHERE clock_timestamp()>=$4::timestamptz ON CONFLICT(slot_id) DO NOTHING RETURNING slot_id`, [slotId, p.userId, now.toISOString(), slot.releaseAt])).rows;
            if (!inserted.length)
                return { ok: false, error: 'slot_closed' };
            slot = await morningSlot(tx, scope, p.userId, now, slotId);
            if (!slot)
                return { ok: false, error: 'unavailable' };
        }
        if (!old)
            await tx.query(`INSERT INTO morning_command_receipts(actor_id,command_id,couple_id,membership_epoch,operation,fingerprint,slot_id)
      VALUES($1,$2,$3,$4,'open',$5,$6)`, [p.userId, commandId, scope.coupleId, scope.membershipEpoch, fingerprint, slotId]);
        const body = await morningBody(tx, scope, p.userId, slotId, now);
        if (body === undefined)
            throw Error('morning_open_invariant');
        return { ok: true, value: { commandId, replay: Boolean(old), slot, body } };
    });
}
