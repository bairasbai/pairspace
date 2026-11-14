import { createHash } from 'node:crypto';
import { normalizeHardText } from '../../../packages/domain/hard/text.ts';
import type { HardQuestion } from '../../../packages/domain/hard/metadata.ts';
import type { AuthorizedDatabase, Principal, SqlExecutor } from './contracts.ts';
import { lockPair } from './pair-close.ts';
import { activeSession, validPrincipal } from './session.ts';
import { isEpoch, isUuid } from './validation.ts';

type ErrorCode = 'invalid_request' | 'unavailable' | 'stale_membership' | 'idempotency_conflict' | 'version_conflict' | 'capacity_reached';
type Failure = { ok: false; error: ErrorCode };
type Result<T> = { ok: true; value: T } | Failure;
type Mode = 'list' | 'read' | 'seal' | 'open' | 'decline' | 'remove';
type Scope = { coupleId: string; membershipEpoch: number; questionId?: string; commandId?: string; expectedVersion?: number; text?: string };
type Row = { id: string; couple_id: string; author_id: string; recipient_id: string; membership_epoch: number;
  sequence: number; version: number; created_at: string; content_state: HardQuestion['contentState']; decision_state: HardQuestion['decisionState']; opened_at: string | null };
type Ack = { question: HardQuestion; commandId: string; replay: boolean; checkedAt?: string; text?: string };
// No metadata query/ACK selects body. Only role-gated explicit read/open projections do.
const columns = 'id,couple_id,author_id,recipient_id,membership_epoch,sequence,version,created_at::text,content_state,decision_state,opened_at::text';
const fail = (error: ErrorCode): Failure => ({ ok: false, error });
function now(db: AuthorizedDatabase) {
  const value = db.now();
  if (!Number.isFinite(value.getTime())) throw Error('invalid_hard_question_clock');
  return value;
}
function metadata(row: Row): HardQuestion {
  return { id: row.id, coupleId: row.couple_id, authorId: row.author_id, recipientId: row.recipient_id,
    membershipEpoch: row.membership_epoch, sequence: row.sequence, version: row.version, createdAt: new Date(row.created_at).toISOString(),
    contentState: row.content_state, decisionState: row.decision_state,
    ...(row.opened_at !== null ? { openedAt: new Date(row.opened_at).toISOString() } : {}) };
}
function parse(input: unknown, mode: Mode): Scope | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const f = input as Record<string, unknown>, read = mode === 'list' || mode === 'read';
  const keys = ['coupleId', 'membershipEpoch', ...(mode !== 'list' && mode !== 'seal' ? ['questionId'] : []),
    ...(!read ? ['commandId'] : []), ...(!read && mode !== 'seal' ? ['expectedVersion', 'confirm'] : []), ...(mode === 'seal' ? ['text'] : [])];
  if (Object.keys(f).sort().join() !== keys.sort().join() || !isUuid(f.coupleId) || !isEpoch(f.membershipEpoch)) return null;
  const scope: Scope = { coupleId: f.coupleId.toLowerCase(), membershipEpoch: f.membershipEpoch };
  if (mode !== 'list' && mode !== 'seal') {
    if (!isUuid(f.questionId)) return null;
    scope.questionId = f.questionId.toLowerCase();
  }
  if (!read) {
    if (!isUuid(f.commandId)) return null;
    scope.commandId = f.commandId.toLowerCase();
    if (mode !== 'seal') {
      if (f.confirm !== true || !Number.isInteger(f.expectedVersion) || Number(f.expectedVersion) < 1 || Number(f.expectedVersion) > 2147483646) return null;
      scope.expectedVersion = Number(f.expectedVersion);
    }
  }
  if (mode === 'seal') {
    const text = normalizeHardText(f.text);
    if (text === null) return null;
    scope.text = text;
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
  (await tx.query<Row>(`SELECT ${columns} FROM hard_questions WHERE couple_id=$1 AND membership_epoch=$2 AND id=$3 FOR UPDATE`, [scope.coupleId, scope.membershipEpoch, id])).rows[0];
async function projectText(tx: SqlExecutor, scope: Scope, row: Row, actor: string): Promise<{ text?: string }> {
  if (row.content_state !== 'active' || (row.author_id !== actor && (row.recipient_id !== actor || row.decision_state !== 'opened'))) return {};
  const result = await tx.query<{ body: string }>('SELECT body FROM hard_questions WHERE couple_id=$1 AND membership_epoch=$2 AND id=$3', [scope.coupleId, scope.membershipEpoch, row.id]);
  if (result.rows.length !== 1 || typeof result.rows[0].body !== 'string' || normalizeHardText(result.rows[0].body) !== result.rows[0].body) throw Error('invalid_hard_question_body');
  return { text: result.rows[0].body };
}
export async function listHardQuestions(db: AuthorizedDatabase, p: Principal, input: unknown): Promise<Result<{ questions: HardQuestion[]; checkedAt: string; capacity: 100; used: number }>> {
  if (!validPrincipal(p)) return fail('unavailable');
  const scope = parse(input, 'list');
  if (!scope) return fail('invalid_request');
  return db.transaction(async tx => {
    const auth = await authorize(tx, db, p, scope);
    if ('ok' in auth) return auth;
    const rows = (await tx.query<Row>(`SELECT ${columns} FROM hard_questions WHERE couple_id=$1 AND membership_epoch=$2 ORDER BY (decision_state='sealed') DESC,sequence DESC LIMIT 101`, [scope.coupleId, scope.membershipEpoch])).rows;
    if (rows.length > 100) throw Error('invalid_hard_question_capacity');
    if (!await activeSession(tx, db, p)) return fail('unavailable');
    return { ok: true, value: { questions: rows.map(metadata), checkedAt: now(db).toISOString(), capacity: 100, used: rows.length } };
  });
}
export async function readHardQuestion(db: AuthorizedDatabase, p: Principal, input: unknown): Promise<Result<{ question: HardQuestion; checkedAt: string; text?: string }>> {
  if (!validPrincipal(p)) return fail('unavailable');
  const scope = parse(input, 'read');
  if (!scope) return fail('invalid_request');
  return db.transaction(async tx => {
    const auth = await authorize(tx, db, p, scope);
    if ('ok' in auth) return auth;
    const row = await select(tx, scope, scope.questionId!);
    if (!row || !await activeSession(tx, db, p)) return fail('unavailable');
    const text = await projectText(tx, scope, row, p.userId);
    if (!await activeSession(tx, db, p)) return fail('unavailable');
    return { ok: true, value: { question: metadata(row), checkedAt: now(db).toISOString(), ...text } };
  });
}
export const sealHardQuestion = (db: AuthorizedDatabase, p: Principal, input: unknown) => mutate(db, p, input, 'seal');
export const openHardQuestion = (db: AuthorizedDatabase, p: Principal, input: unknown) => mutate(db, p, input, 'open');
export const declineHardQuestion = (db: AuthorizedDatabase, p: Principal, input: unknown) => mutate(db, p, input, 'decline');
export const removeHardQuestion = (db: AuthorizedDatabase, p: Principal, input: unknown) => mutate(db, p, input, 'remove');
async function mutate(db: AuthorizedDatabase, p: Principal, input: unknown, mode: Exclude<Mode, 'list' | 'read'>): Promise<Result<Ack>> {
  if (!validPrincipal(p)) return fail('unavailable');
  const scope = parse(input, mode);
  if (!scope) return fail('invalid_request');
  const fingerprint = createHash('sha256').update(JSON.stringify([mode, scope.coupleId, scope.membershipEpoch,
    scope.questionId ?? null, scope.expectedVersion ?? null, mode === 'seal' ? null : true, scope.text ?? null])).digest('hex');
  const revoked = new Error('hard_question_session_ended');
  try {
    return await db.transaction(async tx => {
      const auth = await authorize(tx, db, p, scope);
      if ('ok' in auth) return auth;
      const previous = (await tx.query<{ fingerprint: string; question_id: string }>(
        'SELECT fingerprint,question_id FROM hard_question_commands WHERE actor_user_id=$1 AND command_id=$2', [p.userId, scope.commandId])).rows[0];
      if (!await activeSession(tx, db, p)) return fail('unavailable');
      async function acknowledgement(row: Row, replay: boolean): Promise<Result<Ack>> {
        if (!await activeSession(tx, db, p)) throw revoked;
        let projection = {};
        if (mode === 'open') {
          if (row.recipient_id !== p.userId || row.decision_state !== 'opened') throw Error('invalid_hard_question_open_receipt');
          projection = { ...await projectText(tx, scope!, row, p.userId), checkedAt: now(db).toISOString() };
        }
        if (!await activeSession(tx, db, p)) throw revoked;
        return { ok: true, value: { question: metadata(row), commandId: scope!.commandId!, replay, ...projection } };
      }
      if (previous) {
        if (previous.fingerprint !== fingerprint) return fail('idempotency_conflict');
        const row = await select(tx, scope, previous.question_id);
        return row ? acknowledgement(row, true) : fail('unavailable');
      }
      let current: Row;
      if (mode === 'seal') {
        const used = Number((await tx.query<{ used: number }>('SELECT count(*)::int AS used FROM hard_questions WHERE couple_id=$1 AND membership_epoch=$2', [scope.coupleId, scope.membershipEpoch])).rows[0].used);
        if (!await activeSession(tx, db, p)) return fail('unavailable');
        if (used >= 100) return fail('capacity_reached');
        const rows = (await tx.query<Row>(`INSERT INTO hard_questions(couple_id,author_id,recipient_id,membership_epoch,sequence,version,created_at,content_state,decision_state,body)
          VALUES($1,$2,$3,$4,$5,1,$6,'active','sealed',$7) RETURNING ${columns}`, [scope.coupleId, p.userId, auth.otherId, scope.membershipEpoch, used + 1, now(db), scope.text])).rows;
        if (rows.length !== 1) throw Error('invalid_hard_question_write');
        current = rows[0];
      } else {
        const row = await select(tx, scope, scope.questionId!);
        if (!row || !await activeSession(tx, db, p)) return fail('unavailable');
        if ((mode === 'remove' ? row.author_id : row.recipient_id) !== p.userId) return fail('unavailable');
        if (row.content_state !== 'active' || (mode !== 'remove' && row.decision_state !== 'sealed') || row.version !== scope.expectedVersion) return fail('version_conflict');
        const decision = mode === 'open' ? 'opened' : mode === 'decline' ? 'declined' : row.decision_state === 'sealed' ? 'withdrawn' : row.decision_state;
        const rows = (await tx.query<Row>(`UPDATE hard_questions SET content_state=$2,decision_state=$3,
          body=CASE WHEN $4::boolean THEN NULL ELSE body END,opened_at=$5,version=version+1 WHERE id=$1 RETURNING ${columns}`,
        [row.id, mode === 'remove' ? 'removed' : 'active', decision, mode === 'remove',
          mode === 'open' ? new Date(Math.max(now(db).getTime(), Date.parse(row.created_at))) : row.opened_at])).rows;
        if (rows.length !== 1) throw Error('invalid_hard_question_write');
        current = rows[0];
      }
      const receipt = await tx.query<{ question_id: string; fingerprint: string }>(
        'INSERT INTO hard_question_commands(actor_user_id,command_id,couple_id,membership_epoch,question_id,fingerprint) VALUES($1,$2,$3,$4,$5,$6) RETURNING question_id,fingerprint',
        [p.userId, scope.commandId, scope.coupleId, scope.membershipEpoch, current.id, fingerprint]);
      if (receipt.rows.length !== 1 || receipt.rows[0].question_id !== current.id || receipt.rows[0].fingerprint !== fingerprint) throw Error('invalid_hard_question_receipt');
      return acknowledgement(current, false);
    });
  } catch (error) {
    if (error === revoked) return fail('unavailable');
    throw error;
  }
}
