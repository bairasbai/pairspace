import type { AuthorizedDatabase, Principal, SqlExecutor } from './contracts.ts';
import { activeSession, validPrincipal } from './session.ts';
import { isEpoch, isUuid } from './validation.ts';
export type CareSignal = Readonly<{ id: string; coupleId: string; senderId: string; recipientId: string;
  clientId: string; membershipEpoch: number; kind: 'thinking_of_you'; createdAt: string }>;
type Failure = { ok: false; error: 'invalid_request' | 'unavailable' | 'stale_membership' | 'idempotency_conflict' | 'cooldown' };
type Result<T> = { ok: true; value: T } | Failure;
type Row = { id: string; couple_id: string; sender_id: string; recipient_id: string;
  client_signal_id: string; membership_epoch: number; kind: 'thinking_of_you'; created_at: string };
const columns = 'id, couple_id, sender_id, recipient_id, client_signal_id, membership_epoch, kind, created_at::text';
const signal = (r: Row): CareSignal => ({ id: r.id, coupleId: r.couple_id, senderId: r.sender_id,
  recipientId: r.recipient_id, clientId: r.client_signal_id, membershipEpoch: r.membership_epoch,
  kind: r.kind, createdAt: new Date(r.created_at).toISOString() });
const fail = (error: Failure['error']): Failure => ({ ok: false, error });
type Scope = { coupleId: string; membershipEpoch: number; clientId?: string };
function parse(input: unknown, write: boolean): Scope | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const fields = input as Record<string, unknown>;
  if (Object.keys(fields).sort().join(',') !== (write ? 'clientId,coupleId,membershipEpoch' : 'coupleId,membershipEpoch')
    || !isUuid(fields.coupleId) || !isEpoch(fields.membershipEpoch) || (write && !isUuid(fields.clientId))) return null;
  return fields as Scope;
}
async function authorize(tx: SqlExecutor, principal: Principal, scope: Scope, write: boolean): Promise<Result<string>> {
  const pair = await tx.query<{ status: string; membership_epoch: number }>(
    `SELECT status, membership_epoch FROM couples WHERE id=$1 FOR ${write ? 'UPDATE' : 'SHARE'}`, [scope.coupleId]);
  const row = pair.rows[0];
  if (!row || row.status !== 'active') return fail('unavailable');
  const members = await tx.query<{ user_id: string }>(
    "SELECT user_id FROM couple_members WHERE couple_id=$1 AND status='active' ORDER BY user_id FOR SHARE", [scope.coupleId]);
  if (members.rows.length !== 2 || !members.rows.some(r => r.user_id === principal.userId)) return fail('unavailable');
  if (row.membership_epoch !== scope.membershipEpoch) return fail('stale_membership');
  return { ok: true, value: members.rows.find(r => r.user_id !== principal.userId)!.user_id };
}
export async function sendCareSignal(db: AuthorizedDatabase, principal: Principal, input: unknown): Promise<Result<{ signal: CareSignal; replay: boolean }>> {
  if (!validPrincipal(principal)) return fail('unavailable');
  const scope = parse(input, true);
  if (!scope) return fail('invalid_request');
  return db.transaction(async tx => {
    if (!await activeSession(tx, db, principal)) return fail('unavailable');
    const recipient = await authorize(tx, principal, scope, true);
    if (!recipient.ok) return recipient;
    const now = db.now();
    if (!Number.isFinite(now.getTime())) throw new Error('invalid_server_clock');
    // Session expiration may have passed while waiting for the pair lock.
    if (!await activeSession(tx, db, principal)) return fail('unavailable');
    const previous = await tx.query<Row>(`SELECT ${columns} FROM care_signals WHERE sender_id=$1 AND client_signal_id=$2`, [principal.userId, scope.clientId]);
    if (previous.rows[0]) {
      const old = previous.rows[0];
      if (old.couple_id !== scope.coupleId || old.membership_epoch !== scope.membershipEpoch || old.recipient_id !== recipient.value) return fail('idempotency_conflict');
      return { ok: true, value: { signal: signal(old), replay: true } };
    }
    const recent = await tx.query(`SELECT id FROM care_signals WHERE couple_id=$1 AND sender_id=$2 AND created_at > $3::timestamptz - interval '60 seconds' LIMIT 1`, [scope.coupleId, principal.userId, now]);
    if (recent.rows.length) return fail('cooldown');
    const inserted = await tx.query<Row>(`INSERT INTO care_signals(couple_id,sender_id,recipient_id,client_signal_id,membership_epoch,created_at)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING ${columns}`, [scope.coupleId, principal.userId, recipient.value, scope.clientId, scope.membershipEpoch, now]);
    return { ok: true, value: { signal: signal(inserted.rows[0]), replay: false } };
  });
}
export async function readCareSignal(db: AuthorizedDatabase, principal: Principal, input: unknown): Promise<Result<{ signal: CareSignal | null }>> {
  if (!validPrincipal(principal)) return fail('unavailable');
  const scope = parse(input, false);
  if (!scope) return fail('invalid_request');
  return db.transaction(async tx => {
    if (!await activeSession(tx, db, principal)) return fail('unavailable');
    const partner = await authorize(tx, principal, scope, false);
    if (!partner.ok) return partner;
    const now = db.now();
    if (!Number.isFinite(now.getTime())) throw new Error('invalid_server_clock');
    if (!await activeSession(tx, db, principal)) return fail('unavailable');
    const latest = await tx.query<Row>(`SELECT ${columns} FROM care_signals WHERE couple_id=$1 AND recipient_id=$2
      AND sender_id=$3 AND membership_epoch=$4 AND created_at > $5::timestamptz - interval '24 hours'
      AND created_at <= $5 ORDER BY created_at DESC, id DESC LIMIT 1`, [scope.coupleId, principal.userId, partner.value, scope.membershipEpoch, now]);
    return { ok: true, value: { signal: latest.rows[0] ? signal(latest.rows[0]) : null } };
  });
}
