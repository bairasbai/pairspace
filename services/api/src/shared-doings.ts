import { createHash } from 'node:crypto';
import { canAdvanceDoing, integer, kind, normalizeDoingTitle, orderDoings, validDoing, type SharedDoing } from '../../../packages/domain/doings/state.ts';
import type { AuthorizedDatabase, Principal, SqlExecutor } from './contracts.ts';
import { lockPair } from './pair-close.ts';
import { activeSession, validPrincipal } from './session.ts';
import { isEpoch, isUuid } from './validation.ts';

type Code = 'invalid_request' | 'unavailable' | 'stale_membership' | 'idempotency_conflict' | 'version_conflict' | 'capacity_reached';
type Failure = { ok: false; error: Code };
type Result<T> = { ok: true; value: T } | Failure;
type Mode = 'list' | 'propose' | 'join' | 'decline' | 'advance' | 'remove';
type Scope = { coupleId: string; membershipEpoch: number; doingId?: string; commandId?: string; expectedVersion?: number;
  title?: string; kind?: string; parts?: number; part?: number };
type Row = { id: string; couple_id: string; author_id: string; recipient_id: string; membership_epoch: number;
  sequence: number; version: number; created_at: string; content_state: SharedDoing['contentState']; decision_state: SharedDoing['decisionState'] };
type Fields = { title: string; kind: string; parts: number; author_at: number; recipient_at: number | null };
type Ack = { doing: SharedDoing; commandId: string; replay: boolean };
const columns = 'id,couple_id,author_id,recipient_id,membership_epoch,sequence,version,created_at::text,content_state,decision_state';
const ended = new Error('shared_doing_session_ended');
const fail = (error: Code): Failure => ({ ok: false, error });
function now(db: AuthorizedDatabase) {
  const clock = db.now();
  if (!Number.isFinite(clock.getTime())) throw Error('invalid_shared_doing_clock');
  return clock;
}
function parse(input: unknown, mode: Mode): Scope | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const f = input as Record<string, unknown>, list = mode === 'list', create = mode === 'propose';
  const keys = ['coupleId', 'membershipEpoch', ...(!list ? ['commandId', 'confirm'] : []),
    ...(!list && !create ? ['doingId', 'expectedVersion'] : []), ...(create ? ['title', 'kind', 'parts'] : []), ...(mode === 'advance' ? ['part'] : [])];
  if (Object.keys(f).sort().join() !== keys.sort().join() || !isUuid(f.coupleId) || !isEpoch(f.membershipEpoch)) return null;
  const scope: Scope = { coupleId: f.coupleId.toLowerCase(), membershipEpoch: f.membershipEpoch };
  if (!list) {
    if (!isUuid(f.commandId) || f.confirm !== true) return null;
    scope.commandId = f.commandId.toLowerCase();
    if (!create) {
      if (!isUuid(f.doingId) || !integer(f.expectedVersion, 1, 2004)) return null;
      scope.doingId = f.doingId.toLowerCase(); scope.expectedVersion = f.expectedVersion;
    }
  }
  if (create) {
    const title = normalizeDoingTitle(f.title);
    if (title === null || !kind(f.kind) || !integer(f.parts, 1, 1000)) return null;
    scope.title = title; scope.kind = f.kind; scope.parts = f.parts;
  }
  if (mode === 'advance') { if (!integer(f.part, 0, 1000)) return null; scope.part = f.part; }
  return scope;
}
async function authorize(tx: SqlExecutor, db: AuthorizedDatabase, p: Principal, scope: Scope): Promise<Failure | { otherId: string }> {
  const pair = await lockPair(tx, db, p, scope.coupleId);
  if (typeof pair === 'string') return fail('unavailable');
  const members = pair.members.filter(m => m.status === 'active');
  if (pair.status !== 'active' || members.length !== 2 || !members.some(m => m.user_id === p.userId)) return fail('unavailable');
  return pair.epoch !== scope.membershipEpoch ? fail('stale_membership') : { otherId: members.find(m => m.user_id !== p.userId)!.user_id };
}
const select = async (tx: SqlExecutor, scope: Scope, id: string) =>
  (await tx.query<Row>(`SELECT ${columns} FROM shared_doings WHERE couple_id=$1 AND membership_epoch=$2 AND id=$3 FOR UPDATE`, [scope.coupleId, scope.membershipEpoch, id])).rows[0];
async function project(tx: SqlExecutor, db: AuthorizedDatabase, p: Principal, scope: Scope, row: Row): Promise<SharedDoing> {
  if (!await activeSession(tx, db, p)) throw ended;
  if (![row.author_id, row.recipient_id].includes(p.userId)) throw Error('invalid_shared_doing_actor');
  let fields = {};
  if (row.content_state === 'active') {
    const result = await tx.query<Fields>('SELECT title,kind,parts,author_at,recipient_at FROM shared_doings WHERE couple_id=$1 AND membership_epoch=$2 AND id=$3', [scope.coupleId, scope.membershipEpoch, row.id]);
    if (result.rows.length !== 1) throw Error('invalid_shared_doing_fields');
    const f = result.rows[0];
    fields = { title: f.title, kind: f.kind, parts: f.parts, authorAt: f.author_at,
      ...(row.decision_state === 'joined' ? { recipientAt: f.recipient_at } : {}) };
  }
  if (!await activeSession(tx, db, p)) throw ended;
  const value = { id: row.id, coupleId: row.couple_id, authorId: row.author_id, recipientId: row.recipient_id,
    membershipEpoch: row.membership_epoch, sequence: row.sequence, version: row.version, createdAt: new Date(row.created_at).toISOString(),
    contentState: row.content_state, decisionState: row.decision_state, ...fields };
  if (!validDoing(value, { ...scope, userId: p.userId })) throw Error('invalid_shared_doing_record');
  return value;
}
export async function listSharedDoings(db: AuthorizedDatabase, p: Principal, input: unknown): Promise<Result<{ doings: SharedDoing[]; checkedAt: string; capacity: 100; used: number }>> {
  if (!validPrincipal(p)) return fail('unavailable');
  const scope = parse(input, 'list');
  if (!scope) return fail('invalid_request');
  try {
    return await db.transaction(async tx => {
      const auth = await authorize(tx, db, p, scope);
      if ('ok' in auth) return auth;
      const rows = (await tx.query<Row>(`SELECT ${columns} FROM shared_doings WHERE couple_id=$1 AND membership_epoch=$2 ORDER BY sequence DESC LIMIT 101`, [scope.coupleId, scope.membershipEpoch])).rows;
      if (rows.length > 100) throw Error('invalid_shared_doing_capacity');
      const doings: SharedDoing[] = [];
      for (const row of rows) doings.push(await project(tx, db, p, scope, row));
      if (!await activeSession(tx, db, p)) throw ended;
      return { ok: true, value: { doings: doings.sort(orderDoings), checkedAt: now(db).toISOString(), capacity: 100, used: rows.length } };
    });
  } catch (error) { if (error === ended) return fail('unavailable'); throw error; }
}
export const proposeSharedDoing = (db: AuthorizedDatabase, p: Principal, input: unknown) => mutate(db, p, input, 'propose');
export const joinSharedDoing = (db: AuthorizedDatabase, p: Principal, input: unknown) => mutate(db, p, input, 'join');
export const declineSharedDoing = (db: AuthorizedDatabase, p: Principal, input: unknown) => mutate(db, p, input, 'decline');
export const advanceSharedDoing = (db: AuthorizedDatabase, p: Principal, input: unknown) => mutate(db, p, input, 'advance');
export const removeSharedDoing = (db: AuthorizedDatabase, p: Principal, input: unknown) => mutate(db, p, input, 'remove');
async function mutate(db: AuthorizedDatabase, p: Principal, input: unknown, mode: Exclude<Mode, 'list'>): Promise<Result<Ack>> {
  if (!validPrincipal(p)) return fail('unavailable');
  const scope = parse(input, mode);
  if (!scope) return fail('invalid_request');
  const fingerprint = createHash('sha256').update(JSON.stringify([mode, scope.coupleId, scope.membershipEpoch, scope.doingId ?? null,
    scope.expectedVersion ?? null, true, scope.title ?? null, scope.kind ?? null, scope.parts ?? null, scope.part ?? null])).digest('hex');
  try {
    return await db.transaction(async tx => {
      const auth = await authorize(tx, db, p, scope);
      if ('ok' in auth) return auth;
      const previous = (await tx.query<{ fingerprint: string; doing_id: string }>('SELECT fingerprint,doing_id FROM shared_doing_commands WHERE actor_user_id=$1 AND command_id=$2', [p.userId, scope.commandId])).rows[0];
      if (!await activeSession(tx, db, p)) return fail('unavailable');
      async function ack(row: Row, replay: boolean): Promise<Result<Ack>> {
        const doing = await project(tx, db, p, scope!, row);
        if (!await activeSession(tx, db, p)) throw ended;
        return { ok: true, value: { doing, commandId: scope!.commandId!, replay } };
      }
      if (previous) {
        if (previous.fingerprint !== fingerprint) return fail('idempotency_conflict');
        const row = await select(tx, scope, previous.doing_id);
        return row ? ack(row, true) : fail('unavailable');
      }
      let current: Row;
      if (mode === 'propose') {
        const used = Number((await tx.query<{ used: number }>('SELECT count(*)::int AS used FROM shared_doings WHERE couple_id=$1 AND membership_epoch=$2', [scope.coupleId, scope.membershipEpoch])).rows[0].used);
        if (!await activeSession(tx, db, p)) return fail('unavailable');
        if (used >= 100) return fail('capacity_reached');
        const result = await tx.query<Row>(`INSERT INTO shared_doings(couple_id,author_id,recipient_id,membership_epoch,sequence,version,created_at,content_state,decision_state,title,kind,parts,author_at)
          VALUES($1,$2,$3,$4,$5,1,$6,'active','invited',$7,$8,$9,0) RETURNING ${columns}`, [scope.coupleId, p.userId, auth.otherId, scope.membershipEpoch, used + 1, now(db), scope.title, scope.kind, scope.parts]);
        if (result.rows.length !== 1) throw Error('invalid_shared_doing_write');
        current = result.rows[0];
      } else {
        const row = await select(tx, scope, scope.doingId!);
        if (!row || !await activeSession(tx, db, p)) return fail('unavailable');
        if ((mode === 'remove' ? row.author_id !== p.userId : mode === 'advance' ? ![row.author_id, row.recipient_id].includes(p.userId) : row.recipient_id !== p.userId)) return fail('unavailable');
        if (row.content_state !== 'active' || row.version !== scope.expectedVersion
          || (mode === 'join' && row.decision_state !== 'invited') || (mode === 'decline' && !['invited', 'joined'].includes(row.decision_state))) return fail('version_conflict');
        let update: string;
        const args: unknown[] = [row.id];
        if (mode === 'advance') {
          const doing = await project(tx, db, p, scope, row);
          if (!canAdvanceDoing(doing, p.userId) || doing.contentState !== 'active') return fail('version_conflict');
          const at = row.author_id === p.userId ? doing.authorAt : doing.decisionState === 'joined' ? doing.recipientAt : 0;
          if (scope.part! <= at || scope.part! > doing.parts) return fail('version_conflict');
          update = (row.author_id === p.userId ? 'author_at' : 'recipient_at') + '=$2'; args.push(scope.part);
        } else if (mode === 'join') update = "decision_state='joined',recipient_at=0";
        else if (mode === 'decline') update = "decision_state='declined',recipient_at=NULL";
        else update = "content_state='removed',decision_state=CASE WHEN decision_state='invited' THEN 'withdrawn' ELSE decision_state END,title=NULL,kind=NULL,parts=NULL,author_at=NULL,recipient_at=NULL";
        const result = await tx.query<Row>(`UPDATE shared_doings SET ${update},version=version+1 WHERE id=$1 RETURNING ${columns}`, args);
        if (result.rows.length !== 1) throw Error('invalid_shared_doing_write');
        current = result.rows[0];
      }
      const receipt = await tx.query<{ doing_id: string; fingerprint: string }>('INSERT INTO shared_doing_commands(actor_user_id,command_id,couple_id,membership_epoch,doing_id,fingerprint) VALUES($1,$2,$3,$4,$5,$6) RETURNING doing_id,fingerprint', [p.userId, scope.commandId, scope.coupleId, scope.membershipEpoch, current.id, fingerprint]);
      if (receipt.rows.length !== 1 || receipt.rows[0].doing_id !== current.id || receipt.rows[0].fingerprint !== fingerprint) throw Error('invalid_shared_doing_receipt');
      return ack(current, false);
    });
  } catch (error) { if (error === ended) return fail('unavailable'); throw error; }
}
