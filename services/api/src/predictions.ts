import { createHash } from 'node:crypto';
import { acknowledgePrediction, declinePrediction as declinePolicy, followsPrediction, mayReadPrediction,
  normalizePredictionBody, parsePredictionSchedule, removePrediction as removePolicy, validPrediction,
  type Prediction, type PredictionSchedule, type PredictionScope } from '../../../packages/domain/predictions/policy.ts';
import type { AuthorizedDatabase, Principal, SqlExecutor } from './contracts.ts';
import { lockPair } from './pair-close.ts';
import { activeSession, validPrincipal } from './session.ts';
import { isEpoch, isUuid } from './validation.ts';

export type PredictionClock = () => Date;
type Code = 'invalid_request' | 'unavailable' | 'stale_membership' | 'idempotency_conflict' | 'version_conflict' | 'capacity_reached' | 'not_due';
type Failure = { ok: false; error: Code };
type Result<T> = { ok: true; value: T } | Failure;
type Mode = 'list' | 'read' | 'create' | 'open' | 'decline' | 'remove';
type Mutation = Exclude<Mode, 'list' | 'read'>;
type Schedule = Omit<PredictionSchedule, 'releaseAt'>;
type Scope = { coupleId: string; membershipEpoch: number; predictionId?: string; commandId?: string;
  expectedVersion?: number; text?: string; schedule?: Schedule };
type Row = { id: string; couple_id: string; author_id: string; recipient_id: string; membership_epoch: number;
  version: number; created_at: string; release_at: string; timezone: string; local_date: string; local_time: string;
  utc_offset: string; content_state: Prediction['contentState']; opened_at: string | null; declined_at: string | null };
type Receipt = { fingerprint: string; prediction_id: string; operation: Mutation; applied: unknown };
type Ack = { prediction: Prediction; commandId: string; replay: boolean; checkedAt: string };
const columns = 'id,couple_id,author_id,recipient_id,membership_epoch,version,created_at::text,release_at::text,timezone,local_date::text,local_time,utc_offset,content_state,opened_at::text,declined_at::text';
const fail = (error: Code): Failure => ({ ok: false, error });
const ended = new Error('prediction_session_or_clock_ended');
const now = (db: AuthorizedDatabase, clock?: PredictionClock): string => {
  const value = (clock ?? (() => db.now()))();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw Error('invalid_prediction_clock');
  return value.toISOString();
};
const actorScope = (scope: Scope, p: Principal): PredictionScope => ({ coupleId: scope.coupleId, membershipEpoch: scope.membershipEpoch, userId: p.userId });
function metadata(row: Row, scope: PredictionScope): Prediction {
  const value = { id: row.id, coupleId: row.couple_id, authorId: row.author_id, recipientId: row.recipient_id,
    membershipEpoch: row.membership_epoch, version: row.version, createdAt: new Date(row.created_at).toISOString(),
    releaseAt: new Date(row.release_at).toISOString(), timezone: row.timezone, localDate: row.local_date,
    localTime: row.local_time, offset: row.utc_offset, contentState: row.content_state,
    openedAt: row.opened_at === null ? null : new Date(row.opened_at).toISOString(),
    declinedAt: row.declined_at === null ? null : new Date(row.declined_at).toISOString() };
  if (!validPrediction(value, scope)) throw Error('invalid_prediction_record');
  return value;
}
function parse(input: unknown, mode: Mode): Scope | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const f = input as Record<string, unknown>, reading = mode === 'list' || mode === 'read', creating = mode === 'create';
  const keys = ['coupleId', 'membershipEpoch', ...(mode !== 'list' && !creating ? ['predictionId'] : []),
    ...(!reading ? ['commandId', 'confirm'] : []), ...(!reading && !creating ? ['expectedVersion'] : []), ...(creating ? ['text', 'schedule'] : [])];
  if (Object.keys(f).sort().join() !== keys.sort().join() || !isUuid(f.coupleId) || !isEpoch(f.membershipEpoch)) return null;
  const scope: Scope = { coupleId: f.coupleId.toLowerCase(), membershipEpoch: f.membershipEpoch };
  if (mode !== 'list' && !creating) {
    if (!isUuid(f.predictionId)) return null;
    scope.predictionId = f.predictionId.toLowerCase();
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
    const text = normalizePredictionBody(f.text);
    // Validate/canonicalize without applying TODAY yet: replay of an old create must survive its due date.
    // The domain calendar range is 2000..2100, so this trusted fixed anchor precedes every permitted date.
    const schedule = parsePredictionSchedule(f.schedule, '1999-12-30T00:00:00.000Z');
    if (text === null || schedule === null) return null;
    scope.text = text;
    scope.schedule = { localDate: schedule.localDate, localTime: schedule.localTime, timezone: schedule.timezone, offset: schedule.offset };
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
const select = async (tx: SqlExecutor, scope: Scope, id: string) =>
  (await tx.query<Row>(`SELECT ${columns} FROM predictions WHERE couple_id=$1 AND membership_epoch=$2 AND id=$3 FOR UPDATE`, [scope.coupleId, scope.membershipEpoch, id])).rows[0];
export async function listPredictions(db: AuthorizedDatabase, p: Principal, input: unknown, clock?: PredictionClock): Promise<Result<{ predictions: Prediction[]; checkedAt: string; capacity: 100; used: number }>> {
  if (!validPrincipal(p)) return fail('unavailable');
  const scope = parse(input, 'list');
  if (!scope) return fail('invalid_request');
  return db.transaction(async tx => {
    const auth = await authorize(tx, db, p, scope);
    if ('ok' in auth) return auth;
    const rows = (await tx.query<Row>(`SELECT ${columns} FROM predictions WHERE couple_id=$1 AND membership_epoch=$2 ORDER BY sequence DESC LIMIT 101`, [scope.coupleId, scope.membershipEpoch])).rows;
    if (rows.length > 100) throw Error('invalid_prediction_capacity');
    const predictions = rows.map(row => metadata(row, actorScope(scope, p)));
    if (!await activeSession(tx, db, p)) return fail('unavailable');
    return { ok: true, value: { predictions, checkedAt: now(db, clock), capacity: 100, used: rows.length } };
  });
}
export async function readPrediction(db: AuthorizedDatabase, p: Principal, input: unknown, clock?: PredictionClock): Promise<Result<{ prediction: Prediction; checkedAt: string; text?: string }>> {
  if (!validPrincipal(p)) return fail('unavailable');
  const scope = parse(input, 'read');
  if (!scope) return fail('invalid_request');
  return db.transaction(async tx => {
    const auth = await authorize(tx, db, p, scope);
    if ('ok' in auth) return auth;
    const row = await select(tx, scope, scope.predictionId!);
    if (!row || !await activeSession(tx, db, p)) return fail('unavailable');
    const actor = actorScope(scope, p), prediction = metadata(row, actor);
    let text: string | undefined;
    if (mayReadPrediction(prediction, actor, now(db, clock))) {
      const result = await tx.query<{ body: unknown }>('SELECT body FROM predictions WHERE couple_id=$1 AND membership_epoch=$2 AND id=$3', [scope.coupleId, scope.membershipEpoch, prediction.id]);
      if (result.rows.length !== 1 || typeof result.rows[0].body !== 'string' || normalizePredictionBody(result.rows[0].body) !== result.rows[0].body) throw Error('invalid_prediction_body');
      text = result.rows[0].body;
    }
    if (!await activeSession(tx, db, p)) return fail('unavailable');
    const checkedAt = now(db, clock);
    if (text !== undefined && !mayReadPrediction(prediction, actor, checkedAt)) return fail('unavailable');
    return { ok: true, value: { prediction, checkedAt, ...(text === undefined ? {} : { text }) } };
  });
}
export const createPrediction = (db: AuthorizedDatabase, p: Principal, input: unknown, clock?: PredictionClock) => mutate(db, p, input, 'create', clock);
export const openPrediction = (db: AuthorizedDatabase, p: Principal, input: unknown, clock?: PredictionClock) => mutate(db, p, input, 'open', clock);
export const declinePrediction = (db: AuthorizedDatabase, p: Principal, input: unknown, clock?: PredictionClock) => mutate(db, p, input, 'decline', clock);
export const removePrediction = (db: AuthorizedDatabase, p: Principal, input: unknown, clock?: PredictionClock) => mutate(db, p, input, 'remove', clock);
function provesOperation(applied: Prediction, scope: Scope, p: Principal, mode: Mutation): boolean {
  if (mode === 'create') return applied.authorId === p.userId && applied.version === 1 && applied.contentState === 'active'
    && applied.openedAt === null && applied.declinedAt === null && Object.entries(scope.schedule!).every(([key, value]) => applied[key as keyof Prediction] === value);
  if (applied.id !== scope.predictionId || applied.version !== scope.expectedVersion! + 1) return false;
  if (mode === 'remove') return applied.authorId === p.userId && applied.contentState === 'removed';
  return applied.recipientId === p.userId && applied.contentState === 'active'
    && (mode === 'open' ? applied.openedAt !== null : applied.declinedAt !== null);
}
async function mutate(db: AuthorizedDatabase, p: Principal, input: unknown, mode: Mutation, clock?: PredictionClock): Promise<Result<Ack>> {
  if (!validPrincipal(p)) return fail('unavailable');
  const scope = parse(input, mode);
  if (!scope) return fail('invalid_request');
  const actor = actorScope(scope, p);
  const fingerprint = createHash('sha256').update(JSON.stringify([mode, scope.coupleId, scope.membershipEpoch,
    scope.predictionId ?? null, scope.expectedVersion ?? null, true, scope.text ?? null, scope.schedule ?? null])).digest('hex');
  try {
    return await db.transaction(async tx => {
      const auth = await authorize(tx, db, p, scope);
      if ('ok' in auth) return auth;
      const previous = (await tx.query<Receipt>('SELECT fingerprint,prediction_id,operation,applied FROM prediction_commands WHERE actor_user_id=$1 AND command_id=$2', [p.userId, scope.commandId])).rows[0];
      if (!await activeSession(tx, db, p)) return fail('unavailable');
      if (previous) {
        if (previous.fingerprint !== fingerprint) return fail('idempotency_conflict');
        const row = await select(tx, scope, previous.prediction_id);
        if (!row) return fail('unavailable');
        const prediction = metadata(row, actor);
        if (previous.operation !== mode || !validPrediction(previous.applied, actor)
          || !provesOperation(previous.applied, scope, p, mode) || !followsPrediction(previous.applied, prediction, actor)) throw Error('invalid_prediction_replay');
        if (!await activeSession(tx, db, p)) return fail('unavailable');
        return { ok: true, value: { prediction, commandId: scope.commandId!, replay: true, checkedAt: now(db, clock) } };
      }
      let rows: Row[], startedAt: string;
      if (mode === 'create') {
        const used = Number((await tx.query<{ used: number }>('SELECT count(*)::int AS used FROM predictions WHERE couple_id=$1 AND membership_epoch=$2', [scope.coupleId, scope.membershipEpoch])).rows[0].used);
        if (!await activeSession(tx, db, p)) return fail('unavailable');
        if (used >= 100) return fail('capacity_reached');
        startedAt = now(db, clock);
        const schedule = parsePredictionSchedule(scope.schedule, startedAt);
        if (!schedule) return fail('invalid_request');
        rows = (await tx.query<Row>(`INSERT INTO predictions(couple_id,author_id,recipient_id,membership_epoch,sequence,version,created_at,release_at,timezone,local_date,local_time,utc_offset,content_state,body)
          VALUES($1,$2,$3,$4,$5,1,$6,$7,$8,$9,$10,$11,'active',$12) RETURNING ${columns}`,
        [scope.coupleId, p.userId, auth.otherId, scope.membershipEpoch, used + 1, startedAt,
          schedule.releaseAt, schedule.timezone, schedule.localDate, schedule.localTime, schedule.offset, scope.text])).rows;
      } else {
        const row = await select(tx, scope, scope.predictionId!);
        if (!row || !await activeSession(tx, db, p)) return fail('unavailable');
        const value = metadata(row, actor);
        if ((mode === 'remove' ? value.authorId : value.recipientId) !== p.userId) return fail('unavailable');
        if (value.version !== scope.expectedVersion || value.contentState !== 'active') return fail('version_conflict');
        startedAt = now(db, clock);
        if (startedAt < value.createdAt || (value.openedAt !== null && startedAt < value.openedAt)
          || (value.declinedAt !== null && startedAt < value.declinedAt)) return fail('unavailable');
        if (mode === 'open' && value.openedAt === null && value.declinedAt === null && startedAt < value.releaseAt) return fail('not_due');
        const next = mode === 'open' ? acknowledgePrediction(value, actor, startedAt, scope.expectedVersion!, true)
          : mode === 'decline' ? declinePolicy(value, actor, startedAt, scope.expectedVersion!, true)
            : removePolicy(value, actor, scope.expectedVersion!, true);
        if (!next) return fail('version_conflict');
        rows = (await tx.query<Row>(`UPDATE predictions SET content_state=$2,opened_at=$3,declined_at=$4,
          body=CASE WHEN $5::boolean THEN NULL ELSE body END,version=version+1 WHERE id=$1 RETURNING ${columns}`,
        [value.id, next.contentState, next.openedAt, next.declinedAt, mode === 'remove'])).rows;
      }
      if (rows.length !== 1) throw Error('invalid_prediction_write');
      const prediction = metadata(rows[0], actor);
      if (!provesOperation(prediction, scope, p, mode)) throw Error('invalid_prediction_applied_state');
      const receipt = await tx.query<Receipt>(`INSERT INTO prediction_commands(actor_user_id,command_id,couple_id,membership_epoch,prediction_id,fingerprint,operation,expected_version,applied)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING fingerprint,prediction_id,operation,applied`,
      [p.userId, scope.commandId, scope.coupleId, scope.membershipEpoch, prediction.id, fingerprint, mode, scope.expectedVersion ?? null, JSON.stringify(prediction)]);
      if (receipt.rows.length !== 1 || receipt.rows[0].fingerprint !== fingerprint || receipt.rows[0].prediction_id !== prediction.id
        || receipt.rows[0].operation !== mode || !followsPrediction(prediction, receipt.rows[0].applied, actor)
        || !followsPrediction(receipt.rows[0].applied, prediction, actor)) throw Error('invalid_prediction_receipt');
      // Any late refusal after writes MUST throw, not return: transaction() commits returned failures.
      if (!await activeSession(tx, db, p)) throw ended;
      const checkedAt = now(db, clock);
      if (checkedAt < startedAt || (mode === 'create' && !parsePredictionSchedule(scope.schedule, checkedAt))) throw ended;
      return { ok: true, value: { prediction, commandId: scope.commandId!, replay: false, checkedAt } };
    });
  } catch (error) { if (error === ended) return fail('unavailable'); throw error; }
}
