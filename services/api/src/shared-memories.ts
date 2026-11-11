import { lockPair } from './pair-close.ts';
import type { AuthorizedDatabase, Principal, SqlExecutor } from './contracts.ts';
import { validPrincipal } from './session.ts';
import { isEpoch, isUuid } from './validation.ts';
import { normalizeTaskTitle } from '../../../packages/domain/tasks/title.ts';
import { normalizeMemoryBody } from '../../../packages/domain/memories/text.ts';
import { isLocalDate } from '../../../packages/domain/dates/calendar.ts';
export type SharedMemory = Readonly<{ id: string; coupleId: string; creatorId: string; membershipEpoch: number;
  title: string; body: string; localDate: string; createdAt: string }>;
type Failure = { ok: false; error: 'invalid_request' | 'unavailable' | 'stale_membership' | 'idempotency_conflict' };
type Result<T> = { ok: true; value: T } | Failure;
type Scope = { coupleId: string; membershipEpoch: number; commandId?: string; title?: string; body?: string; localDate?: string };
type Row = { id: string; couple_id: string; creator_id: string; membership_epoch: number; title: string; body: string; local_date: string; created_at: string };
type Receipt = Row & { command_id: string };
const columns = 'id,couple_id,creator_id,membership_epoch,title,body,local_date,created_at::text';
const memory = (r: Row): SharedMemory => ({ id: r.id, coupleId: r.couple_id, creatorId: r.creator_id,
  membershipEpoch: r.membership_epoch, title: r.title, body: r.body, localDate: r.local_date, createdAt: new Date(r.created_at).toISOString() });
const fail = (error: Failure['error']): Failure => ({ ok: false, error });
function parse(input: unknown, write: boolean): Scope | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const f = input as Record<string, unknown>;
  if (Object.keys(f).sort().join(',') !== (write ? 'body,commandId,coupleId,localDate,membershipEpoch,title' : 'coupleId,membershipEpoch')
    || !isUuid(f.coupleId) || !isEpoch(f.membershipEpoch)) return null;
  const scope = { coupleId: f.coupleId.toLowerCase(), membershipEpoch: f.membershipEpoch };
  if (!write) return scope;
  if (!isUuid(f.commandId) || !isLocalDate(f.localDate)) return null;
  const title = normalizeTaskTitle(f.title), body = normalizeMemoryBody(f.body);
  return title.ok && body.ok ? { ...scope, commandId: f.commandId.toLowerCase(), title: title.text, body: body.text, localDate: f.localDate } : null;
}
async function authorize(tx: SqlExecutor, db: AuthorizedDatabase, principal: Principal, scope: Scope): Promise<Failure | null> {
  const pair = await lockPair(tx, db, principal, scope.coupleId);
  if (typeof pair === 'string') return fail('unavailable');
  const active = pair.members.filter(row => row.status === 'active');
  if (pair.status !== 'active' || active.length !== 2 || !active.some(row => row.user_id === principal.userId)) return fail('unavailable');
  return pair.epoch === scope.membershipEpoch ? null : fail('stale_membership');
}
export async function createSharedMemory(db: AuthorizedDatabase, principal: Principal, input: unknown): Promise<Result<{ memory: SharedMemory; commandId: string; replay: boolean }>> {
  if (!validPrincipal(principal)) return fail('unavailable');
  const scope = parse(input, true);
  if (!scope) return fail('invalid_request');
  return db.transaction(async tx => {
    const denied = await authorize(tx, db, principal, scope);
    if (denied) return denied;
    // The actor user lock serializes command IDs even across pairs; authorize before replay.
    const previous = (await tx.query<Receipt>(`SELECT ${columns},command_id FROM shared_memories WHERE creator_id=$1 AND command_id=$2`, [principal.userId, scope.commandId])).rows[0];
    if (previous) {
      if (previous.couple_id !== scope.coupleId || previous.membership_epoch !== scope.membershipEpoch || previous.title !== scope.title
        || previous.body !== scope.body || previous.local_date !== scope.localDate) return fail('idempotency_conflict');
      return { ok: true, value: { memory: memory(previous), commandId: scope.commandId!, replay: true } };
    }
    const now = db.now();
    if (!Number.isFinite(now.getTime())) throw new Error('invalid_server_clock');
    const row = (await tx.query<Row>(`INSERT INTO shared_memories(couple_id,creator_id,membership_epoch,command_id,title,body,local_date,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${columns}`,
      [scope.coupleId, principal.userId, scope.membershipEpoch, scope.commandId, scope.title, scope.body, scope.localDate, now])).rows[0];
    return { ok: true, value: { memory: memory(row), commandId: scope.commandId!, replay: false } };
  });
}
export async function listSharedMemories(db: AuthorizedDatabase, principal: Principal, input: unknown): Promise<Result<{ memories: SharedMemory[]; limit: 50 }>> {
  if (!validPrincipal(principal)) return fail('unavailable');
  const scope = parse(input, false);
  if (!scope) return fail('invalid_request');
  return db.transaction(async tx => {
    const denied = await authorize(tx, db, principal, scope);
    if (denied) return denied;
    const rows = await tx.query<Row>(`SELECT ${columns} FROM shared_memories WHERE couple_id=$1 AND membership_epoch=$2
      ORDER BY created_at DESC,id DESC LIMIT 50`, [scope.coupleId, scope.membershipEpoch]);
    return { ok: true, value: { memories: rows.rows.map(memory), limit: 50 } };
  });
}
