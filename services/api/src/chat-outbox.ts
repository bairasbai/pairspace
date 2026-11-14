import type { Database, SqlExecutor } from './contracts.ts';
import { isUuid } from './validation.ts';
import { defaultNotificationFields, evaluateNotificationPolicy } from '../../../packages/domain/notifications/preferences.ts';

type Reason = 'allowed' | 'disabled' | 'quiet_hours' | 'unavailable' | 'deleted' | 'hidden';
type Context = { event_id: string; couple_id: string; message_id: string; sender_id: string; recipient_id: string; membership_epoch: number };
type Source = { sender_id: string; version: number; deleted_at: string | null; created_at: string };
type Row = { id: string; event_id: string; couple_id: string; recipient_id: string; membership_epoch: number;
  state: 'simulation_eligible' | 'simulation_blocked'; reason: Reason; evaluated_at: string;
  preference_version: number | null; message_version: number | null };
const columns = 'id,event_id,couple_id,recipient_id,membership_epoch,state,reason,evaluated_at::text,preference_version,message_version';
function observation(row: Row, replay: boolean) {
  return { id: row.id, eventId: row.event_id, coupleId: row.couple_id, recipientId: row.recipient_id,
    membershipEpoch: row.membership_epoch, state: row.state, reason: row.reason,
    asOf: new Date(row.evaluated_at).toISOString(), preferenceVersion: row.preference_version,
    messageVersion: row.message_version, simulationOnly: true as const, historicalObservation: true as const, replay };
}
function trustedNow(db: Database) {
  const now = db.now();
  if (!Number.isFinite(now.getTime())) throw Error('invalid_server_clock');
  return now;
}
async function evaluate(tx: SqlExecutor, db: Database, context: Context,
  pair: { status: string; membership_epoch: number } | undefined) {
  // Metadata only. Never load a body, body hash, reply parent/preview or identity profile.
  const source = (await tx.query<Source>(
    'SELECT sender_id,version,deleted_at::text,created_at::text FROM chat_messages WHERE couple_id=$1 AND id=$2 FOR SHARE',
    [context.couple_id,context.message_id])).rows[0];
  const members = (await tx.query<{ user_id: string }>(
    "SELECT user_id FROM couple_members WHERE couple_id=$1 AND status='active' ORDER BY user_id FOR SHARE", [context.couple_id])).rows;
  if (!pair || pair.status !== 'active' || pair.membership_epoch !== context.membership_epoch || !source
    || source.sender_id !== context.sender_id || context.sender_id === context.recipient_id || members.length !== 2
    || !members.some(m => m.user_id === context.sender_id) || !members.some(m => m.user_id === context.recipient_id)) {
    return { reason: 'unavailable' as Reason, preferenceVersion: null, messageVersion: null, now: trustedNow(db) };
  }
  if (source.deleted_at !== null) {
    return { reason: 'deleted' as Reason, preferenceVersion: null, messageVersion: source.version, now: trustedNow(db) };
  }
  const visibility = (await tx.query<{ hidden: boolean }>(
    'SELECT hidden FROM chat_message_visibility WHERE actor_id=$1 AND couple_id=$2 AND membership_epoch=$3 AND message_id=$4',
    [context.recipient_id,context.couple_id,context.membership_epoch,context.message_id])).rows[0];
  if (visibility?.hidden) {
    return { reason: 'hidden' as Reason, preferenceVersion: null, messageVersion: source.version, now: trustedNow(db) };
  }
  const row = (await tx.query<{ care: boolean; chat: boolean; letter: boolean; version: number;
    quiet_start: string | null; quiet_end: string | null; timezone: string | null }>(
    'SELECT care,chat,letter,version,quiet_start,quiet_end,timezone FROM notification_preferences WHERE couple_id=$1 AND membership_epoch=$2 AND user_id=$3',
    [context.couple_id,context.membership_epoch,context.recipient_id])).rows[0];
  const now = trustedNow(db), created = new Date(source.created_at).getTime();
  if (!Number.isFinite(created) || created > now.getTime()) {
    return { reason: 'unavailable' as Reason, preferenceVersion: null, messageVersion: null, now };
  }
  const fields = row ? { care: row.care, chat: row.chat, letter: row.letter,
    quiet: row.quiet_start === null ? null : { start: row.quiet_start, end: row.quiet_end!, timezone: row.timezone! } } : defaultNotificationFields;
  return { reason: evaluateNotificationPolicy(fields,'chat',now).reason as Reason,
    preferenceVersion: row?.version ?? 0, messageVersion: source.version, now };
}
/** Trusted internal simulation only. A replay is old evidence, never a current delivery grant. */
export async function simulateChatOutbox(db: Database, eventId: unknown) {
  if (!isUuid(eventId)) return { ok: false as const, error: 'invalid_request' as const };
  return db.transaction(async tx => {
    const candidate = (await tx.query<{ couple_id: string }>(
      'SELECT couple_id FROM chat_notification_context WHERE event_id=$1', [eventId])).rows[0];
    if (!candidate) return { ok: false as const, error: 'not_found' as const };
    const pair = (await tx.query<{ status: string; membership_epoch: number }>(
      'SELECT status,membership_epoch FROM couples WHERE id=$1 FOR UPDATE', [candidate.couple_id])).rows[0];
    const context = (await tx.query<Context>(`SELECT c.event_id,c.couple_id,c.message_id,c.sender_id,c.recipient_id,c.membership_epoch
      FROM chat_notification_context c JOIN outbox_events o ON o.id=c.event_id AND o.couple_id=c.couple_id AND o.message_id=c.message_id
      WHERE c.event_id=$1 AND c.couple_id=$2 AND o.type='chat.message_created' FOR UPDATE OF o`, [eventId,candidate.couple_id])).rows[0];
    if (!context) return { ok: false as const, error: 'not_found' as const };
    const previous = (await tx.query<Row>(`SELECT ${columns} FROM chat_notification_simulations WHERE event_id=$1`, [eventId])).rows[0];
    if (previous) return { ok: true as const, value: observation(previous,true) };
    const decision = await evaluate(tx,db,context,pair);
    const row = (await tx.query<Row>(`INSERT INTO chat_notification_simulations
      (event_id,couple_id,recipient_id,membership_epoch,state,reason,evaluated_at,preference_version,message_version)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${columns}`,
      [eventId,context.couple_id,context.recipient_id,context.membership_epoch,
        decision.reason === 'allowed' ? 'simulation_eligible' : 'simulation_blocked',decision.reason,decision.now,
        decision.preferenceVersion,decision.messageVersion])).rows[0];
    // Shared outbox processed_at deliberately unchanged: other consumers are not completed here.
    return { ok: true as const, value: observation(row,false) };
  });
}
