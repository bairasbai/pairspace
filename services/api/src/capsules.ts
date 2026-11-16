import { createHash } from 'node:crypto';
import { followsCapsule, mayReadCapsule, normalizeCapsuleBody, parseCapsuleSchedule,
  removeCapsule as removePolicy, resealCapsule as resealPolicy, validCapsule,
  type Capsule, type CapsuleSchedule, type CapsuleScope } from '../../../packages/domain/capsules/policy.ts';
import type { AuthorizedDatabase, Principal, SqlExecutor } from './contracts.ts';
import { lockPair } from './pair-close.ts';
import { activeSession, validPrincipal } from './session.ts';
import { isEpoch, isUuid } from './validation.ts';

export type CapsuleClock = () => Date;
type Code = 'invalid_request' | 'unavailable' | 'stale_membership' | 'idempotency_conflict' | 'version_conflict' | 'capacity_reached' | 'not_due';
type Failure = { ok: false; error: Code };
type Result<T> = { ok: true; value: T } | Failure;
type Mode = 'list' | 'read' | 'create' | 'reseal' | 'remove';
type Mutation = Exclude<Mode, 'list' | 'read'>;
type Schedule = Omit<CapsuleSchedule, 'releaseAt'>;
type Scope = { coupleId: string; membershipEpoch: number; capsuleId?: string; commandId?: string;
  expectedVersion?: number; text?: string; schedule?: Schedule };
type Row = { id: string; couple_id: string; author_id: string; membership_epoch: number;
  version: number; created_at: string; sealed_at: string; release_at: string; timezone: string; local_date: string; local_time: string;
  utc_offset: string; content_state: Capsule['contentState'] };
type Receipt = { fingerprint: string; capsule_id: string; operation: Mutation; applied: unknown };
type Ack = { capsule: Capsule; commandId: string; replay: boolean; checkedAt: string };
const columns = 'id,couple_id,author_id,membership_epoch,version,created_at::text,sealed_at::text,release_at::text,timezone,local_date::text,local_time,utc_offset,content_state';
const fail = (error: Code): Failure => ({ ok: false, error });
const ended = new Error('capsule_session_or_clock_ended');
const now = (db: AuthorizedDatabase, clock?: CapsuleClock): string => {
  const value = (clock ?? (() => db.now()))();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw Error('invalid_capsule_clock');
  return value.toISOString();
};
const actorScope = (scope: Scope, p: Principal): CapsuleScope => ({ coupleId: scope.coupleId, membershipEpoch: scope.membershipEpoch, userId: p.userId });
function metadata(row: Row, scope: CapsuleScope): Capsule {
  const value = { id: row.id, coupleId: row.couple_id, authorId: row.author_id,
    membershipEpoch: row.membership_epoch, version: row.version, createdAt: new Date(row.created_at).toISOString(),
    sealedAt: new Date(row.sealed_at).toISOString(), releaseAt: new Date(row.release_at).toISOString(),
    timezone: row.timezone, localDate: row.local_date, localTime: row.local_time, offset: row.utc_offset, contentState: row.content_state };
  if (!validCapsule(value, scope)) throw Error('invalid_capsule_record');
  return value;
}
function parse(input: unknown, mode: Mode): Scope | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const f = input as Record<string, unknown>, reading = mode === 'list' || mode === 'read', creating = mode === 'create';
  const writingBody = creating || mode === 'reseal';
  const keys = ['coupleId', 'membershipEpoch', ...(mode !== 'list' && !creating ? ['capsuleId'] : []),
    ...(!reading ? ['commandId', 'confirm'] : []), ...(!reading && !creating ? ['expectedVersion'] : []), ...(writingBody ? ['text', 'schedule'] : [])];
  if (Object.keys(f).sort().join() !== keys.sort().join() || !isUuid(f.coupleId) || !isEpoch(f.membershipEpoch)) return null;
  const scope: Scope = { coupleId: f.coupleId.toLowerCase(), membershipEpoch: f.membershipEpoch };
  if (mode !== 'list' && !creating) {
    if (!isUuid(f.capsuleId)) return null;
    scope.capsuleId = f.capsuleId.toLowerCase();
  }
  if (!reading) {
    if (!isUuid(f.commandId) || f.confirm !== true) return null;
    scope.commandId = f.commandId.toLowerCase();
    if (!creating) {
      if (!Number.isInteger(f.expectedVersion) || Number(f.expectedVersion) < 1 || Number(f.expectedVersion) > 2147483645) return null;
      scope.expectedVersion = Number(f.expectedVersion);
    }
  }
  if (writingBody) {
    const text = normalizeCapsuleBody(f.text);
    // A previously successful command must remain replayable after its date passes.
    const schedule = parseCapsuleSchedule(f.schedule, '1999-12-30T00:00:00.000Z');
    if (text === null || schedule === null) return null;
    scope.text = text;
    scope.schedule = { localDate: schedule.localDate, localTime: schedule.localTime, timezone: schedule.timezone, offset: schedule.offset };
  }
  return scope;
}
async function authorize(tx: SqlExecutor, db: AuthorizedDatabase, p: Principal, scope: Scope): Promise<Failure | { ok: true }> {
  const pair = await lockPair(tx, db, p, scope.coupleId);
  if (typeof pair === 'string') return fail('unavailable');
  const members = pair.members.filter(member => member.status === 'active');
  if (pair.status !== 'active' || members.length !== 2 || !members.some(member => member.user_id === p.userId)) return fail('unavailable');
  return pair.epoch !== scope.membershipEpoch ? fail('stale_membership') : { ok: true };
}
// Author predicate is part of SQL, not a post-query JavaScript filter.
const select = async (tx: SqlExecutor, scope: Scope, p: Principal, id: string) =>
  (await tx.query<Row>(`SELECT ${columns} FROM capsules WHERE couple_id=$1 AND membership_epoch=$2 AND author_id=$3 AND id=$4 FOR UPDATE`,
    [scope.coupleId, scope.membershipEpoch, p.userId, id])).rows[0];
export async function listCapsules(db: AuthorizedDatabase, p: Principal, input: unknown, clock?: CapsuleClock): Promise<Result<{ capsules: Capsule[]; checkedAt: string; capacity: 1; used: number }>> {
  if (!validPrincipal(p)) return fail('unavailable');
  const scope = parse(input, 'list');
  if (!scope) return fail('invalid_request');
  return db.transaction(async tx => {
    const auth = await authorize(tx, db, p, scope);
    if (!auth.ok) return auth;
    const rows = (await tx.query<Row>(`SELECT ${columns} FROM capsules WHERE couple_id=$1 AND membership_epoch=$2 AND author_id=$3 LIMIT 2`,
      [scope.coupleId, scope.membershipEpoch, p.userId])).rows;
    if (!await activeSession(tx, db, p)) return fail('unavailable');
    if (rows.length > 1) throw Error('invalid_capsule_capacity');
    const capsules = rows.map(row => metadata(row, actorScope(scope, p))), checkedAt = now(db, clock);
    if (capsules.some(value => checkedAt < value.sealedAt)) return fail('unavailable');
    return { ok: true, value: { capsules, checkedAt, capacity: 1, used: rows.length } };
  });
}
export async function readCapsule(db: AuthorizedDatabase, p: Principal, input: unknown, clock?: CapsuleClock): Promise<Result<{ capsule: Capsule; checkedAt: string; text?: string }>> {
  if (!validPrincipal(p)) return fail('unavailable');
  const scope = parse(input, 'read');
  if (!scope) return fail('invalid_request');
  return db.transaction(async tx => {
    const auth = await authorize(tx, db, p, scope);
    if (!auth.ok) return auth;
    const row = await select(tx, scope, p, scope.capsuleId!);
    if (!row || !await activeSession(tx, db, p)) return fail('unavailable');
    const actor = actorScope(scope, p), capsule = metadata(row, actor);
    let text: string | undefined;
    if (mayReadCapsule(capsule, actor, now(db, clock))) {
      const result = await tx.query<{ body: unknown }>('SELECT body FROM capsules WHERE couple_id=$1 AND membership_epoch=$2 AND author_id=$3 AND id=$4',
        [scope.coupleId, scope.membershipEpoch, p.userId, capsule.id]);
      if (result.rows.length !== 1 || typeof result.rows[0].body !== 'string' || normalizeCapsuleBody(result.rows[0].body) !== result.rows[0].body) throw Error('invalid_capsule_body');
      text = result.rows[0].body;
    }
    if (!await activeSession(tx, db, p)) return fail('unavailable');
    const checkedAt = now(db, clock);
    if (checkedAt < capsule.sealedAt || (text !== undefined && !mayReadCapsule(capsule, actor, checkedAt))) return fail('unavailable');
    return { ok: true, value: { capsule, checkedAt, ...(text === undefined ? {} : { text }) } };
  });
}
export const createCapsule = (db: AuthorizedDatabase, p: Principal, input: unknown, clock?: CapsuleClock) => mutate(db, p, input, 'create', clock);
export const resealCapsule = (db: AuthorizedDatabase, p: Principal, input: unknown, clock?: CapsuleClock) => mutate(db, p, input, 'reseal', clock);
export const removeCapsule = (db: AuthorizedDatabase, p: Principal, input: unknown, clock?: CapsuleClock) => mutate(db, p, input, 'remove', clock);
function provesOperation(applied: Capsule, scope: Scope, mode: Mutation): boolean {
  if (mode !== 'create' && (applied.id !== scope.capsuleId || applied.version !== scope.expectedVersion! + 1)) return false;
  if (mode === 'remove') return applied.contentState === 'removed';
  return applied.contentState === 'active' && (mode !== 'create' || applied.version === 1)
    && Object.entries(scope.schedule!).every(([key, value]) => applied[key as keyof Capsule] === value);
}
async function mutate(db: AuthorizedDatabase, p: Principal, input: unknown, mode: Mutation, clock?: CapsuleClock): Promise<Result<Ack>> {
  if (!validPrincipal(p)) return fail('unavailable');
  const scope = parse(input, mode);
  if (!scope) return fail('invalid_request');
  const actor = actorScope(scope, p);
  const fingerprint = createHash('sha256').update(JSON.stringify([mode, scope.coupleId, scope.membershipEpoch,
    scope.capsuleId ?? null, scope.expectedVersion ?? null, true, scope.text ?? null, scope.schedule ?? null])).digest('hex');
  try {
    return await db.transaction(async tx => {
      const auth = await authorize(tx, db, p, scope);
      if (!auth.ok) return auth;
      const previous = (await tx.query<Receipt>('SELECT fingerprint,capsule_id,operation,applied FROM capsule_commands WHERE actor_user_id=$1 AND command_id=$2', [p.userId, scope.commandId])).rows[0];
      if (!await activeSession(tx, db, p)) return fail('unavailable');
      if (previous) {
        if (previous.fingerprint !== fingerprint) return fail('idempotency_conflict');
        const row = await select(tx, scope, p, previous.capsule_id);
        if (!row || !await activeSession(tx, db, p)) return fail('unavailable');
        const capsule = metadata(row, actor);
        if (previous.operation !== mode || !validCapsule(previous.applied, actor)
          || !provesOperation(previous.applied, scope, mode) || !followsCapsule(previous.applied, capsule, actor)) throw Error('invalid_capsule_replay');
        const checkedAt = now(db, clock);
        if (checkedAt < capsule.sealedAt) return fail('unavailable');
        return { ok: true, value: { capsule, commandId: scope.commandId!, replay: true, checkedAt } };
      }
      let rows: Row[], startedAt: string, oldReleaseAt: string | undefined;
      if (mode === 'create') {
        const used = Number((await tx.query<{ used: number }>('SELECT count(*)::int AS used FROM capsules WHERE couple_id=$1 AND membership_epoch=$2 AND author_id=$3',
          [scope.coupleId, scope.membershipEpoch, p.userId])).rows[0].used);
        if (!await activeSession(tx, db, p)) return fail('unavailable');
        if (used >= 1) return fail('capacity_reached');
        startedAt = now(db, clock);
        const schedule = parseCapsuleSchedule(scope.schedule, startedAt);
        if (!schedule) return fail('invalid_request');
        rows = (await tx.query<Row>(`INSERT INTO capsules(couple_id,author_id,membership_epoch,version,created_at,sealed_at,release_at,timezone,local_date,local_time,utc_offset,content_state,body)
          VALUES($1,$2,$3,1,$4,$4,$5,$6,$7,$8,$9,'active',$10) RETURNING ${columns}`,
        [scope.coupleId, p.userId, scope.membershipEpoch, startedAt,
          schedule.releaseAt, schedule.timezone, schedule.localDate, schedule.localTime, schedule.offset, scope.text])).rows;
      } else {
        const row = await select(tx, scope, p, scope.capsuleId!);
        if (!row || !await activeSession(tx, db, p)) return fail('unavailable');
        const value = metadata(row, actor);
        if (value.version !== scope.expectedVersion || value.contentState !== 'active') return fail('version_conflict');
        startedAt = now(db, clock);
        if (startedAt < value.sealedAt) return fail('unavailable');
        oldReleaseAt = value.releaseAt;
        const next = mode === 'reseal' ? resealPolicy(value, actor, startedAt, scope.expectedVersion!, scope.schedule, true)
          : removePolicy(value, actor, startedAt, scope.expectedVersion!, true);
        if (!next) return fail('version_conflict');
        rows = (await tx.query<Row>(`UPDATE capsules SET content_state=$2,sealed_at=$3,release_at=$4,timezone=$5,local_date=$6,local_time=$7,utc_offset=$8,
          body=$9,version=version+1 WHERE id=$1 AND author_id=$10 RETURNING ${columns}`,
        [value.id, next.contentState, next.sealedAt, next.releaseAt, next.timezone, next.localDate, next.localTime, next.offset,
          mode === 'remove' ? null : scope.text, p.userId])).rows;
      }
      if (rows.length !== 1) throw Error('invalid_capsule_write');
      const capsule = metadata(rows[0], actor);
      if (!provesOperation(capsule, scope, mode)) throw Error('invalid_capsule_applied_state');
      const receipt = await tx.query<Receipt>(`INSERT INTO capsule_commands(actor_user_id,command_id,couple_id,membership_epoch,capsule_id,fingerprint,operation,expected_version,applied)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING fingerprint,capsule_id,operation,applied`,
      [p.userId, scope.commandId, scope.coupleId, scope.membershipEpoch, capsule.id, fingerprint, mode, scope.expectedVersion ?? null, JSON.stringify(capsule)]);
      if (receipt.rows.length !== 1 || receipt.rows[0].fingerprint !== fingerprint || receipt.rows[0].capsule_id !== capsule.id
        || receipt.rows[0].operation !== mode || !followsCapsule(capsule, receipt.rows[0].applied, actor)
        || !followsCapsule(receipt.rows[0].applied, capsule, actor)) throw Error('invalid_capsule_receipt');
      // Throw after writes so the transaction rolls back record AND receipt on late expiry.
      if (!await activeSession(tx, db, p)) throw ended;
      const checkedAt = now(db, clock);
      if (checkedAt < startedAt || (mode !== 'remove' && !parseCapsuleSchedule(scope.schedule, checkedAt))
        || (mode === 'reseal' && checkedAt >= oldReleaseAt!)) throw ended;
      return { ok: true, value: { capsule, commandId: scope.commandId!, replay: false, checkedAt } };
    });
  } catch (error) { if (error === ended) return fail('unavailable'); throw error; }
}
