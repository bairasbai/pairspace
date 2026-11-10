import { blindQuestion, findBlindQuestion } from '../../../packages/domain/blind/catalog.ts';
import { normalizeAnswer } from '../../../packages/domain/blind/answer.ts';
import type { AuthorizedDatabase, Principal, SqlExecutor } from './contracts.ts';
import { lockPair } from './pair-close.ts';
import { validPrincipal } from './session.ts';
import { isEpoch, isUuid } from './validation.ts';
export type BlindRound = Readonly<{ id: string; coupleId: string; membershipEpoch: number; questionId: string;
  catalogVersion: number; ownAnswer: string | null; partnerAnswer: string | null; revealed: boolean }>;
type ErrorCode = 'invalid_request' | 'unavailable' | 'stale_membership' | 'idempotency_conflict' | 'already_submitted' | 'round_conflict';
type Result<T> = { ok: true; value: T } | { ok: false; error: ErrorCode };
type Mode = 'read' | 'selected' | 'list' | 'open' | 'answer' | 'next';
type Scope = { coupleId: string; membershipEpoch: number; commandId?: string; roundId?: string; answer?: string;
  questionId?: string; catalogVersion?: number; expectedPredecessorRoundId?: string };
type Row = { id: string; couple_id: string; membership_epoch: number; question_id: string; catalog_version: number;
  participant_one: string; participant_two: string; predecessor_round_id: string | null };
const columns = 'id,couple_id,membership_epoch,question_id,catalog_version,participant_one,participant_two,predecessor_round_id';
const fail = (error: ErrorCode): { ok: false; error: ErrorCode } => ({ ok: false, error });
function parse(input: unknown, mode: Mode): Scope | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const f = input as Record<string, unknown>;
  const keys = mode === 'read' || mode === 'list' ? 'coupleId,membershipEpoch' : mode === 'selected'
    ? 'coupleId,membershipEpoch,roundId' : mode === 'open'
    ? 'catalogVersion,commandId,coupleId,membershipEpoch,questionId' : mode === 'next'
    ? 'catalogVersion,commandId,confirm,coupleId,expectedPredecessorRoundId,membershipEpoch,questionId'
    : 'answer,catalogVersion,commandId,confirm,coupleId,membershipEpoch,questionId,roundId';
  if (Object.keys(f).sort().join(',') !== keys || !isUuid(f.coupleId) || !isEpoch(f.membershipEpoch)) return null;
  const scope: Scope = { coupleId: f.coupleId.toLowerCase(), membershipEpoch: f.membershipEpoch };
  if (mode === 'read' || mode === 'list') return scope;
  if (mode === 'selected') return isUuid(f.roundId) ? { ...scope, roundId: f.roundId.toLowerCase() } : null;
  const question = findBlindQuestion(f.questionId, f.catalogVersion);
  if (!isUuid(f.commandId) || !question || (mode === 'open' && question.id !== blindQuestion.id)) return null;
  Object.assign(scope, { commandId: f.commandId.toLowerCase(), questionId: question.id, catalogVersion: question.catalogVersion });
  if (mode === 'open') return scope;
  if (mode === 'next') return isUuid(f.expectedPredecessorRoundId) && f.confirm === true
    ? { ...scope, expectedPredecessorRoundId: f.expectedPredecessorRoundId.toLowerCase() } : null;
  const answer = normalizeAnswer(f.answer);
  return isUuid(f.roundId) && f.confirm === true && answer.ok
    ? { ...scope, roundId: f.roundId.toLowerCase(), answer: answer.text } : null;
}
/** Query own body separately. The partner-body query is not issued before both submissions exist. */
async function project(tx: SqlExecutor, row: Row, actor: string): Promise<BlindRound> {
  const own = (await tx.query<{ body: string }>('SELECT body FROM blind_answers WHERE round_id=$1 AND author_id=$2', [row.id, actor])).rows[0];
  const authors = (await tx.query<{ author_id: string }>('SELECT author_id FROM blind_answers WHERE round_id=$1', [row.id])).rows;
  const revealed = authors.length === 2 && authors.some(a => a.author_id === row.participant_one)
    && authors.some(a => a.author_id === row.participant_two);
  let partnerAnswer: string | null = null;
  if (revealed) {
    const partner = actor === row.participant_one ? row.participant_two : row.participant_one;
    partnerAnswer = (await tx.query<{ body: string }>('SELECT body FROM blind_answers WHERE round_id=$1 AND author_id=$2', [row.id, partner])).rows[0].body;
  }
  return { id: row.id, coupleId: row.couple_id, membershipEpoch: row.membership_epoch,
    questionId: row.question_id, catalogVersion: row.catalog_version, ownAnswer: own?.body ?? null, partnerAnswer, revealed };
}
type Value = { round?: BlindRound | null; commandId?: string; replay?: boolean; created?: boolean;
  currentRoundId?: string | null; rounds?: { id: string; questionId: string; catalogVersion: number }[]; limit?: number };
async function run(db: AuthorizedDatabase, principal: Principal, input: unknown, mode: Mode): Promise<Result<Value>> {
  if (!validPrincipal(principal)) return fail('unavailable');
  const scope = parse(input, mode);
  if (!scope) return fail('invalid_request');
  return db.transaction(async tx => {
    const pair = await lockPair(tx, db, principal, scope.coupleId);
    if (typeof pair === 'string') return fail('unavailable');
    const participants = pair.members.filter(m => m.status === 'active').map(m => m.user_id).sort();
    if (pair.status !== 'active' || participants.length !== 2 || !participants.includes(principal.userId)) return fail('unavailable');
    if (pair.epoch !== scope.membershipEpoch) return fail('stale_membership');
    const authorized = (row: Row) => row.couple_id === scope.coupleId && row.membership_epoch === scope.membershipEpoch
      && row.participant_one === participants[0] && row.participant_two === participants[1];
    const lookup = async (id: string) => (await tx.query<Row>(`SELECT ${columns} FROM blind_rounds WHERE id=$1`, [id])).rows[0];
    if (mode === 'list') {
      const rows = (await tx.query<Row>(`WITH RECURSIVE history AS (
        SELECT r.*, 1 AS depth FROM blind_rounds r WHERE couple_id=$1 AND membership_epoch=$2 AND predecessor_round_id IS NULL
        UNION ALL SELECT r.*, h.depth+1 FROM blind_rounds r JOIN history h ON r.predecessor_round_id=h.id
        WHERE r.couple_id=$1 AND r.membership_epoch=$2)
        SELECT ${columns} FROM history ORDER BY depth DESC LIMIT 10`, [scope.coupleId, scope.membershipEpoch])).rows;
      if (rows.some(row => !authorized(row))) return fail('unavailable');
      return { ok: true, value: { currentRoundId: rows[0]?.id ?? null, rounds: rows.map(row => ({
        id: row.id, questionId: row.question_id, catalogVersion: row.catalog_version })), limit: 10 } };
    }
    if (mode === 'open' || mode === 'answer' || mode === 'next') {
      const receipt = (await tx.query<{ round_id: string; operation: string }>(
        'SELECT round_id,operation FROM blind_commands WHERE actor_user_id=$1 AND command_id=$2', [principal.userId, scope.commandId])).rows[0];
      if (receipt) {
        const target = await lookup(receipt.round_id);
        if (!target || !authorized(target) || receipt.operation !== mode || target.question_id !== scope.questionId
          || target.catalog_version !== scope.catalogVersion || (mode === 'answer' && scope.roundId !== target.id)
          || (mode === 'next' && scope.expectedPredecessorRoundId !== target.predecessor_round_id)) return fail('idempotency_conflict');
        if (mode === 'answer') {
          const own = (await tx.query<{ body: string }>('SELECT body FROM blind_answers WHERE round_id=$1 AND author_id=$2', [target.id, principal.userId])).rows[0];
          if (!own || own.body !== scope.answer) return fail('idempotency_conflict');
        }
        return { ok: true, value: { round: await project(tx, target, principal.userId), commandId: scope.commandId!, replay: true } };
      }
    }
    let row = scope.roundId ? await lookup(scope.roundId) : (await tx.query<Row>(
      `SELECT ${columns} FROM blind_rounds r WHERE couple_id=$1 AND membership_epoch=$2 AND ${mode === 'next'
        ? 'NOT EXISTS (SELECT 1 FROM blind_rounds child WHERE child.predecessor_round_id=r.id)'
        : 'predecessor_round_id IS NULL'}`, [scope.coupleId, scope.membershipEpoch])).rows[0];
    if (row && !authorized(row)) return fail('unavailable');
    if (mode === 'selected' && !row) return fail('unavailable');
    if (mode === 'read' || mode === 'selected') return { ok: true, value: { round: row ? await project(tx, row, principal.userId) : null } };
    if (mode === 'next') {
      if (!row || row.id !== scope.expectedPredecessorRoundId) return fail('round_conflict');
      const authors = (await tx.query<{ author_id: string }>('SELECT author_id FROM blind_answers WHERE round_id=$1', [row.id])).rows;
      if (authors.length !== 2 || !participants.every(id => authors.some(a => a.author_id === id))) return fail('round_conflict');
    }
    const created = mode === 'next' || (mode === 'open' && !row);
    if (created) {
      row = (await tx.query<Row>(`INSERT INTO blind_rounds(couple_id,membership_epoch,question_id,catalog_version,participant_one,participant_two,predecessor_round_id)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING ${columns}`, [scope.coupleId, scope.membershipEpoch,
        scope.questionId, scope.catalogVersion, ...participants, scope.expectedPredecessorRoundId ?? null])).rows[0];
    }
    if (!row) return fail('unavailable');
    if (mode === 'answer') {
      if (row.question_id !== scope.questionId || row.catalog_version !== scope.catalogVersion) return fail('invalid_request');
      const existing = await tx.query('SELECT author_id FROM blind_answers WHERE round_id=$1 AND author_id=$2', [row.id, principal.userId]);
      if (existing.rows.length) return fail('already_submitted');
      await tx.query('INSERT INTO blind_answers(round_id,author_id,body) VALUES($1,$2,$3)', [row.id, principal.userId, scope.answer]);
    }
    await tx.query('INSERT INTO blind_commands(actor_user_id,command_id,round_id,operation) VALUES($1,$2,$3,$4)',
      [principal.userId, scope.commandId, row.id, mode]);
    return { ok: true, value: { round: await project(tx, row, principal.userId), commandId: scope.commandId!, replay: false, created } };
  });
}
export const readBlindRound = (db: AuthorizedDatabase, principal: Principal, input: unknown) => run(db, principal, input, 'read');
export const openBlindRound = (db: AuthorizedDatabase, principal: Principal, input: unknown) => run(db, principal, input, 'open');
export const submitBlindAnswer = (db: AuthorizedDatabase, principal: Principal, input: unknown) => run(db, principal, input, 'answer');
export const listBlindRounds = (db: AuthorizedDatabase, principal: Principal, input: unknown) => run(db, principal, input, 'list');
export const readSelectedBlindRound = (db: AuthorizedDatabase, principal: Principal, input: unknown) => run(db, principal, input, 'selected');
export const nextBlindRound = (db: AuthorizedDatabase, principal: Principal, input: unknown) => run(db, principal, input, 'next');
