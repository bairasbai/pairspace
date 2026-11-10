import { lockPair } from './pair-close.ts';
import type { AuthorizedDatabase, Principal, SqlExecutor } from './contracts.ts';
import { validPrincipal } from './session.ts';
import { isEpoch, isUuid } from './validation.ts';
import { normalizeTaskTitle } from '../../../packages/domain/tasks/title.ts';
import { isLocalDate, validatedTimezone } from '../../../packages/domain/dates/calendar.ts';
export type SharedDate = Readonly<{ id: string; coupleId: string; creatorId: string; membershipEpoch: number;
  title: string; localDate: string; timezone: string; createdAt: string }>;
type Failure = { ok: false; error: 'invalid_request' | 'unavailable' | 'stale_membership' | 'idempotency_conflict' };
type Result<T> = { ok: true; value: T } | Failure;
type Scope = { coupleId: string; membershipEpoch: number; commandId?: string; title?: string; localDate?: string; timezone?: string };
type Row = { id: string; couple_id: string; creator_id: string; membership_epoch: number; title: string;
  local_date: string; timezone: string; created_at: string };
type Receipt = { couple_id: string; membership_epoch: number; date_id: string; title: string; local_date: string; timezone: string };
type Mutation = { date: SharedDate; commandId: string; replay: boolean };
const columns = 'id,couple_id,creator_id,membership_epoch,title,local_date,timezone,created_at::text';
const date = (r: Row): SharedDate => ({ id: r.id, coupleId: r.couple_id, creatorId: r.creator_id,
  membershipEpoch: r.membership_epoch, title: r.title, localDate: r.local_date, timezone: r.timezone,
  createdAt: new Date(r.created_at).toISOString() });
const fail = (error: Failure['error']): Failure => ({ ok: false, error });
function parse(input: unknown, mode: 'create' | 'list'): Scope | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const f = input as Record<string, unknown>;
  const keys = mode === 'list' ? 'coupleId,membershipEpoch' : 'commandId,coupleId,localDate,membershipEpoch,timezone,title';
  if (Object.keys(f).sort().join(',') !== keys || !isUuid(f.coupleId) || !isEpoch(f.membershipEpoch)) return null;
  const scope: Scope = { coupleId: f.coupleId.toLowerCase(), membershipEpoch: f.membershipEpoch };
  if (mode === 'list') return scope;
  if (!isUuid(f.commandId) || !isLocalDate(f.localDate)) return null;
  const title = normalizeTaskTitle(f.title), timezone = validatedTimezone(f.timezone);
  return title.ok && timezone ? { ...scope, commandId: f.commandId.toLowerCase(), title: title.text,
    localDate: f.localDate, timezone } : null;
}
async function authorize(tx: SqlExecutor, db: AuthorizedDatabase, principal: Principal, scope: Scope): Promise<Failure | null> {
  // Reuse closure lock order: historical users UPDATE → session → pair → fresh session.
  const pair = await lockPair(tx, db, principal, scope.coupleId);
  if (typeof pair === 'string') return fail('unavailable');
  const active = pair.members.filter(row => row.status === 'active');
  if (pair.status !== 'active' || active.length !== 2 || !active.some(row => row.user_id === principal.userId)) return fail('unavailable');
  return pair.epoch === scope.membershipEpoch ? null : fail('stale_membership');
}
export async function createSharedDate(db: AuthorizedDatabase, principal: Principal, input: unknown): Promise<Result<Mutation>> {
  if (!validPrincipal(principal)) return fail('unavailable');
  const scope = parse(input, 'create');
  if (!scope) return fail('invalid_request');
  return db.transaction(async tx => {
    const denied = await authorize(tx, db, principal, scope);
    if (denied) return denied;
    const zone = await tx.query<{ name: string }>('SELECT name FROM pg_timezone_names WHERE name=$1', [scope.timezone]);
    if (zone.rows.length !== 1) return fail('invalid_request');
    const previous = (await tx.query<Receipt>('SELECT couple_id,membership_epoch,date_id,title,local_date,timezone FROM shared_date_commands WHERE actor_user_id=$1 AND command_id=$2', [principal.userId, scope.commandId])).rows[0];
    if (previous) {
      if (previous.couple_id !== scope.coupleId || previous.membership_epoch !== scope.membershipEpoch
        || previous.title !== scope.title || previous.local_date !== scope.localDate || previous.timezone !== scope.timezone) return fail('idempotency_conflict');
      const row = (await tx.query<Row>(`SELECT ${columns} FROM shared_dates WHERE couple_id=$1 AND membership_epoch=$2 AND id=$3`,
        [scope.coupleId, scope.membershipEpoch, previous.date_id])).rows[0];
      return row ? { ok: true, value: { date: date(row), commandId: scope.commandId!, replay: true } } : fail('unavailable');
    }
    const now = db.now();
    if (!Number.isFinite(now.getTime())) throw new Error('invalid_server_clock');
    const row = (await tx.query<Row>(`INSERT INTO shared_dates(couple_id,creator_id,membership_epoch,title,local_date,timezone,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING ${columns}`,
      [scope.coupleId, principal.userId, scope.membershipEpoch, scope.title, scope.localDate, scope.timezone, now])).rows[0];
    await tx.query(`INSERT INTO shared_date_commands(actor_user_id,command_id,couple_id,membership_epoch,date_id,title,local_date,timezone)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [principal.userId, scope.commandId, scope.coupleId, scope.membershipEpoch,
      row.id, scope.title, scope.localDate, scope.timezone]);
    return { ok: true, value: { date: date(row), commandId: scope.commandId!, replay: false } };
  });
}
export async function listSharedDates(db: AuthorizedDatabase, principal: Principal, input: unknown): Promise<Result<{ dates: SharedDate[]; limit: 50 }>> {
  if (!validPrincipal(principal)) return fail('unavailable');
  const scope = parse(input, 'list');
  if (!scope) return fail('invalid_request');
  return db.transaction(async tx => {
    const denied = await authorize(tx, db, principal, scope);
    if (denied) return denied;
    const rows = await tx.query<Row>(`SELECT ${columns} FROM shared_dates WHERE couple_id=$1 AND membership_epoch=$2
      ORDER BY created_at DESC,id DESC LIMIT 50`, [scope.coupleId, scope.membershipEpoch]);
    return { ok: true, value: { dates: rows.rows.map(date), limit: 50 } };
  });
}
