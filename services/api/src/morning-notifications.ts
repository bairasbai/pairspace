import type { Database } from './contracts.ts';
import { isUuid } from './validation.ts';
import { defaultNotificationFields, evaluateNotificationPolicy } from '../../../packages/domain/notifications/preferences.ts';

type Slot = { id: string; couple_id: string; membership_epoch: number; sender_id: string; recipient_id: string; release_at: string };
type Reason = 'allowed' | 'disabled' | 'quiet_hours' | 'missed' | 'unavailable';
type Row = { id: string; slot_id: string; couple_id: string; recipient_id: string; membership_epoch: number;
  state: 'simulation_eligible' | 'simulation_blocked'; reason: Reason; evaluated_at: string; preference_version: number | null };
const columns = `id,slot_id,couple_id,recipient_id,membership_epoch,state,reason,
  to_char(evaluated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS evaluated_at,preference_version`;
function observation(row: Row, replay: boolean) {
  return { id: row.id, slotId: row.slot_id, coupleId: row.couple_id, recipientId: row.recipient_id,
    membershipEpoch: row.membership_epoch, state: row.state, reason: row.reason,
    asOf: row.evaluated_at, preferenceVersion: row.preference_version,
    simulationOnly: true as const, historicalObservation: true as const, replay };
}
/** Internal explicit slot observation, NOT legacy letters, opening or delivery.
 * SQL time is sampled once after locks; db.now is deliberately not used. */
export async function simulateMorningSlot(db: Database, slotId: unknown) {
  if (!isUuid(slotId)) return { ok: false as const, error: 'invalid_request' as const };
  return db.transaction(async tx => {
    const candidate = (await tx.query<{ couple_id: string }>('SELECT couple_id FROM morning_slots WHERE id=$1', [slotId])).rows[0];
    if (!candidate) return { ok: false as const, error: 'not_found' as const };
    const pair = (await tx.query<{ status: string; membership_epoch: number }>(
      'SELECT status,membership_epoch FROM couples WHERE id=$1 FOR UPDATE', [candidate.couple_id])).rows[0];
    const slot = (await tx.query<Slot>(`SELECT id,couple_id,membership_epoch,sender_id,recipient_id,release_at::text
      FROM morning_slots WHERE id=$1 AND couple_id=$2 FOR UPDATE`, [slotId,candidate.couple_id])).rows[0];
    if (!slot) return { ok: false as const, error: 'not_found' as const };
    const members = (await tx.query<{ user_id: string }>(
      "SELECT user_id FROM couple_members WHERE couple_id=$1 AND status='active' ORDER BY user_id FOR SHARE", [slot.couple_id])).rows;
    const clock = (await tx.query<{ now: string; released: boolean }>(`WITH checked AS MATERIALIZED
      (SELECT clock_timestamp() AS instant) SELECT
      to_char(instant AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS now,
      instant >= $1::timestamptz AS released FROM checked`, [slot.release_at])).rows[0];
    const now = new Date(clock?.now), release = Date.parse(slot.release_at);
    if (!Number.isFinite(now.getTime()) || !Number.isFinite(release)) throw Error('invalid_server_clock');
    // Do not even query content existence, preferences or stored observations before release.
    if (!clock.released) return { ok: true as const, value: { state: 'not_due' as const, simulationOnly: true as const } };
    const previous = (await tx.query<Row>(`SELECT ${columns} FROM morning_notification_simulations WHERE slot_id=$1`, [slotId])).rows[0];
    if (previous) return { ok: true as const, value: observation(previous,true) };
    let reason: Reason = 'unavailable', preferenceVersion: number | null = null;
    const authorized = pair?.status === 'active' && pair.membership_epoch === slot.membership_epoch
      && members.length === 2 && slot.sender_id !== slot.recipient_id
      && members.some(m => m.user_id === slot.sender_id) && members.some(m => m.user_id === slot.recipient_id);
    if (authorized) {
      const prepared = (await tx.query<{ prepared: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM morning_content c JOIN morning_slots s ON s.id=c.slot_id
          WHERE s.id=$1 AND s.release_at <= $2::timestamptz) AS prepared`, [slotId,clock.now])).rows[0].prepared;
      reason = 'missed';
      if (prepared) {
        const pref = (await tx.query<{ care: boolean; chat: boolean; letter: boolean; version: number;
          quiet_start: string | null; quiet_end: string | null; timezone: string | null }>(
          'SELECT care,chat,letter,version,quiet_start,quiet_end,timezone FROM notification_preferences WHERE couple_id=$1 AND membership_epoch=$2 AND user_id=$3',
          [slot.couple_id,slot.membership_epoch,slot.recipient_id])).rows[0];
        const fields = pref ? { care: pref.care, chat: pref.chat, letter: pref.letter,
          quiet: pref.quiet_start === null ? null : { start: pref.quiet_start, end: pref.quiet_end!, timezone: pref.timezone! } } : defaultNotificationFields;
        reason = evaluateNotificationPolicy(fields,'letter',now).reason;
        preferenceVersion = pref?.version ?? 0;
      }
    }
    const row = (await tx.query<Row>(`INSERT INTO morning_notification_simulations
      (slot_id,couple_id,recipient_id,membership_epoch,state,reason,evaluated_at,preference_version)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${columns}`,
      [slotId,slot.couple_id,slot.recipient_id,slot.membership_epoch,
        reason === 'allowed' ? 'simulation_eligible' : 'simulation_blocked',reason,clock.now,preferenceVersion])).rows[0];
    return { ok: true as const, value: observation(row,false) };
  });
}
