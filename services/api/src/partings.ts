import { lockPair } from './pair-close.ts';
import type { AuthorizedDatabase, Principal, SqlExecutor } from './contracts.ts';
import { activeSession, validPrincipal } from './session.ts';
import { isEpoch, isUuid } from './validation.ts';
import { normalizeTaskTitle } from '../../../packages/domain/tasks/title.ts';
import { partingRange } from '../../../packages/domain/partings/range.ts';

export type Parting = Readonly<{ id: string; coupleId: string; creatorId: string; membershipEpoch: number;
 title: string; startDate: string; endDate: string; timezone: string; startsAt: string; endsAt: string; createdAt: string; version: number }>;
type Failure = { ok: false; error: 'invalid_request' | 'unavailable' | 'stale_membership' | 'idempotency_conflict' | 'version_conflict' | 'overlap' | 'capacity_limit' };
type Result<T> = { ok: true; value: T } | Failure;
type Scope = { partingId?: string; expectedVersion?: number; coupleId: string; membershipEpoch: number; commandId?: string; title?: string; startDate?: string; endDate?: string; timezone?: string; startsAt?: string; endsAt?: string };
type Row = { id: string; couple_id: string; creator_id: string; membership_epoch: number; title: string; start_date: string; end_date: string; timezone: string; starts_at: string; ends_at: string; created_at: string; version: number };
type Receipt = { operation: string; expected_version: number | null; couple_id: string; membership_epoch: number; parting_id: string; title: string; start_date: string; end_date: string; timezone: string };
type Mutation = { parting: Parting; commandId: string; replay: boolean; asOf: string };
const columns = 'id,couple_id,creator_id,membership_epoch,title,start_date,end_date,timezone,starts_at::text,ends_at::text,created_at::text,version';
function parting(r: Row): Parting { return { id:r.id,coupleId:r.couple_id,creatorId:r.creator_id,membershipEpoch:r.membership_epoch,title:r.title,startDate:r.start_date,endDate:r.end_date,timezone:r.timezone,startsAt:new Date(r.starts_at).toISOString(),endsAt:new Date(r.ends_at).toISOString(),createdAt:new Date(r.created_at).toISOString(),version:r.version }; }
function trustedNow(db: AuthorizedDatabase): Date {
  const now = db.now();
  if (!Number.isFinite(now.getTime())) throw new Error('invalid_server_clock');
  return now;
}
const fail = (error: Failure['error']): Failure => ({ ok: false, error });
function parse(input: unknown, mode: 'create' | 'edit' | 'list'): Scope | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const f = input as Record<string, unknown>;
  const keys = mode === 'list' ? 'coupleId,membershipEpoch' : mode === 'edit' ? 'commandId,coupleId,endDate,expectedVersion,membershipEpoch,partingId,startDate,timezone,title' : 'commandId,coupleId,endDate,membershipEpoch,startDate,timezone,title';
  if (Object.keys(f).sort().join(',') !== keys || !isUuid(f.coupleId) || !isEpoch(f.membershipEpoch)) return null;
  const scope: Scope = { coupleId:f.coupleId.toLowerCase(),membershipEpoch:f.membershipEpoch };
  if (mode === 'list') return scope;
  if (mode === 'edit') {
    if (!isUuid(f.partingId) || !Number.isSafeInteger(f.expectedVersion) || (f.expectedVersion as number)<1 || (f.expectedVersion as number)>2147483646) return null;
    scope.partingId=f.partingId.toLowerCase(); scope.expectedVersion=f.expectedVersion as number;
  }
  const title=normalizeTaskTitle(f.title), range=partingRange(f.startDate,f.endDate,f.timezone);
  if (!isUuid(f.commandId) || !title.ok || !range) return null;
  return {...scope,commandId:f.commandId.toLowerCase(),title:title.text,startDate:f.startDate as string,endDate:f.endDate as string,timezone:f.timezone as string,...range};
}

async function authorize(tx: SqlExecutor, db: AuthorizedDatabase, principal: Principal, scope: Scope): Promise<Failure | null> {
  // Reuse closure lock order: historical users UPDATE → session → pair → fresh session.
  const pair = await lockPair(tx, db, principal, scope.coupleId);
  if (typeof pair === 'string') return fail('unavailable');
  const active = pair.members.filter(row => row.status === 'active');
  if (pair.status !== 'active' || active.length !== 2 || !active.some(row => row.user_id === principal.userId)) return fail('unavailable');
  return pair.epoch === scope.membershipEpoch ? null : fail('stale_membership');
}
export const createParting = (db: AuthorizedDatabase, principal: Principal, input: unknown) => mutateParting(db, principal, input, 'create');
export const editParting = (db: AuthorizedDatabase, principal: Principal, input: unknown) => mutateParting(db, principal, input, 'edit');
async function mutateParting(db: AuthorizedDatabase, principal: Principal, input: unknown, mode: 'create' | 'edit'): Promise<Result<Mutation>> {
  if (!validPrincipal(principal)) return fail('unavailable');
  const scope = parse(input, mode);
  if (!scope) return fail('invalid_request');
  return db.transaction(async tx => {
    const denied = await authorize(tx, db, principal, scope);
    if (denied) return denied;
    const zone = await tx.query<{ name: string }>('SELECT name FROM pg_timezone_names WHERE name=$1', [scope.timezone]);
    if (zone.rows.length !== 1) return fail('invalid_request');
    const previous = (await tx.query<Receipt>('SELECT operation,expected_version,couple_id,membership_epoch,parting_id,title,start_date,end_date,timezone FROM parting_commands WHERE actor_user_id=$1 AND command_id=$2', [principal.userId, scope.commandId])).rows[0];
    if (previous) {
      if (previous.operation !== mode || previous.expected_version !== (scope.expectedVersion ?? null)
        || (mode === 'edit' && previous.parting_id !== scope.partingId) || previous.couple_id !== scope.coupleId || previous.membership_epoch !== scope.membershipEpoch
        || previous.title !== scope.title || previous.start_date !== scope.startDate || previous.timezone !== scope.timezone
        || previous.end_date !== scope.endDate) return fail('idempotency_conflict');
      const row = (await tx.query<Row>(`SELECT ${columns} FROM partings WHERE couple_id=$1 AND membership_epoch=$2 AND id=$3`,
        [scope.coupleId, scope.membershipEpoch, previous.parting_id])).rows[0];
      return row ? { ok: true, value: { parting: parting(row), commandId: scope.commandId!, replay: true, asOf:trustedNow(db).toISOString() } } : fail('unavailable');
    }
    const now = trustedNow(db);
    let current: Row | undefined;
    if (mode==='edit') {
      await tx.query('SELECT id FROM partings WHERE couple_id=$1 AND membership_epoch=$2 AND id=$3 FOR UPDATE',[scope.coupleId,scope.membershipEpoch,scope.partingId]);
      if (!await activeSession(tx,db,principal)) return fail('unavailable');
      const existing=(await tx.query<Row>(`SELECT ${columns} FROM partings WHERE couple_id=$1 AND membership_epoch=$2 AND id=$3`,[scope.coupleId,scope.membershipEpoch,scope.partingId])).rows[0];
      if (!existing) return fail('unavailable');
      current=existing;
      if (existing.version!==scope.expectedVersion) return fail('version_conflict');
    }
    const existing=(await tx.query<Row>(`SELECT ${columns} FROM partings WHERE couple_id=$1 AND membership_epoch=$2`,[scope.coupleId,scope.membershipEpoch])).rows;
    if (mode==='create' && existing.length>=100) return fail('capacity_limit');
    if (existing.some(r=>r.id!==scope.partingId && ((r.start_date<=scope.endDate! && r.end_date>=scope.startDate!) || (Date.parse(r.starts_at)<Date.parse(scope.endsAt!) && Date.parse(r.ends_at)>Date.parse(scope.startsAt!))))) return fail('overlap');
    const args=[scope.coupleId,scope.membershipEpoch,scope.title,scope.startDate,scope.endDate,scope.timezone,scope.startsAt,scope.endsAt];
    const unchanged=current && current.title===scope.title && current.start_date===scope.startDate && current.end_date===scope.endDate && current.timezone===scope.timezone;
    const row=unchanged ? current! : (mode==='edit' ? await tx.query<Row>(`UPDATE partings SET title=$3,start_date=$4,end_date=$5,timezone=$6,starts_at=$7,ends_at=$8,version=version+1 WHERE couple_id=$1 AND membership_epoch=$2 AND id=$9 RETURNING ${columns}`,[...args,scope.partingId])
      : await tx.query<Row>(`INSERT INTO partings(couple_id,membership_epoch,title,start_date,end_date,timezone,starts_at,ends_at,creator_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${columns}`,[...args,principal.userId,now])).rows[0];
    await tx.query(`INSERT INTO parting_commands(actor_user_id,command_id,couple_id,membership_epoch,parting_id,title,start_date,end_date,timezone,operation,expected_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[principal.userId,scope.commandId,scope.coupleId,scope.membershipEpoch,row.id,scope.title,scope.startDate,scope.endDate,scope.timezone,mode,scope.expectedVersion??null]);
    return {ok:true,value:{parting:parting(row),commandId:scope.commandId!,replay:false,asOf:trustedNow(db).toISOString()}};

  });
}
export async function listPartings(db: AuthorizedDatabase, principal: Principal, input: unknown): Promise<Result<{ partings: Parting[]; limit: 100; asOf: string }>> {
  if (!validPrincipal(principal)) return fail('unavailable');
  const scope = parse(input, 'list');
  if (!scope) return fail('invalid_request');
  return db.transaction(async tx => {
    const denied = await authorize(tx, db, principal, scope);
    if (denied) return denied;
    const rows = await tx.query<Row>(`SELECT ${columns} FROM partings WHERE couple_id=$1 AND membership_epoch=$2
      ORDER BY starts_at ASC,id ASC`, [scope.coupleId, scope.membershipEpoch]);
    const now = trustedNow(db);
    return { ok: true, value: { partings: rows.rows.map(parting), limit: 100, asOf:now.toISOString() } };
  });
}
