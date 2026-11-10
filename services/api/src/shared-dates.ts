import { lockPair } from './pair-close.ts';
import type { AuthorizedDatabase, Principal, SqlExecutor } from './contracts.ts';
import { validPrincipal } from './session.ts';
import { isEpoch, isUuid } from './validation.ts';
import { normalizeTaskTitle } from '../../../packages/domain/tasks/title.ts';
import { isDateSchedule, nextOccurrence, zonedLocalDate, type Recurrence, type LeapDayPolicy } from '../../../packages/domain/dates/recurrence.ts';
import { isLocalDate, validatedTimezone } from '../../../packages/domain/dates/calendar.ts';
export type SharedDate = Readonly<{ id: string; coupleId: string; creatorId: string; membershipEpoch: number;
  title: string; localDate: string; timezone: string; createdAt: string; recurrence: Recurrence; leapDayPolicy: LeapDayPolicy | null;
  asOfLocalDate: string | null; nextOccurrence: string | null }>;
type Failure = { ok: false; error: 'invalid_request' | 'unavailable' | 'stale_membership' | 'idempotency_conflict' };
type Result<T> = { ok: true; value: T } | Failure;
type Scope = { coupleId: string; membershipEpoch: number; commandId?: string; title?: string; localDate?: string; timezone?: string; recurrence?: Recurrence; leapDayPolicy?: LeapDayPolicy | null };
type Row = { id: string; couple_id: string; creator_id: string; membership_epoch: number; title: string;
  local_date: string; timezone: string; created_at: string; recurrence: Recurrence; leap_day_policy: LeapDayPolicy | null };
type Receipt = { couple_id: string; membership_epoch: number; date_id: string; title: string; local_date: string; timezone: string; recurrence: Recurrence; leap_day_policy: LeapDayPolicy | null };
type Mutation = { date: SharedDate; commandId: string; replay: boolean };
const columns = 'id,couple_id,creator_id,membership_epoch,title,local_date,timezone,created_at::text,recurrence,leap_day_policy';
function date(r: Row, now: Date): SharedDate {
  const asOfLocalDate = zonedLocalDate(now, r.timezone);
  return { id: r.id, coupleId: r.couple_id, creatorId: r.creator_id,
    membershipEpoch: r.membership_epoch, title: r.title, localDate: r.local_date, timezone: r.timezone,
    createdAt: new Date(r.created_at).toISOString(), recurrence: r.recurrence, leapDayPolicy: r.leap_day_policy,
    asOfLocalDate, nextOccurrence: asOfLocalDate === null ? null
      : nextOccurrence(r.local_date, r.recurrence, r.leap_day_policy, asOfLocalDate) };
}
function trustedNow(db: AuthorizedDatabase): Date {
  const now = db.now();
  if (!Number.isFinite(now.getTime())) throw new Error('invalid_server_clock');
  return now;
}
const fail = (error: Failure['error']): Failure => ({ ok: false, error });
function parse(input: unknown, mode: 'create' | 'list'): Scope | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const f = input as Record<string, unknown>;
  const keys = mode === 'list' ? 'coupleId,membershipEpoch' : 'commandId,coupleId,localDate,membershipEpoch,timezone,title';
  const extra = mode === 'create' ? ['recurrence', 'leapDayPolicy'] : [];
  if (Object.keys(f).filter(key => !extra.includes(key)).sort().join(',') !== keys || !isUuid(f.coupleId) || !isEpoch(f.membershipEpoch)) return null;
  const scope: Scope = { coupleId: f.coupleId.toLowerCase(), membershipEpoch: f.membershipEpoch };
  if (mode === 'list') return scope;
  if (!isUuid(f.commandId) || !isLocalDate(f.localDate)) return null;
  const recurrence = Object.hasOwn(f, 'recurrence') ? f.recurrence : 'once';
  const leapDayPolicy = Object.hasOwn(f, 'leapDayPolicy') ? f.leapDayPolicy : null;
  if (!isDateSchedule(f.localDate, recurrence, leapDayPolicy)) return null;
  const title = normalizeTaskTitle(f.title), timezone = validatedTimezone(f.timezone);
  return title.ok && timezone ? { ...scope, commandId: f.commandId.toLowerCase(), title: title.text,
    localDate: f.localDate, timezone, recurrence: recurrence as Recurrence, leapDayPolicy: leapDayPolicy as LeapDayPolicy | null } : null;
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
    const previous = (await tx.query<Receipt>('SELECT couple_id,membership_epoch,date_id,title,local_date,timezone,recurrence,leap_day_policy FROM shared_date_commands WHERE actor_user_id=$1 AND command_id=$2', [principal.userId, scope.commandId])).rows[0];
    if (previous) {
      if (previous.couple_id !== scope.coupleId || previous.membership_epoch !== scope.membershipEpoch
        || previous.title !== scope.title || previous.local_date !== scope.localDate || previous.timezone !== scope.timezone
        || previous.recurrence !== scope.recurrence || previous.leap_day_policy !== scope.leapDayPolicy) return fail('idempotency_conflict');
      const row = (await tx.query<Row>(`SELECT ${columns} FROM shared_dates WHERE couple_id=$1 AND membership_epoch=$2 AND id=$3`,
        [scope.coupleId, scope.membershipEpoch, previous.date_id])).rows[0];
      return row ? { ok: true, value: { date: date(row, trustedNow(db)), commandId: scope.commandId!, replay: true } } : fail('unavailable');
    }
    const now = trustedNow(db);
    const row = (await tx.query<Row>(`INSERT INTO shared_dates(couple_id,creator_id,membership_epoch,title,local_date,timezone,created_at,recurrence,leap_day_policy)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${columns}`,
      [scope.coupleId, principal.userId, scope.membershipEpoch, scope.title, scope.localDate, scope.timezone, now, scope.recurrence, scope.leapDayPolicy])).rows[0];
    await tx.query(`INSERT INTO shared_date_commands(actor_user_id,command_id,couple_id,membership_epoch,date_id,title,local_date,timezone,recurrence,leap_day_policy)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [principal.userId, scope.commandId, scope.coupleId, scope.membershipEpoch,
      row.id, scope.title, scope.localDate, scope.timezone, scope.recurrence, scope.leapDayPolicy]);
    return { ok: true, value: { date: date(row, trustedNow(db)), commandId: scope.commandId!, replay: false } };
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
    const now = trustedNow(db);
    return { ok: true, value: { dates: rows.rows.map(row => date(row, now)), limit: 50 } };
  });
}
