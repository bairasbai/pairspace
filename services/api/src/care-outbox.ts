import type { Database, SqlExecutor } from './contracts.ts';
import { isUuid } from './validation.ts';
import { defaultNotificationFields, evaluateNotificationPolicy } from '../../../packages/domain/notifications/preferences.ts';

type Reason = 'allowed' | 'disabled' | 'quiet_hours' | 'unavailable' | 'expired';
type Row = { id: string; event_id: string; couple_id: string; recipient_id: string; membership_epoch: number;
  state: 'simulation_eligible' | 'simulation_blocked'; reason: Reason; evaluated_at: string; preference_version: number | null };
type Source = { couple_id: string; care_signal_id: string; membership_epoch: number;
  sender_id: string; recipient_id: string; kind: string; created_at: string; source_epoch: number };
const columns = 'id,event_id,couple_id,recipient_id,membership_epoch,state,reason,evaluated_at::text,preference_version';
function observation(row: Row, replay: boolean) {
  return { id: row.id, eventId: row.event_id, coupleId: row.couple_id, recipientId: row.recipient_id,
    membershipEpoch: row.membership_epoch, state: row.state, reason: row.reason,
    asOf: new Date(row.evaluated_at).toISOString(), preferenceVersion: row.preference_version,
    simulationOnly: true as const, historicalObservation: true as const, replay };
}
async function decide(tx: SqlExecutor, source: Source, db: Database, pair: { status: string; membership_epoch: number } | undefined) {
  const members = (await tx.query<{ user_id: string }>(
    "SELECT user_id FROM couple_members WHERE couple_id=$1 AND status='active' ORDER BY user_id FOR SHARE", [source.couple_id])).rows;
  const now = db.now();
  if (!Number.isFinite(now.getTime())) throw Error('invalid_server_clock');
  if (!pair || pair.status !== 'active' || pair.membership_epoch !== source.membership_epoch
    || source.source_epoch !== source.membership_epoch || source.kind !== 'thinking_of_you'
    || source.sender_id === source.recipient_id || members.length !== 2
    || !members.some(m => m.user_id === source.sender_id) || !members.some(m => m.user_id === source.recipient_id)) {
    return { reason: 'unavailable' as Reason, version: null, now };
  }
  const age = now.getTime() - new Date(source.created_at).getTime();
  if (!Number.isFinite(age) || age < 0) return { reason: 'unavailable' as Reason, version: null, now };
  if (age >= 86400000) return { reason: 'expired' as Reason, version: null, now };
  const row = (await tx.query<{ care: boolean; chat: boolean; letter: boolean; version: number;
    quiet_start: string | null; quiet_end: string | null; timezone: string | null }>(
    'SELECT care,chat,letter,version,quiet_start,quiet_end,timezone FROM notification_preferences WHERE couple_id=$1 AND membership_epoch=$2 AND user_id=$3',
    [source.couple_id, source.membership_epoch, source.recipient_id])).rows[0];
  const fields = row ? { care: row.care, chat: row.chat, letter: row.letter,
    quiet: row.quiet_start === null ? null : { start: row.quiet_start, end: row.quiet_end!, timezone: row.timezone! } } : defaultNotificationFields;
  return { reason: evaluateNotificationPolicy(fields, 'care', now).reason as Reason, version: row?.version ?? 0, now };
}
/** Trusted internal composition only. No endpoint, credentials or external delivery.
 * A replay is immutable historical evidence, never current permission to notify. */
export async function simulateCareOutbox(db: Database, eventId: unknown) {
  if (!isUuid(eventId)) return { ok: false as const, error: 'invalid_request' as const };
  return db.transaction(async tx => {
    const candidate = (await tx.query<{ couple_id: string }>(
      "SELECT couple_id FROM outbox_events WHERE id=$1 AND type='care.signal_created'", [eventId])).rows[0];
    if (!candidate) return { ok: false as const, error: 'not_found' as const };
    // Pair first is shared ordering with producer, preference save and leave. No external I/O.
    const pair = (await tx.query<{ status: string; membership_epoch: number }>(
      'SELECT status,membership_epoch FROM couples WHERE id=$1 FOR UPDATE', [candidate.couple_id])).rows[0];
    const source = (await tx.query<Source>(`SELECT o.couple_id,o.care_signal_id,o.membership_epoch,
      s.sender_id,s.recipient_id,s.kind,s.created_at::text,s.membership_epoch AS source_epoch
      FROM outbox_events o JOIN care_signals s ON s.couple_id=o.couple_id AND s.id=o.care_signal_id
      WHERE o.id=$1 AND o.couple_id=$2 AND o.type='care.signal_created' FOR UPDATE OF o`, [eventId,candidate.couple_id])).rows[0];
    if (!source) return { ok: false as const, error: 'not_found' as const };
    const previous = (await tx.query<Row>(`SELECT ${columns} FROM care_notification_simulations WHERE event_id=$1`, [eventId])).rows[0];
    if (previous) return { ok: true as const, value: observation(previous, true) };
    const decision = await decide(tx, source, db, pair);
    const now = decision.now;
    const row = (await tx.query<Row>(`INSERT INTO care_notification_simulations
      (event_id,couple_id,recipient_id,membership_epoch,state,reason,evaluated_at,preference_version)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${columns}`,
      [eventId,source.couple_id,source.recipient_id,source.membership_epoch,
        decision.reason === 'allowed' ? 'simulation_eligible' : 'simulation_blocked',decision.reason,now,decision.version])).rows[0];
    await tx.query('UPDATE outbox_events SET processed_at=$2 WHERE id=$1', [eventId,now]);
    return { ok: true as const, value: observation(row, false) };
  });
}
