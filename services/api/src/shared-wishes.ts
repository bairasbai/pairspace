import { normalizeWishExplanation } from '../../../packages/domain/wishes/text.ts';
import { lockPair } from './pair-close.ts';
import type { AuthorizedDatabase, Principal, SqlExecutor } from './contracts.ts';
import { validPrincipal } from './session.ts';
import { isEpoch, isUuid } from './validation.ts';
import { normalizeTaskTitle } from '../../../packages/domain/tasks/title.ts';
export type SharedWish = Readonly<{ id: string; coupleId: string; creatorId: string; membershipEpoch: number;
  title: string; explanation: string; state: 'open' | 'fulfilled'; version: number; createdAt: string; updatedAt: string }>;
type Failure = { ok: false; error: 'invalid_request' | 'unavailable' | 'stale_membership' | 'idempotency_conflict' | 'version_conflict' };
type Result<T> = { ok: true; value: T } | Failure;
type Scope = { coupleId: string; membershipEpoch: number; commandId?: string; title?: string; explanation?: string; wishId?: string;
  operation?: 'create' | 'fulfill' | 'reopen'; expectedVersion?: number };
type Row = { id: string; couple_id: string; creator_id: string; membership_epoch: number; title: string; explanation: string;
  state: 'open' | 'fulfilled'; version: number; created_at: string; updated_at: string };
type Receipt = { couple_id: string; membership_epoch: number; wish_id: string; operation: string;
  expected_version: number; title: string | null; explanation: string | null; applied_version: number };
type Mutation = { wish: SharedWish; commandId: string; replay: boolean; appliedVersion: number };
const columns = 'id,couple_id,creator_id,membership_epoch,title,explanation,state,version,created_at::text,updated_at::text';
const wish = (r: Row): SharedWish => ({ id: r.id, coupleId: r.couple_id, creatorId: r.creator_id,
  membershipEpoch: r.membership_epoch, title: r.title, explanation: r.explanation, state: r.state, version: r.version,
  createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString() });
const fail = (error: Failure['error']): Failure => ({ ok: false, error });
function parse(input: unknown, mode: 'create' | 'change' | 'list'): Scope | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const f = input as Record<string, unknown>;
  const keys = mode === 'list' ? 'coupleId,membershipEpoch' : mode === 'create'
    ? 'commandId,coupleId,explanation,membershipEpoch,title' : 'commandId,coupleId,expectedVersion,membershipEpoch,operation,wishId';
  if (Object.keys(f).sort().join(',') !== keys || !isUuid(f.coupleId) || !isEpoch(f.membershipEpoch)) return null;
  const scope: Scope = { coupleId: f.coupleId.toLowerCase(), membershipEpoch: f.membershipEpoch };
  if (mode === 'list') return scope;
  if (!isUuid(f.commandId)) return null;
  scope.commandId = f.commandId.toLowerCase();
  if (mode === 'create') {
    const title = normalizeTaskTitle(f.title), explanation = normalizeWishExplanation(f.explanation);
    return title.ok && explanation.ok ? { ...scope, title: title.text, explanation: explanation.text, operation: 'create', expectedVersion: 0 } : null;
  }
  if (!isUuid(f.wishId) || !Number.isSafeInteger(f.expectedVersion) || Number(f.expectedVersion) < 1
    || Number(f.expectedVersion) >= 2147483647 || (f.operation !== 'fulfill' && f.operation !== 'reopen')) return null;
  return { ...scope, wishId: f.wishId.toLowerCase(), operation: f.operation as 'fulfill' | 'reopen', expectedVersion: Number(f.expectedVersion) };
}
async function authorize(tx: SqlExecutor, db: AuthorizedDatabase, principal: Principal, scope: Scope): Promise<Failure | null> {
  // Reuse closure lock order: historical users UPDATE → session → pair → fresh session.
  const pair = await lockPair(tx, db, principal, scope.coupleId);
  if (typeof pair === 'string') return fail('unavailable');
  const active = pair.members.filter(row => row.status === 'active');
  if (pair.status !== 'active' || active.length !== 2 || !active.some(row => row.user_id === principal.userId)) return fail('unavailable');
  return pair.epoch === scope.membershipEpoch ? null : fail('stale_membership');
}
async function currentWish(tx: SqlExecutor, scope: Scope, id: string): Promise<Row | undefined> {
  return (await tx.query<Row>(`SELECT ${columns} FROM shared_wishes WHERE couple_id=$1 AND membership_epoch=$2 AND id=$3`,
    [scope.coupleId, scope.membershipEpoch, id])).rows[0];
}
async function mutate(db: AuthorizedDatabase, principal: Principal, input: unknown, mode: 'create' | 'change'): Promise<Result<Mutation>> {
  if (!validPrincipal(principal)) return fail('unavailable');
  const scope = parse(input, mode);
  if (!scope) return fail('invalid_request');
  return db.transaction(async tx => {
    const denied = await authorize(tx, db, principal, scope);
    if (denied) return denied;
    const previous = (await tx.query<Receipt>('SELECT couple_id,membership_epoch,wish_id,operation,expected_version,title,explanation,applied_version FROM shared_wish_commands WHERE actor_user_id=$1 AND command_id=$2', [principal.userId, scope.commandId])).rows[0];
    if (previous) {
      if (previous.couple_id !== scope.coupleId || previous.membership_epoch !== scope.membershipEpoch
        || previous.operation !== scope.operation || previous.expected_version !== scope.expectedVersion
        || previous.title !== (scope.title ?? null) || previous.explanation !== (scope.explanation ?? null) || (mode === 'change' && previous.wish_id !== scope.wishId)) return fail('idempotency_conflict');
      const row = await currentWish(tx, scope, previous.wish_id);
      return row ? { ok: true, value: { wish: wish(row), commandId: scope.commandId!, replay: true, appliedVersion: previous.applied_version } } : fail('unavailable');
    }
    const now = db.now();
    if (!Number.isFinite(now.getTime())) throw new Error('invalid_server_clock');
    let row: Row;
    if (mode === 'create') {
      row = (await tx.query<Row>(`INSERT INTO shared_wishes(couple_id,creator_id,membership_epoch,title,explanation,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$6) RETURNING ${columns}`, [scope.coupleId, principal.userId, scope.membershipEpoch, scope.title, scope.explanation, now])).rows[0];
    } else {
      const old = await currentWish(tx, scope, scope.wishId!);
      if (!old) return fail('unavailable');
      const state = scope.operation === 'fulfill' ? 'fulfilled' : 'open';
      if (old.version !== scope.expectedVersion || old.state === state) return fail('version_conflict');
      row = (await tx.query<Row>(`UPDATE shared_wishes SET state=$1,version=version+1,updated_at=GREATEST(updated_at,$2)
        WHERE couple_id=$3 AND id=$4 AND version=$5 RETURNING ${columns}`, [state, now, scope.coupleId, scope.wishId, scope.expectedVersion])).rows[0];
    }
    await tx.query(`INSERT INTO shared_wish_commands(actor_user_id,command_id,couple_id,membership_epoch,wish_id,operation,expected_version,title,explanation,applied_version)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [principal.userId, scope.commandId, scope.coupleId, scope.membershipEpoch,
      row.id, scope.operation, scope.expectedVersion, scope.title ?? null, scope.explanation ?? null, row.version]);
    return { ok: true, value: { wish: wish(row), commandId: scope.commandId!, replay: false, appliedVersion: row.version } };
  });
}
export const createSharedWish = (db: AuthorizedDatabase, principal: Principal, input: unknown) => mutate(db, principal, input, 'create');
export const changeSharedWish = (db: AuthorizedDatabase, principal: Principal, input: unknown) => mutate(db, principal, input, 'change');
export async function listSharedWishes(db: AuthorizedDatabase, principal: Principal, input: unknown): Promise<Result<{ wishes: SharedWish[]; limit: 50 }>> {
  if (!validPrincipal(principal)) return fail('unavailable');
  const scope = parse(input, 'list');
  if (!scope) return fail('invalid_request');
  return db.transaction(async tx => {
    const denied = await authorize(tx, db, principal, scope);
    if (denied) return denied;
    const rows = await tx.query<Row>(`SELECT ${columns} FROM shared_wishes WHERE couple_id=$1 AND membership_epoch=$2
      ORDER BY created_at DESC,id DESC LIMIT 50`, [scope.coupleId, scope.membershipEpoch]);
    return { ok: true, value: { wishes: rows.rows.map(wish), limit: 50 } };
  });
}
