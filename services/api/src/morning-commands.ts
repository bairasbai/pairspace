import { createHash } from 'node:crypto';
import type { AuthorizedDatabase, Principal, SqlExecutor } from './contracts.ts';
import { activeSession } from './session.ts';
import { isUuid } from './validation.ts';
import { normalizeMessageText } from '../../../packages/domain/chat/text.ts';
import { parseMorningPreference, resolveMorningChoice } from '../../../packages/domain/letters/morning.ts';
import { scheduleWithinWindow } from '../../../packages/domain/letters/schedule.ts';
import { morningInput, morningScope, type MorningScope, type MorningResult } from './morning-scope.ts';
import { morningPreferences, morningSlot, type MorningPreference, type MorningSlot } from './morning-data.ts';
export type MorningAck = {
    commandId: string;
    replay: boolean;
} & ({
    preference: MorningPreference;
} | {
    slot: MorningSlot;
});
type Operation = 'preference' | 'schedule' | 'fill';
const safeVersion = (n: unknown): n is number => Number.isInteger(n) && Number(n) >= 0 && Number(n) < 2147483646;
function parsed(input: unknown, operation: Operation) {
    const extra = operation === 'preference' ? ['expectedVersion', 'timezone', 'localTime']
        : operation === 'schedule' ? ['preferenceVersion', 'localDate', 'offset'] : ['slotId', 'body'];
    const f = morningInput(input, ['coupleId', 'membershipEpoch', 'commandId', ...extra]);
    if (!f || !isUuid(f.commandId))
        return null;
    const common = { ...f, coupleId: String(f.coupleId).toLowerCase(), commandId: f.commandId.toLowerCase() };
    if (operation === 'preference') {
        return typeof f.timezone === 'string' && f.timezone.length <= 100 && /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(f.timezone)
            && typeof f.localTime === 'string' && /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(f.localTime) && safeVersion(f.expectedVersion) ? common : null;
    }
    if (operation === 'schedule')
        return safeVersion(f.preferenceVersion) && Number(f.preferenceVersion) > 0
            && typeof f.localDate === 'string' && /^(20[0-9]{2}|2100)-[0-9]{2}-[0-9]{2}$/.test(f.localDate)
            && typeof f.offset === 'string' && /^[+-](0[0-9]|1[0-4]):[0-5][0-9]$/.test(f.offset) ? common : null;
    const body = normalizeMessageText(f.body);
    return isUuid(f.slotId) && body.ok ? { ...common, slotId: f.slotId.toLowerCase(), body: body.text } : null;
}
export async function commandMorning(db: AuthorizedDatabase, p: Principal, input: unknown, operation: Operation): Promise<MorningResult<MorningAck>> {
    const parsedValue = parsed(input, operation);
    if (!parsedValue)
        return { ok: false, error: 'invalid_request' };
    const f = parsedValue as Record<string, unknown>;
    const scope = { coupleId: String(f.coupleId), membershipEpoch: Number(f.membershipEpoch) };
    const commandId = String(f.commandId);
    // Sorted canonical fields bind operation and all scope/target/version/payload inputs, without plaintext receipts.
    const fingerprint = createHash('sha256').update(JSON.stringify([1, operation, p.userId, Object.keys(f).sort().map(k => [k, f[k]])])).digest('hex');
    return morningScope(db, p, scope, true, async (tx, partner) => {
        // Lock existing target rows before the final auth/time check, including raw maintenance writers.
        if (operation === 'preference')
            await tx.query('SELECT version FROM morning_preferences WHERE couple_id=$1 AND membership_epoch=$2 AND user_id=$3 FOR UPDATE', [scope.coupleId, scope.membershipEpoch, p.userId]);
        if (operation === 'schedule')
            await tx.query('SELECT version FROM morning_preferences WHERE couple_id=$1 AND membership_epoch=$2 AND user_id=$3 FOR SHARE', [scope.coupleId, scope.membershipEpoch, partner]);
        if (operation === 'fill')
            await tx.query('SELECT id FROM morning_slots WHERE id=$1 AND couple_id=$2 AND membership_epoch=$3 FOR UPDATE', [f.slotId, scope.coupleId, scope.membershipEpoch]);
        if (!await activeSession(tx, db, p))
            return { ok: false, error: 'unavailable' };
        const now = db.now();
        const old = (await tx.query<{
            fingerprint: string;
            slot_id: string | null;
        }>('SELECT fingerprint,slot_id FROM morning_command_receipts WHERE actor_id=$1 AND command_id=$2', [p.userId, commandId])).rows[0];
        if (old) {
            if (old.fingerprint !== fingerprint)
                return { ok: false, error: 'idempotency_conflict' };
            return canonical(tx, scope, p.userId, now, commandId, true, old.slot_id);
        }
        let slotId: string | null = null;
        if (operation === 'preference') {
            const normalized = parseMorningPreference(f.timezone, f.localTime);
            if (!normalized || !(await tx.query('SELECT 1 FROM pg_timezone_names WHERE name=$1', [normalized.timezone])).rows.length)
                return { ok: false, error: 'invalid_request' };
            const current = (await morningPreferences(tx, scope)).find(r => r.userId === p.userId);
            if ((current?.version ?? 0) !== f.expectedVersion)
                return { ok: false, error: 'version_conflict' };
            await tx.query(`INSERT INTO morning_preferences(couple_id,membership_epoch,user_id,timezone,local_time,version)
        VALUES($1,$2,$3,$4,$5,1) ON CONFLICT(couple_id,membership_epoch,user_id) DO UPDATE
        SET timezone=EXCLUDED.timezone,local_time=EXCLUDED.local_time,version=morning_preferences.version+1`, [scope.coupleId, scope.membershipEpoch, p.userId, normalized.timezone, normalized.localTime]);
        }
        else if (operation === 'schedule') {
            const preference = (await morningPreferences(tx, scope)).find(r => r.userId === partner);
            if (!preference || preference.version !== f.preferenceVersion)
                return { ok: false, error: 'version_conflict' };
            const choice = resolveMorningChoice(f.localDate, preference.localTime, preference.timezone, f.offset);
            if (!choice || !scheduleWithinWindow({ releaseAt: choice.releaseAt, releaseTimezone: preference.timezone }, now))
                return { ok: false, error: 'invalid_request' };
            if (!(await tx.query(`SELECT 1 WHERE $1::timestamptz AT TIME ZONE $2 = ($3::date+$4::time)`, [choice.releaseAt, preference.timezone, f.localDate, preference.localTime])).rows.length)
                return { ok: false, error: 'invalid_request' };
            const inserted = (await tx.query<{
                id: string;
            }>(`INSERT INTO morning_slots(couple_id,membership_epoch,sender_id,recipient_id,local_date,local_time,timezone,utc_offset,release_at,preference_version,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(couple_id,membership_epoch,recipient_id,local_date) DO NOTHING RETURNING id`, [scope.coupleId, scope.membershipEpoch, p.userId, partner, f.localDate, preference.localTime, preference.timezone, f.offset, choice.releaseAt, preference.version, now.toISOString()])).rows[0];
            if (!inserted)
                return { ok: false, error: 'slot_exists' };
            slotId = inserted.id;
        }
        else {
            slotId = String(f.slotId);
            const slot = await morningSlot(tx, scope, p.userId, now, slotId);
            if (!slot || slot.senderId !== p.userId)
                return { ok: false, error: 'unavailable' };
            if (now.getTime() >= Date.parse(slot.releaseAt))
                return { ok: false, error: 'slot_closed' };
            if (slot.prepared)
                return { ok: false, error: 'slot_filled' };
            const inserted = (await tx.query(`INSERT INTO morning_content(slot_id,body,filled_at)
        SELECT $1,$2,$3 WHERE clock_timestamp()<$4::timestamptz ON CONFLICT(slot_id) DO NOTHING RETURNING slot_id`, [slotId, f.body, now.toISOString(), slot.releaseAt])).rows;
            if (!inserted.length)
                return { ok: false, error: 'slot_closed' };
        }
        await tx.query(`INSERT INTO morning_command_receipts(actor_id,command_id,couple_id,membership_epoch,operation,fingerprint,slot_id)
      VALUES($1,$2,$3,$4,$5,$6,$7)`, [p.userId, commandId, scope.coupleId, scope.membershipEpoch, operation, fingerprint, slotId]);
        return canonical(tx, scope, p.userId, now, commandId, false, slotId);
    });
}
async function canonical(tx: SqlExecutor, scope: MorningScope, actor: string, now: Date, commandId: string, replay: boolean, slotId: string | null): Promise<MorningResult<MorningAck>> {
    if (slotId) {
        const slot = await morningSlot(tx, scope, actor, now, slotId);
        return slot ? { ok: true, value: { commandId, replay, slot } } : { ok: false, error: 'unavailable' };
    }
    const preference = (await morningPreferences(tx, scope)).find(p => p.userId === actor);
    return preference ? { ok: true, value: { commandId, replay, preference } } : { ok: false, error: 'unavailable' };
}
