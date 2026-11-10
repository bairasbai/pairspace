import { blindQuestion } from '../../../packages/domain/blind/catalog.ts';
import { normalizeAnswer } from '../../../packages/domain/blind/answer.ts';
import type { AuthorizedDatabase, Principal, SqlExecutor } from './contracts.ts';
import { lockPair } from './pair-close.ts';
import { validPrincipal } from './session.ts';
import { isEpoch, isUuid } from './validation.ts';
export type BlindRound = Readonly<{ id: string; coupleId: string; membershipEpoch: number; questionId: string;
  catalogVersion: number; ownAnswer: string | null; partnerAnswer: string | null; revealed: boolean }>;
type ErrorCode = 'invalid_request' | 'unavailable' | 'stale_membership' | 'idempotency_conflict' | 'already_submitted';
type Result<T> = { ok: true; value: T } | { ok: false; error: ErrorCode };
type Mode = 'read' | 'open' | 'answer';
type Scope = { coupleId: string; membershipEpoch: number; commandId?: string; roundId?: string; answer?: string };
type Row = { id: string; couple_id: string; membership_epoch: number; question_id: string; catalog_version: number;
  participant_one: string; participant_two: string };
const columns = 'id,couple_id,membership_epoch,question_id,catalog_version,participant_one,participant_two';
const fail = (error: ErrorCode): { ok: false; error: ErrorCode } => ({ ok: false, error });
function parse(input: unknown, mode: Mode): Scope | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const f = input as Record<string, unknown>;
  const keys = mode === 'read' ? 'coupleId,membershipEpoch' : mode === 'open'
    ? 'catalogVersion,commandId,coupleId,membershipEpoch,questionId'
    : 'answer,catalogVersion,commandId,confirm,coupleId,membershipEpoch,questionId,roundId';
  if (Object.keys(f).sort().join(',') !== keys || !isUuid(f.coupleId) || !isEpoch(f.membershipEpoch)) return null;
  const scope: Scope = { coupleId: f.coupleId.toLowerCase(), membershipEpoch: f.membershipEpoch };
  if (mode === 'read') return scope;
  if (!isUuid(f.commandId) || f.questionId !== blindQuestion.id || f.catalogVersion !== blindQuestion.catalogVersion) return null;
  scope.commandId = f.commandId.toLowerCase();
  if (mode === 'open') return scope;
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
type Value = { round: BlindRound | null; commandId?: string; replay?: boolean; created?: boolean };
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
    let row = (await tx.query<Row>(`SELECT ${columns} FROM blind_rounds WHERE couple_id=$1 AND membership_epoch=$2`,
      [scope.coupleId, scope.membershipEpoch])).rows[0];
    if (row && (row.participant_one !== participants[0] || row.participant_two !== participants[1])) return fail('unavailable');
    if (mode === 'read') return { ok: true, value: { round: row ? await project(tx, row, principal.userId) : null } };
    const receipt = (await tx.query<{ round_id: string; operation: string }>(
      'SELECT round_id,operation FROM blind_commands WHERE actor_user_id=$1 AND command_id=$2', [principal.userId, scope.commandId])).rows[0];
    if (receipt) {
      if (!row || receipt.round_id !== row.id || receipt.operation !== mode || (mode === 'answer' && scope.roundId !== row.id)) return fail('idempotency_conflict');
      if (mode === 'answer') {
        const own = (await tx.query<{ body: string }>('SELECT body FROM blind_answers WHERE round_id=$1 AND author_id=$2', [row.id, principal.userId])).rows[0];
        if (!own || own.body !== scope.answer) return fail('idempotency_conflict');
      }
      return { ok: true, value: { round: await project(tx, row, principal.userId), commandId: scope.commandId!, replay: true } };
    }
    const created = mode === 'open' && !row;
    if (created) {
      row = (await tx.query<Row>(`INSERT INTO blind_rounds(couple_id,membership_epoch,question_id,catalog_version,participant_one,participant_two)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING ${columns}`, [scope.coupleId, scope.membershipEpoch,
        blindQuestion.id, blindQuestion.catalogVersion, ...participants])).rows[0];
    }
    if (!row || (mode === 'answer' && row.id !== scope.roundId)) return fail('unavailable');
    if (mode === 'answer') {
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
