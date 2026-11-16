import { createHash } from 'node:crypto';
import { joinDisputeMetadata as joinPolicy, declineDisputeMetadata as declinePolicy,
  resolveDisputeMetadata as resolvePolicy, removeDisputeMetadata as removePolicy,
  validDisputeMetadata, followsDisputeMetadata, canReadDisputeMetadata, latestDisputeEvent,
  type DisputeMetadata as Dispute, type DisputeScope } from '../../../packages/domain/disputes/metadata.ts';
import { normalizeDisputeClaim, normalizeDisputeCondition, parseDisputeSchedule, localDay } from '../../../packages/domain/disputes/validation.ts';
import type { AuthorizedDatabase, Principal, SqlExecutor } from './contracts.ts';
import { lockPair } from './pair-close.ts';
import { activeSession, validPrincipal } from './session.ts';
import { isEpoch, isUuid } from './validation.ts';

export type DisputeClock = () => Date;
type Code = 'invalid_request' | 'unavailable' | 'stale_membership' | 'idempotency_conflict' | 'version_conflict' | 'capacity_reached' | 'not_due';
type Failure = { ok: false; error: Code };
type Result<T> = { ok: true; value: T } | Failure;
type Mode = 'list' | 'read' | 'create' | 'join' | 'decline' | 'resolve' | 'remove';
type Mutation = Exclude<Mode, 'list' | 'read'>;
type Schedule = { judgeDate: string; timezone: string };
type Scope = { coupleId: string; membershipEpoch: number; disputeId?: string; commandId?: string;
  expectedVersion?: number; claim?: string; condition?: string | null; schedule?: Schedule; winnerId?: string | null };
type Row = { id: string; couple_id: string; author_id: string; recipient_id: string; membership_epoch: number;
  version: number; created_at: string; judge_date: string; timezone: string; content_state: Dispute['contentState'];
  joined_at: string | null; declined_at: string | null; resolved_at: string | null; removed_at: string | null;
  resolved_by: string | null; winner_id: string | null };
type Receipt = { fingerprint: string; dispute_id: string; operation: Mutation; applied: unknown };
type Ack = { dispute: Dispute; commandId: string; replay: boolean; checkedAt: string };
const columns = 'id,couple_id,author_id,recipient_id,membership_epoch,version,created_at::text,judge_date::text,timezone,content_state,joined_at::text,declined_at::text,resolved_at::text,removed_at::text,resolved_by,winner_id';
const fail = (error: Code): Failure => ({ ok: false, error });
const ended = new Error('dispute_session_or_clock_ended');
const now = (db: AuthorizedDatabase, clock?: DisputeClock): string => {
  const value = (clock ?? (() => db.now()))();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw Error('invalid_dispute_clock');
  return value.toISOString();
};
const actorScope = (scope: Scope, p: Principal): DisputeScope => ({ coupleId: scope.coupleId, membershipEpoch: scope.membershipEpoch, userId: p.userId });
function metadata(row: Row, scope: DisputeScope): Dispute {
  const timestamp = (value: string | null) => value === null ? null : new Date(value).toISOString();
  const value = { id: row.id, coupleId: row.couple_id, authorId: row.author_id, recipientId: row.recipient_id,
    membershipEpoch: row.membership_epoch, version: row.version, createdAt: new Date(row.created_at).toISOString(),
    judgeDate: row.judge_date, timezone: row.timezone, contentState: row.content_state,
    joinedAt: timestamp(row.joined_at), declinedAt: timestamp(row.declined_at), resolvedAt: timestamp(row.resolved_at),
    removedAt: timestamp(row.removed_at), resolvedBy: row.resolved_by, winnerId: row.winner_id,
    decisionState: row.resolved_at !== null ? 'resolved' : row.declined_at !== null ? 'declined' : row.joined_at !== null ? 'joined' : 'invited' };
  if (!validDisputeMetadata(value, scope)) throw Error('invalid_dispute_record');
  return value;
}
function parse(input: unknown, mode: Mode): Scope | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const f = input as Record<string, unknown>, reading = mode === 'list' || mode === 'read', creating = mode === 'create';
  const keys = ['coupleId', 'membershipEpoch', ...(mode !== 'list' && !creating ? ['disputeId'] : []),
    ...(!reading ? ['commandId', 'confirm'] : []), ...(!reading && !creating ? ['expectedVersion'] : []), ...(creating ? ['claim', 'condition', 'judgeDate', 'timezone'] : []), ...(mode === 'resolve' ? ['winnerId'] : [])];
  if (Object.keys(f).sort().join() !== keys.sort().join() || !isUuid(f.coupleId) || !isEpoch(f.membershipEpoch)) return null;
  const scope: Scope = { coupleId: f.coupleId.toLowerCase(), membershipEpoch: f.membershipEpoch };
  if (mode !== 'list' && !creating) {
    if (!isUuid(f.disputeId)) return null;
    scope.disputeId = f.disputeId.toLowerCase();
  }
  if (!reading) {
    if (!isUuid(f.commandId) || f.confirm !== true) return null;
    scope.commandId = f.commandId.toLowerCase();
    if (!creating) {
      if (!Number.isInteger(f.expectedVersion) || Number(f.expectedVersion) < 1 || Number(f.expectedVersion) > 3) return null;
      scope.expectedVersion = Number(f.expectedVersion);
    }
  }
  if (creating) {
    const claim = normalizeDisputeClaim(f.claim), condition = normalizeDisputeCondition(f.condition);
    // Parse/canonicalize independently of TODAY so original commands remain replayable.
    const schedule = parseDisputeSchedule({ judgeDate: f.judgeDate, timezone: f.timezone }, '1999-12-30T00:00:00.000Z');
    if (claim === null || condition === undefined || schedule === null) return null;
    scope.claim = claim; scope.condition = condition; scope.schedule = schedule;
  }
  if (mode === 'resolve') {
    if (f.winnerId !== null && !isUuid(f.winnerId)) return null;
    scope.winnerId = f.winnerId === null ? null : String(f.winnerId).toLowerCase();
  }
  return scope;
}
async function authorize(tx: SqlExecutor, db: AuthorizedDatabase, p: Principal, scope: Scope): Promise<Failure | { otherId: string }> {
  const pair = await lockPair(tx, db, p, scope.coupleId);
  if (typeof pair === 'string') return fail('unavailable');
  const members = pair.members.filter(member => member.status === 'active');
  if (pair.status !== 'active' || members.length !== 2 || !members.some(member => member.user_id === p.userId)) return fail('unavailable');
  return pair.epoch !== scope.membershipEpoch ? fail('stale_membership') : { otherId: members.find(member => member.user_id !== p.userId)!.user_id };
}
const select = async (tx: SqlExecutor, scope: Scope, id: string, p: Principal) =>
  (await tx.query<Row>(`SELECT ${columns} FROM disputes WHERE couple_id=$1 AND membership_epoch=$2 AND id=$3 AND (author_id=$4 OR recipient_id=$4) FOR UPDATE`, [scope.coupleId, scope.membershipEpoch, id, p.userId])).rows[0];
export async function listDisputes(db: AuthorizedDatabase, p: Principal, input: unknown, clock?: DisputeClock): Promise<Result<{ disputes: Dispute[]; checkedAt: string; capacity: 100; used: number }>> {
  if (!validPrincipal(p)) return fail('unavailable');
  const scope = parse(input, 'list');
  if (!scope) return fail('invalid_request');
  return db.transaction(async tx => {
    const auth = await authorize(tx, db, p, scope);
    if ('ok' in auth) return auth;
    const rows = (await tx.query<Row>(`SELECT ${columns} FROM disputes WHERE couple_id=$1 AND membership_epoch=$2 AND (author_id=$3 OR recipient_id=$3) ORDER BY sequence DESC LIMIT 101`, [scope.coupleId, scope.membershipEpoch, p.userId])).rows;
    if (rows.length > 100) throw Error('invalid_dispute_capacity');
    if (!await activeSession(tx, db, p)) return fail('unavailable');
    const disputes = rows.map(row => metadata(row, actorScope(scope, p))), checkedAt = now(db, clock);
    if (disputes.some(value => checkedAt < latestDisputeEvent(value))) return fail('unavailable');
    return { ok: true, value: { disputes, checkedAt, capacity: 100, used: rows.length } };
  });
}
export async function readDispute(db: AuthorizedDatabase, p: Principal, input: unknown, clock?: DisputeClock): Promise<Result<{ dispute: Dispute; checkedAt: string; claim?: string; condition?: string | null }>> {
  if (!validPrincipal(p)) return fail('unavailable');
  const scope = parse(input, 'read');
  if (!scope) return fail('invalid_request');
  return db.transaction(async tx => {
    const auth = await authorize(tx, db, p, scope);
    if ('ok' in auth) return auth;
    const row = await select(tx, scope, scope.disputeId!, p);
    if (!row || !await activeSession(tx, db, p)) return fail('unavailable');
    const actor = actorScope(scope, p), dispute = metadata(row, actor);
    const startedAt = now(db, clock);
    if (startedAt < latestDisputeEvent(dispute)) return fail('unavailable');
    let body: { claim: string; condition: string | null } | undefined;
    if (canReadDisputeMetadata(dispute, actor, startedAt)) {
      const result = await tx.query<{ claim: unknown; condition: unknown }>('SELECT claim,condition FROM disputes WHERE couple_id=$1 AND membership_epoch=$2 AND id=$3 AND (author_id=$4 OR recipient_id=$4)', [scope.coupleId, scope.membershipEpoch, dispute.id, p.userId]);
      const value = result.rows[0];
      if (result.rows.length !== 1 || typeof value.claim !== 'string' || normalizeDisputeClaim(value.claim) !== value.claim
        || (value.condition !== null && typeof value.condition !== 'string') || normalizeDisputeCondition(value.condition) !== value.condition) throw Error('invalid_dispute_body');
      body = { claim: value.claim, condition: value.condition };
    }
    if (!await activeSession(tx, db, p)) return fail('unavailable');
    const checkedAt = now(db, clock);
    if (checkedAt < startedAt || (body !== undefined && !canReadDisputeMetadata(dispute, actor, checkedAt))) return fail('unavailable');
    return { ok: true, value: { dispute, checkedAt, ...body } };
  });
}
export const createDispute = (db: AuthorizedDatabase, p: Principal, input: unknown, clock?: DisputeClock) => mutate(db, p, input, 'create', clock);
export const joinDispute = (db: AuthorizedDatabase, p: Principal, input: unknown, clock?: DisputeClock) => mutate(db, p, input, 'join', clock);
export const resolveDispute = (db: AuthorizedDatabase, p: Principal, input: unknown, clock?: DisputeClock) => mutate(db, p, input, 'resolve', clock);
export const declineDispute = (db: AuthorizedDatabase, p: Principal, input: unknown, clock?: DisputeClock) => mutate(db, p, input, 'decline', clock);
export const removeDispute = (db: AuthorizedDatabase, p: Principal, input: unknown, clock?: DisputeClock) => mutate(db, p, input, 'remove', clock);
function provesOperation(applied: Dispute, scope: Scope, p: Principal, mode: Mutation): boolean {
  if (mode === 'create') return applied.authorId === p.userId && applied.version === 1 && applied.contentState === 'active'
    && Object.entries(scope.schedule!).every(([key, value]) => applied[key as keyof Dispute] === value);
  if (applied.id !== scope.disputeId || applied.version !== scope.expectedVersion! + 1) return false;
  if (mode === 'remove') return applied.authorId === p.userId && applied.contentState === 'removed';
  if (applied.contentState !== 'active') return false;
  if (mode === 'resolve') return applied.decisionState === 'resolved' && applied.resolvedBy === p.userId && applied.winnerId === scope.winnerId;
  return applied.recipientId === p.userId && applied.decisionState === (mode === 'join' ? 'joined' : 'declined');
}
async function mutate(db: AuthorizedDatabase, p: Principal, input: unknown, mode: Mutation, clock?: DisputeClock): Promise<Result<Ack>> {
  if (!validPrincipal(p)) return fail('unavailable');
  const scope = parse(input, mode);
  if (!scope) return fail('invalid_request');
  const actor = actorScope(scope, p);
  const fingerprint = createHash('sha256').update(JSON.stringify([mode, scope.coupleId, scope.membershipEpoch,
    scope.disputeId ?? null, scope.expectedVersion ?? null, true, scope.claim ?? null, scope.condition ?? null, scope.schedule ?? null, scope.winnerId ?? null])).digest('hex');
  try {
    return await db.transaction(async tx => {
      const auth = await authorize(tx, db, p, scope);
      if ('ok' in auth) return auth;
      const previous = (await tx.query<Receipt>('SELECT fingerprint,dispute_id,operation,applied FROM dispute_commands WHERE actor_user_id=$1 AND command_id=$2', [p.userId, scope.commandId])).rows[0];
      if (!await activeSession(tx, db, p)) return fail('unavailable');
      if (previous) {
        if (previous.fingerprint !== fingerprint) return fail('idempotency_conflict');
        const row = await select(tx, scope, previous.dispute_id, p);
        if (!row || !await activeSession(tx, db, p)) return fail('unavailable');
        const dispute = metadata(row, actor);
        if (previous.operation !== mode || !validDisputeMetadata(previous.applied, actor)
          || !provesOperation(previous.applied, scope, p, mode) || !followsDisputeMetadata(previous.applied, dispute, actor)) throw Error('invalid_dispute_replay');
        if (!await activeSession(tx, db, p)) return fail('unavailable');
        const checkedAt = now(db, clock);
        if (checkedAt < latestDisputeEvent(dispute)) return fail('unavailable');
        return { ok: true, value: { dispute, commandId: scope.commandId!, replay: true, checkedAt } };
      }
      let rows: Row[], startedAt: string;
      if (mode === 'create') {
        const used = Number((await tx.query<{ used: number }>('SELECT count(*)::int AS used FROM disputes WHERE couple_id=$1 AND membership_epoch=$2', [scope.coupleId, scope.membershipEpoch])).rows[0].used);
        if (!await activeSession(tx, db, p)) return fail('unavailable');
        if (used >= 100) return fail('capacity_reached');
        startedAt = now(db, clock);
        const schedule = parseDisputeSchedule(scope.schedule, startedAt);
        if (!schedule) return fail('invalid_request');
        rows = (await tx.query<Row>(`INSERT INTO disputes(couple_id,author_id,recipient_id,membership_epoch,sequence,version,created_at,judge_date,timezone,content_state,claim,condition)
          VALUES($1,$2,$3,$4,$5,1,$6,$7,$8,'active',$9,$10) RETURNING ${columns}`,
        [scope.coupleId, p.userId, auth.otherId, scope.membershipEpoch, used + 1, startedAt,
          schedule.judgeDate, schedule.timezone, scope.claim, scope.condition])).rows;
      } else {
        const row = await select(tx, scope, scope.disputeId!, p);
        if (!row || !await activeSession(tx, db, p)) return fail('unavailable');
        const value = metadata(row, actor);
        if ((mode === 'remove' && value.authorId !== p.userId)
          || ((mode === 'join' || mode === 'decline') && value.recipientId !== p.userId)) return fail('unavailable');
        if (value.version !== scope.expectedVersion || value.contentState !== 'active') return fail('version_conflict');
        startedAt = now(db, clock);
        if (startedAt < latestDisputeEvent(value)) return fail('unavailable');
        if (mode === 'resolve' && value.decisionState === 'joined' && localDay(startedAt, value.timezone) < value.judgeDate) return fail('not_due');
        const next = mode === 'join' ? joinPolicy(value, actor, startedAt, scope.expectedVersion!, true)
          : mode === 'decline' ? declinePolicy(value, actor, startedAt, scope.expectedVersion!, true)
          : mode === 'resolve' ? resolvePolicy(value, actor, startedAt, scope.expectedVersion!, scope.winnerId, true)
          : removePolicy(value, actor, startedAt, scope.expectedVersion!, true);
        if (!next) return fail('version_conflict');
        rows = (await tx.query<Row>(`UPDATE disputes SET content_state=$2,joined_at=$3,declined_at=$4,resolved_at=$5,resolved_by=$6,winner_id=$7,removed_at=$8,
          claim=CASE WHEN $9::boolean THEN NULL ELSE claim END,condition=CASE WHEN $9::boolean THEN NULL ELSE condition END,
          version=version+1 WHERE id=$1 RETURNING ${columns}`,
        [value.id, next.contentState, next.joinedAt, next.declinedAt, next.resolvedAt, next.resolvedBy, next.winnerId, next.removedAt, mode === 'remove'])).rows;
      }
      if (rows.length !== 1) throw Error('invalid_dispute_write');
      const dispute = metadata(rows[0], actor);
      if (!provesOperation(dispute, scope, p, mode)) throw Error('invalid_dispute_applied_state');
      const receipt = await tx.query<Receipt>(`INSERT INTO dispute_commands(actor_user_id,command_id,couple_id,membership_epoch,dispute_id,fingerprint,operation,expected_version,applied)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING fingerprint,dispute_id,operation,applied`,
      [p.userId, scope.commandId, scope.coupleId, scope.membershipEpoch, dispute.id, fingerprint, mode, scope.expectedVersion ?? null, JSON.stringify(dispute)]);
      if (receipt.rows.length !== 1 || receipt.rows[0].fingerprint !== fingerprint || receipt.rows[0].dispute_id !== dispute.id
        || receipt.rows[0].operation !== mode || !followsDisputeMetadata(dispute, receipt.rows[0].applied, actor)
        || !followsDisputeMetadata(receipt.rows[0].applied, dispute, actor)) throw Error('invalid_dispute_receipt');
      // Any late refusal after writes MUST throw, not return: transaction() commits returned failures.
      if (!await activeSession(tx, db, p)) throw ended;
      const checkedAt = now(db, clock);
      if (checkedAt < startedAt || (mode === 'create' && !parseDisputeSchedule(scope.schedule, checkedAt))
        || (mode === 'join' && localDay(checkedAt, dispute.timezone) >= dispute.judgeDate)
        || (mode === 'resolve' && localDay(checkedAt, dispute.timezone) < dispute.judgeDate)) throw ended;
      return { ok: true, value: { dispute, commandId: scope.commandId!, replay: false, checkedAt } };
    });
  } catch (error) { if (error === ended) return fail('unavailable'); throw error; }
}
