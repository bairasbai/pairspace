import { createHash } from 'node:crypto';
import { canonicalDailyDate } from '../../../packages/domain/daily-question/catalog.ts';
import { validDailySlot, type DailySlot, type DailyScope } from '../../../packages/domain/daily-question/slot.ts';
import { validDailyAnswerMetadata, type DailyAnswerMetadata } from '../../../packages/domain/daily-question/metadata.ts';
import { normalizeDailyAnswerText, count, record, exact } from '../../../packages/domain/daily-question/validation.ts';
import type { AuthorizedDatabase, Principal, SqlExecutor } from './contracts.ts';
import { lockPair } from './pair-close.ts';
import { activeSession } from './session.ts';
import { isEpoch, isUuid } from './validation.ts';
export type DailyQuestionClock = () => Date;
export type DailyQuestionTimezoneResolver = (coupleId: string, epoch: number) => string;
export type Code = 'invalid_request' | 'unavailable' | 'stale_membership' | 'idempotency_conflict' | 'version_conflict' | 'day_changed';
export type Failure = { ok: false; error: Code };
export type Result<T> = { ok: true; value: T } | Failure;
export type Mode = 'list' | 'read' | 'create' | 'rewrite' | 'remove';
export type Scope = { coupleId: string; membershipEpoch: number; answerId?: string; commandId?: string;
  expectedVersion?: number; expectedDay?: string; text?: string; beforeDay?: string | null };
export type SlotRow = { id: string; couple_id: string; membership_epoch: number; participant_a: string; participant_b: string;
  day: string; timezone: string; catalog_version: string; prompt_id: string; prompt_ru: string; prompt_en: string; created_at: string };
export type AnswerRow = { id: string; slot_id: string; couple_id: string; membership_epoch: number; author_id: string;
  version: number; created_at: string; edited_at: string; content_state: string; removed_at: string | null };
export const slotColumns = 'id,couple_id,membership_epoch,participant_a,participant_b,day::text,timezone,catalog_version,prompt_id,prompt_ru,prompt_en,created_at::text';
export const answerColumns = 'id,slot_id,couple_id,membership_epoch,author_id,version,created_at::text,edited_at::text,content_state,removed_at::text';
export const fail = (error: Code): Failure => ({ ok: false, error });
export const ended = new Error('daily_question_session_or_clock_ended');
export const actorScope = (scope: Scope, p: Principal): DailyScope => ({ coupleId: scope.coupleId, membershipEpoch: scope.membershipEpoch, userId: p.userId });
export function clockNow(db: AuthorizedDatabase, clock?: DailyQuestionClock): string {
  const value = (clock ?? (() => db.now()))();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw Error('invalid_daily_question_clock');
  return value.toISOString();
}
export function slotMetadata(row: SlotRow, scope: DailyScope): DailySlot {
  const slot = { id: row.id, coupleId: row.couple_id, membershipEpoch: row.membership_epoch,
    participantIds: [row.participant_a, row.participant_b], day: row.day, timezone: row.timezone,
    catalogVersion: row.catalog_version, promptId: row.prompt_id, promptRU: row.prompt_ru,
    promptEN: row.prompt_en, createdAt: new Date(row.created_at).toISOString() };
  if (!validDailySlot(slot, scope)) throw Error('invalid_daily_question_slot');
  return slot;
}
export function answerMetadata(row: AnswerRow, slot: DailySlot, scope: DailyScope): DailyAnswerMetadata {
  const value = { id: row.id, slotId: row.slot_id, coupleId: row.couple_id, membershipEpoch: row.membership_epoch,
    authorId: row.author_id, version: row.version, createdAt: new Date(row.created_at).toISOString(),
    editedAt: new Date(row.edited_at).toISOString(), contentState: row.content_state,
    removedAt: row.removed_at === null ? null : new Date(row.removed_at).toISOString() };
  if (!validDailyAnswerMetadata(value, slot, scope)) throw Error('invalid_daily_question_answer');
  return value;
}
export const latest = (value: DailyAnswerMetadata) => value.removedAt ?? value.editedAt;
export function parse(input: unknown, mode: Mode): Scope | null {
  if (!record(input)) return null;
  const reading = mode === 'list' || mode === 'read', creating = mode === 'create';
  const keys = 'coupleId,membershipEpoch' + (mode === 'list' ? ',beforeDay' : creating ? '' : ',answerId')
    + (reading ? '' : ',commandId,confirm') + (!reading && !creating ? ',expectedVersion' : '')
    + (creating ? ',expectedDay,text' : mode === 'rewrite' ? ',text' : '');
  if (!exact(input, keys) || !isUuid(input.coupleId) || !isEpoch(input.membershipEpoch)) return null;
  const scope: Scope = { coupleId: input.coupleId.toLowerCase(), membershipEpoch: input.membershipEpoch };
  if (mode === 'list') {
    if (input.beforeDay !== null && !canonicalDailyDate(input.beforeDay)) return null;
    scope.beforeDay = input.beforeDay as string | null;
  } else if (!creating) {
    if (!isUuid(input.answerId)) return null;
    scope.answerId = input.answerId.toLowerCase();
  }
  if (!reading) {
    if (!isUuid(input.commandId) || input.confirm !== true) return null;
    scope.commandId = input.commandId.toLowerCase();
    if (!creating) { if (!count(input.expectedVersion)) return null; scope.expectedVersion = input.expectedVersion; }
  }
  if (creating || mode === 'rewrite') {
    const text = normalizeDailyAnswerText(input.text);
    if (text === null) return null;
    scope.text = text;
  }
  if (creating) { if (!canonicalDailyDate(input.expectedDay)) return null; scope.expectedDay = input.expectedDay; }
  return scope;
}
export async function authorize(tx: SqlExecutor, db: AuthorizedDatabase, p: Principal, scope: Scope): Promise<Failure | { participantIds: [string, string] }> {
  const pair = await lockPair(tx, db, p, scope.coupleId);
  if (typeof pair === 'string') return fail('unavailable');
  const members = pair.members.filter(member => member.status === 'active').map(member => member.user_id).sort();
  if (pair.status !== 'active' || members.length !== 2 || !members.includes(p.userId)) return fail('unavailable');
  return pair.epoch !== scope.membershipEpoch ? fail('stale_membership') : { participantIds: [members[0], members[1]] };
}
export async function checkpoint(tx: SqlExecutor, db: AuthorizedDatabase, p: Principal, floor: string,
  clock?: DailyQuestionClock): Promise<string | null> {
  if (!await activeSession(tx, db, p)) return null;
  const at = clockNow(db, clock);
  return at >= floor ? at : null;
}
export async function selectAnswer(tx: SqlExecutor, scope: Scope, id: string): Promise<AnswerRow | undefined> {
  return (await tx.query<AnswerRow>(`SELECT ${answerColumns} FROM daily_question_answers WHERE couple_id=$1 AND membership_epoch=$2 AND id=$3 FOR UPDATE`,
    [scope.coupleId, scope.membershipEpoch, id])).rows[0];
}
export async function selectSlot(tx: SqlExecutor, scope: Scope, id: string): Promise<SlotRow | undefined> {
  return (await tx.query<SlotRow>(`SELECT ${slotColumns} FROM daily_question_slots WHERE couple_id=$1 AND membership_epoch=$2 AND id=$3 FOR UPDATE`,
    [scope.coupleId, scope.membershipEpoch, id])).rows[0];
}
export const fingerprint = (scope: Scope, mode: Mode) => createHash('sha256').update(JSON.stringify([
  mode, scope.coupleId, scope.membershipEpoch, scope.answerId ?? null, scope.expectedVersion ?? null,
  scope.expectedDay ?? null, scope.text ?? null, true])).digest('hex');
export function canonicalZone(value: unknown): string {
  if (typeof value !== 'string' || value.length > 100) throw Error('invalid_daily_question_zone');
  try { return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone; }
  catch { throw Error('invalid_daily_question_zone'); }
}
