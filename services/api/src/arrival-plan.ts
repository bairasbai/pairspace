import { lockPair } from './pair-close.ts';
import type { AuthorizedDatabase, Principal, SqlExecutor } from './contracts.ts';
import { activeSession, validPrincipal } from './session.ts';
import { isEpoch, isUuid } from './validation.ts';
import { parseArrivalFields, type ArrivalFields } from '../../../packages/domain/arrival/plan.ts';
export type ArrivalPlan = ArrivalFields & Readonly<{ id: string; coupleId: string; creatorId: string;
  membershipEpoch: number; createdAt: string; version: number }>;
type Scope = { coupleId: string; membershipEpoch: number };
type Command = Scope & ArrivalFields & { commandId: string; expectedVersion: number };
type Failure = { ok: false; error: 'invalid_request' | 'unavailable' | 'stale_membership' | 'version_conflict' | 'idempotency_conflict' };
type Result<T> = { ok: true; value: T } | Failure;
type Row = { id: string; couple_id: string; creator_id: string; membership_epoch: number;
  label: string; local_date: string; local_time: string; timezone: string; utc_offset: string;
  arrives_at: string; created_at: string; version: number };
type Receipt = { couple_id: string; membership_epoch: number; expected_version: number;
  label: string; local_date: string; local_time: string; timezone: string; utc_offset: string };
const columns = 'id,couple_id,creator_id,membership_epoch,label,local_date,local_time,timezone,utc_offset,arrives_at::text,created_at::text,version';
const fail = (error: Failure['error']): Failure => ({ ok: false, error });
function parse(input: unknown, save: boolean): Scope | Command | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const f = input as Record<string, unknown>;
  if (Object.keys(f).sort().join(',') !== (save
    ? 'commandId,coupleId,expectedVersion,label,localDate,localTime,membershipEpoch,offset,timezone'
    : 'coupleId,membershipEpoch') || !isUuid(f.coupleId) || !isEpoch(f.membershipEpoch)) return null;
  const scope = { coupleId: f.coupleId.toLowerCase(), membershipEpoch: f.membershipEpoch };
  if (!save) return scope;
  const fields = parseArrivalFields(f.label, f.localDate, f.localTime, f.timezone, f.offset);
  if (!fields || !isUuid(f.commandId) || !Number.isSafeInteger(f.expectedVersion)
    || (f.expectedVersion as number) < 0 || (f.expectedVersion as number) > 2147483646) return null;
  return { ...scope, ...fields, commandId: f.commandId.toLowerCase(), expectedVersion: f.expectedVersion as number };
}
function resource(row: Row): ArrivalPlan {
  return { id: row.id, coupleId: row.couple_id, creatorId: row.creator_id, membershipEpoch: row.membership_epoch,
    label: row.label, localDate: row.local_date, localTime: row.local_time, timezone: row.timezone, offset: row.utc_offset,
    arrivesAt: new Date(row.arrives_at).toISOString(), createdAt: new Date(row.created_at).toISOString(), version: row.version };
}
function now(db: AuthorizedDatabase): string {
  const date = db.now();
  if (!Number.isFinite(date.getTime())) throw Error('invalid_server_clock');
  return date.toISOString();
}
async function authorize(tx: SqlExecutor, db: AuthorizedDatabase, p: Principal, scope: Scope): Promise<Failure | null> {
  const pair = await lockPair(tx, db, p, scope.coupleId);
  if (typeof pair === 'string') return fail('unavailable');
  const active = pair.members.filter(m => m.status === 'active');
  if (pair.status !== 'active' || active.length !== 2 || !active.some(m => m.user_id === p.userId)) return fail('unavailable');
  return pair.epoch === scope.membershipEpoch ? null : fail('stale_membership');
}
async function read(tx: SqlExecutor, scope: Scope): Promise<Row | undefined> {
  return (await tx.query<Row>(`SELECT ${columns} FROM arrival_plans WHERE couple_id=$1 AND membership_epoch=$2`,
    [scope.coupleId, scope.membershipEpoch])).rows[0];
}
export async function getArrivalPlan(db: AuthorizedDatabase, p: Principal, input: unknown): Promise<Result<{ plan: ArrivalPlan | null; asOf: string }>> {
  if (!validPrincipal(p)) return fail('unavailable');
  const scope = parse(input, false);
  if (!scope) return fail('invalid_request');
  return db.transaction(async tx => {
    const denied = await authorize(tx, db, p, scope);
    if (denied) return denied;
    const row = await read(tx, scope);
    return { ok: true, value: { plan: row ? resource(row) : null, asOf: now(db) } };
  });
}
export async function saveArrivalPlan(db: AuthorizedDatabase, p: Principal, input: unknown): Promise<Result<{ plan: ArrivalPlan; asOf: string; commandId: string; replay: boolean }>> {
  if (!validPrincipal(p)) return fail('unavailable');
  const parsed = parse(input, true);
  if (!parsed) return fail('invalid_request');
  const c = parsed as Command;
  return db.transaction(async tx => {
    const denied = await authorize(tx, db, p, c);
    if (denied) return denied;
    // Lock existing resource before all protected reads, then repeat current authorization.
    await tx.query('SELECT id FROM arrival_plans WHERE couple_id=$1 AND membership_epoch=$2 FOR UPDATE', [c.coupleId, c.membershipEpoch]);
    if (!await activeSession(tx, db, p)) return fail('unavailable');
    const previous = (await tx.query<Receipt>('SELECT couple_id,membership_epoch,expected_version,label,local_date,local_time,timezone,utc_offset FROM arrival_plan_commands WHERE actor_user_id=$1 AND command_id=$2', [p.userId, c.commandId])).rows[0];
    const current = await read(tx, c);
    if (previous) {
      if (previous.couple_id !== c.coupleId || previous.membership_epoch !== c.membershipEpoch
        || previous.expected_version !== c.expectedVersion || previous.label !== c.label || previous.local_date !== c.localDate
        || previous.local_time !== c.localTime || previous.timezone !== c.timezone || previous.utc_offset !== c.offset) return fail('idempotency_conflict');
      return current ? { ok: true, value: { plan: resource(current), asOf: now(db), commandId: c.commandId, replay: true } } : fail('unavailable');
    }
    if ((current?.version ?? 0) !== c.expectedVersion) return fail('version_conflict');
    const unchanged = current && current.label === c.label && current.local_date === c.localDate
      && current.local_time === c.localTime && current.timezone === c.timezone && current.utc_offset === c.offset;
    const args = [c.coupleId, c.membershipEpoch, c.label, c.localDate, c.localTime, c.timezone, c.offset, c.arrivesAt];
    const row = unchanged ? current : current
      ? (await tx.query<Row>(`UPDATE arrival_plans SET label=$3,local_date=$4,local_time=$5,timezone=$6,utc_offset=$7,arrives_at=$8,version=version+1 WHERE couple_id=$1 AND membership_epoch=$2 RETURNING ${columns}`, args)).rows[0]
      : (await tx.query<Row>(`INSERT INTO arrival_plans(couple_id,membership_epoch,label,local_date,local_time,timezone,utc_offset,arrives_at,creator_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${columns}`, [...args, p.userId, now(db)])).rows[0];
    await tx.query('INSERT INTO arrival_plan_commands(actor_user_id,command_id,couple_id,membership_epoch,plan_id,expected_version,label,local_date,local_time,timezone,utc_offset) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [p.userId, c.commandId, c.coupleId, c.membershipEpoch, row.id, c.expectedVersion, c.label, c.localDate, c.localTime, c.timezone, c.offset]);
    return { ok: true, value: { plan: resource(row), asOf: now(db), commandId: c.commandId, replay: false } };
  });
}
