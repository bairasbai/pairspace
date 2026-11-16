import { randomUUID } from 'node:crypto';
import { dailyPrompt } from '../../../packages/domain/daily-question/catalog.ts';
import { createDailySlot, validDailySlot, type DailySlot } from '../../../packages/domain/daily-question/slot.ts';
import { followsDailyAnswerMetadata, rewriteDailyAnswerMetadata, removeDailyAnswerMetadata,
  validDailyAnswerMetadata, type DailyAnswerMetadata } from '../../../packages/domain/daily-question/metadata.ts';
import { canReadDailyAnswer, validDailyAnswer, type DailyAnswer } from '../../../packages/domain/daily-question/policy.ts';
import { localDay, normalizeDailyAnswerText } from '../../../packages/domain/daily-question/validation.ts';
import type { AuthorizedDatabase, Principal, SqlExecutor } from './contracts.ts';
import { validPrincipal } from './session.ts';
import { actorScope, answerColumns, answerMetadata, authorize, canonicalZone, checkpoint, clockNow, ended, fail,
  fingerprint, latest, parse, selectAnswer, selectSlot, slotColumns, slotMetadata, type AnswerRow, type DailyQuestionClock,
  type DailyQuestionTimezoneResolver, type Result, type Scope, type SlotRow } from './daily-questions-state.ts';
export type { DailyQuestionClock, DailyQuestionTimezoneResolver } from './daily-questions-state.ts';
type Mutation = 'create' | 'rewrite' | 'remove';
type Receipt = { fingerprint: string; answer_id: string; operation: Mutation; applied: unknown; slot: unknown };
type Ack = { slot: DailySlot; answer: DailyAnswerMetadata; commandId: string; replay: boolean; checkedAt: string };
type Descriptor = { day: string; timezone: string; catalogVersion: string; promptId: string; promptRU: string; promptEN: string };
type History = { slots: { slot: DailySlot; answers: DailyAnswerMetadata[] }[]; today: Descriptor; checkedAt: string; hasMore: boolean; nextBeforeDay: string | null };
async function zone(tx: SqlExecutor, scope: Scope, resolver?: DailyQuestionTimezoneResolver): Promise<string> {
  const rows = (await tx.query<{ timezone: string }>('SELECT timezone FROM daily_question_zones WHERE couple_id=$1 AND membership_epoch=$2',
    [scope.coupleId, scope.membershipEpoch])).rows;
  if (rows.length > 1) throw Error('invalid_daily_question_zone');
  const value = rows.length ? rows[0].timezone : (resolver ?? (() => 'UTC'))(scope.coupleId, scope.membershipEpoch);
  const canonical = canonicalZone(value);
  if (rows.length && canonical !== value) throw Error('invalid_daily_question_zone');
  return canonical;
}
function descriptor(at: string, timezone: string): Descriptor {
  const day = localDay(at, timezone), prompt = dailyPrompt(day);
  if (!prompt) throw Error('invalid_daily_question_day');
  return { day, timezone, ...prompt };
}
export async function listDailyQuestions(db: AuthorizedDatabase, p: Principal, input: unknown,
  clock?: DailyQuestionClock, timezoneResolver?: DailyQuestionTimezoneResolver): Promise<Result<History>> {
  if (!validPrincipal(p)) return fail('unavailable');
  const scope = parse(input, 'list'); if (!scope) return fail('invalid_request');
  return db.transaction(async tx => {
    const auth = await authorize(tx, db, p, scope); if ('ok' in auth) return auth;
    const started = clockNow(db, clock), timezone = await zone(tx, scope, timezoneResolver);
    const rows = (await tx.query<SlotRow>(`SELECT ${slotColumns} FROM daily_question_slots WHERE couple_id=$1 AND membership_epoch=$2
      AND ($3::date IS NULL OR day<$3::date) ORDER BY day DESC LIMIT 101`, [scope.coupleId, scope.membershipEpoch, scope.beforeDay])).rows;
    const slots: History['slots'] = [];
    const actor = actorScope(scope, p);
    for (const row of rows.slice(0, 100)) {
      const slot = slotMetadata(row, actor);
      const answers = (await tx.query<AnswerRow>(`SELECT ${answerColumns} FROM daily_question_answers WHERE couple_id=$1 AND membership_epoch=$2 AND slot_id=$3 ORDER BY author_id`,
        [scope.coupleId, scope.membershipEpoch, slot.id])).rows.map(answer => answerMetadata(answer, slot, actor));
      if (answers.length > 2 || new Set(answers.map(answer => answer.authorId)).size !== answers.length) throw Error('invalid_daily_question_history');
      slots.push({ slot, answers });
    }
    const checkedAt = await checkpoint(tx, db, p, started, clock);
    if (!checkedAt || slots.some(({ slot, answers }) => slot.createdAt > checkedAt || slot.day > localDay(checkedAt, slot.timezone) || answers.some(answer => latest(answer) > checkedAt))) return fail('unavailable');
    return { ok: true, value: { slots, today: descriptor(checkedAt, timezone), checkedAt, hasMore: rows.length > 100,
      nextBeforeDay: rows.length > 100 ? slots[slots.length - 1].slot.day : null } };
  });
}
async function body(tx: SqlExecutor, scope: Scope, answer: DailyAnswerMetadata, slot: DailySlot, p: Principal): Promise<DailyAnswer> {
  const result = await tx.query<{ text: unknown }>('SELECT text FROM daily_question_answers WHERE couple_id=$1 AND membership_epoch=$2 AND id=$3 AND author_id=$4',
    [scope.coupleId, scope.membershipEpoch, answer.id, answer.authorId]);
  const text = result.rows[0]?.text, value = { ...answer, text };
  if (result.rows.length !== 1 || typeof text !== 'string' || normalizeDailyAnswerText(text) !== text
    || !validDailyAnswer(value, slot, actorScope(scope, p))) throw Error('invalid_daily_question_body');
  return value;
}
export async function readDailyAnswer(db: AuthorizedDatabase, p: Principal, input: unknown,
  clock?: DailyQuestionClock, _timezoneResolver?: DailyQuestionTimezoneResolver): Promise<Result<{ slot: DailySlot; answer: DailyAnswerMetadata; checkedAt: string; text?: string }>> {
  void _timezoneResolver; // Reads use the immutable stored slot, never current configuration.
  if (!validPrincipal(p)) return fail('unavailable');
  const scope = parse(input, 'read'); if (!scope) return fail('invalid_request');
  return db.transaction(async tx => {
    const auth = await authorize(tx, db, p, scope); if ('ok' in auth) return auth;
    const started = clockNow(db, clock), row = await selectAnswer(tx, scope, scope.answerId!);
    if (!row || !await checkpoint(tx, db, p, started, clock)) return fail('unavailable');
    const slotRow = await selectSlot(tx, scope, row.slot_id);
    let at = await checkpoint(tx, db, p, started, clock);
    if (!slotRow || !at) return fail('unavailable');
    const actor = actorScope(scope, p), slot = slotMetadata(slotRow, actor), answer = answerMetadata(row, slot, actor);
    if (at < latest(answer) || localDay(at, slot.timezone) < slot.day) return fail('unavailable');
    let own: DailyAnswer | null = null, target: DailyAnswer | null = null;
    const today = localDay(at, slot.timezone);
    if (answer.contentState === 'active' && today >= slot.day) {
      if (answer.authorId !== p.userId && today === slot.day) {
        const ownRows = (await tx.query<AnswerRow>(`SELECT ${answerColumns} FROM daily_question_answers WHERE couple_id=$1 AND membership_epoch=$2 AND slot_id=$3 AND author_id=$4 FOR UPDATE`,
          [scope.coupleId, scope.membershipEpoch, slot.id, p.userId])).rows;
        const checked = await checkpoint(tx, db, p, at, clock);
        if (!checked) return fail('unavailable');
        at = checked;
        if (ownRows.length > 1) throw Error('invalid_daily_question_own');
        if (ownRows.length) {
          const ownMetadata = answerMetadata(ownRows[0], slot, actor);
          if (latest(ownMetadata) > at) return fail('unavailable');
          if (ownMetadata.contentState === 'active') own = await body(tx, scope, ownMetadata, slot, p);
        }
      }
      const beforeBody = await checkpoint(tx, db, p, at, clock);
      if (!beforeBody) return fail('unavailable');
      at = beforeBody;
      // No partner body SELECT until real, canonical own body has passed today's gate.
      if (localDay(at, slot.timezone) >= slot.day
        && (answer.authorId === p.userId || localDay(at, slot.timezone) > slot.day || own !== null)) {
        target = await body(tx, scope, answer, slot, p);
      }
    }
    const checkedAt = await checkpoint(tx, db, p, at, clock);
    if (!checkedAt || localDay(checkedAt, slot.timezone) < slot.day || (target && !canReadDailyAnswer(target, own, slot, actor, checkedAt))) return fail('unavailable');
    return { ok: true, value: { slot, answer, checkedAt, ...(target?.contentState === 'active' ? { text: target.text } : {}) } };
  });
}
export const createDailyAnswer = (db: AuthorizedDatabase, p: Principal, input: unknown, clock?: DailyQuestionClock, resolver?: DailyQuestionTimezoneResolver) => mutate(db, p, input, 'create', clock, resolver);
export const rewriteDailyAnswer = (db: AuthorizedDatabase, p: Principal, input: unknown, clock?: DailyQuestionClock, resolver?: DailyQuestionTimezoneResolver) => mutate(db, p, input, 'rewrite', clock, resolver);
export const removeDailyAnswer = (db: AuthorizedDatabase, p: Principal, input: unknown, clock?: DailyQuestionClock, resolver?: DailyQuestionTimezoneResolver) => mutate(db, p, input, 'remove', clock, resolver);
function proves(answer: DailyAnswerMetadata, slot: DailySlot, scope: Scope, p: Principal, mode: Mutation): boolean {
  if (answer.authorId !== p.userId) return false;
  if (mode === 'create') return answer.version === 1 && answer.contentState === 'active' && slot.day === scope.expectedDay;
  return answer.id === scope.answerId && answer.version === scope.expectedVersion! + 1
    && answer.contentState === (mode === 'remove' ? 'removed' : 'active');
}
async function mutate(db: AuthorizedDatabase, p: Principal, input: unknown, mode: Mutation,
  clock?: DailyQuestionClock, resolver?: DailyQuestionTimezoneResolver): Promise<Result<Ack>> {
  if (!validPrincipal(p)) return fail('unavailable');
  const scope = parse(input, mode); if (!scope) return fail('invalid_request');
  const actor = actorScope(scope, p), hash = fingerprint(scope, mode);
  try {
    return await db.transaction(async tx => {
      const auth = await authorize(tx, db, p, scope); if ('ok' in auth) return auth;
      let at = clockNow(db, clock);
      const previous = (await tx.query<Receipt>('SELECT fingerprint,answer_id,operation,applied,slot FROM daily_question_commands WHERE actor_user_id=$1 AND command_id=$2',
        [p.userId, scope.commandId])).rows[0];
      const afterReceipt = await checkpoint(tx, db, p, at, clock); if (!afterReceipt) return fail('unavailable'); at = afterReceipt;
      if (previous) {
        if (previous.fingerprint !== hash) return fail('idempotency_conflict');
        const row = await selectAnswer(tx, scope, previous.answer_id);
        const afterAnswer = await checkpoint(tx, db, p, at, clock); if (!row || !afterAnswer) return fail('unavailable'); at = afterAnswer;
        const slotRow = await selectSlot(tx, scope, row.slot_id);
        const checkedAt = await checkpoint(tx, db, p, at, clock); if (!slotRow || !checkedAt) return fail('unavailable');
        const slot = slotMetadata(slotRow, actor), answer = answerMetadata(row, slot, actor);
        if (previous.operation !== mode || !validDailySlot(previous.slot, actor)
          || Object.keys(slot).some(key =>
            JSON.stringify(slot[key as keyof DailySlot]) !== JSON.stringify((previous.slot as DailySlot)[key as keyof DailySlot]))
          || !validDailyAnswerMetadata(previous.applied, slot, actor) || !proves(previous.applied, slot, scope, p, mode)
          || !followsDailyAnswerMetadata(previous.applied, answer, slot, actor)) throw Error('invalid_daily_question_replay');
        if (latest(answer) > checkedAt || localDay(checkedAt, slot.timezone) < slot.day) return fail('unavailable');
        return { ok: true, value: { slot, answer, commandId: scope.commandId!, replay: true, checkedAt } };
      }
      let slot: DailySlot, row: AnswerRow, wrote = false;
      if (mode === 'create') {
        const timezone = await zone(tx, scope, resolver), snapshot = descriptor(at, timezone);
        if (snapshot.day !== scope.expectedDay) return fail('day_changed');
        let slotRow = (await tx.query<SlotRow>(`SELECT ${slotColumns} FROM daily_question_slots WHERE couple_id=$1 AND membership_epoch=$2 AND day=$3 FOR UPDATE`,
          [scope.coupleId, scope.membershipEpoch, snapshot.day])).rows[0];
        const beforeWrite = await checkpoint(tx, db, p, at, clock);
        if (!beforeWrite) return fail('unavailable'); at = beforeWrite;
        if (localDay(at, timezone) !== scope.expectedDay) return fail('day_changed');
        if (!slotRow) {
          const proposed = createDailySlot({ id: randomUUID(), participantIds: auth.participantIds, timezone }, actor, at);
          if (!proposed) throw Error('invalid_daily_question_slot');
          await tx.query('INSERT INTO daily_question_zones(couple_id,membership_epoch,timezone) VALUES($1,$2,$3) ON CONFLICT(couple_id,membership_epoch) DO NOTHING',
            [scope.coupleId, scope.membershipEpoch, timezone]); wrote = true;
          const rows = (await tx.query<SlotRow>(`INSERT INTO daily_question_slots(id,couple_id,membership_epoch,participant_a,participant_b,day,timezone,catalog_version,prompt_id,prompt_ru,prompt_en,created_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING ${slotColumns}`,
          [proposed.id, scope.coupleId, scope.membershipEpoch, ...auth.participantIds, proposed.day, timezone, proposed.catalogVersion, proposed.promptId, proposed.promptRU, proposed.promptEN, at])).rows;
          if (rows.length !== 1) throw Error('invalid_daily_question_write');
          slotRow = rows[0];
        }
        slot = slotMetadata(slotRow, actor);
        const current = (await tx.query<AnswerRow>(`SELECT ${answerColumns} FROM daily_question_answers WHERE slot_id=$1 AND author_id=$2 FOR UPDATE`, [slot.id, p.userId])).rows;
        const ready = await checkpoint(tx, db, p, at, clock);
        if (!ready || localDay(ready, slot.timezone) !== slot.day) { if (wrote) throw ended; return fail('unavailable'); }
        at = ready;
        if (current.length) { if (wrote) throw Error('invalid_daily_question_slot'); return fail('version_conflict'); }
        const rows = (await tx.query<AnswerRow>(`INSERT INTO daily_question_answers(slot_id,couple_id,membership_epoch,author_id,version,created_at,edited_at,content_state,removed_at,text)
          VALUES($1,$2,$3,$4,1,$5,$5,'active',NULL,$6) RETURNING ${answerColumns}`, [slot.id, scope.coupleId, scope.membershipEpoch, p.userId, at, scope.text])).rows;
        if (rows.length !== 1) throw Error('invalid_daily_question_write'); row = rows[0];
      } else {
        const previousRow = await selectAnswer(tx, scope, scope.answerId!);
        const afterAnswer = await checkpoint(tx, db, p, at, clock); if (!previousRow || !afterAnswer) return fail('unavailable'); at = afterAnswer;
        const slotRow = await selectSlot(tx, scope, previousRow.slot_id);
        const beforeWrite = await checkpoint(tx, db, p, at, clock); if (!slotRow || !beforeWrite) return fail('unavailable'); at = beforeWrite;
        slot = slotMetadata(slotRow, actor);
        const before = answerMetadata(previousRow, slot, actor);
        if (before.authorId !== p.userId) return fail('unavailable');
        if (latest(before) > at) return fail('unavailable');
        const next = mode === 'rewrite' ? rewriteDailyAnswerMetadata(before, slot, actor, at, scope.expectedVersion!, true)
          : removeDailyAnswerMetadata(before, slot, actor, at, scope.expectedVersion!, true);
        if (!next) return fail('version_conflict');
        const rows = (await tx.query<AnswerRow>(`UPDATE daily_question_answers SET version=$2,edited_at=$3,content_state=$4,removed_at=$5,text=$6 WHERE id=$1 RETURNING ${answerColumns}`,
          [before.id, next.version, next.editedAt, next.contentState, next.removedAt, mode === 'remove' ? null : scope.text])).rows;
        if (rows.length !== 1) throw Error('invalid_daily_question_write'); row = rows[0];
      }
      const answer = answerMetadata(row, slot, actor);
      if (!proves(answer, slot, scope, p, mode)) throw Error('invalid_daily_question_applied');
      const receipt = (await tx.query<Receipt>(`INSERT INTO daily_question_commands(actor_user_id,command_id,couple_id,membership_epoch,answer_id,fingerprint,operation,expected_version,applied,slot)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb) RETURNING fingerprint,answer_id,operation,applied,slot`,
        [p.userId, scope.commandId, scope.coupleId, scope.membershipEpoch, answer.id, hash, mode, scope.expectedVersion ?? null, JSON.stringify(answer), JSON.stringify(slot)])).rows;
      if (receipt.length !== 1 || receipt[0].fingerprint !== hash || receipt[0].answer_id !== answer.id || receipt[0].operation !== mode
        || !followsDailyAnswerMetadata(answer, receipt[0].applied, slot, actor)
        || !followsDailyAnswerMetadata(receipt[0].applied, answer, slot, actor)
        || !validDailySlot(receipt[0].slot, actor)
        || Object.keys(slot).some(key => JSON.stringify(slot[key as keyof DailySlot]) !== JSON.stringify((receipt[0].slot as DailySlot)[key as keyof DailySlot]))) throw Error('invalid_daily_question_receipt');
      const checkedAt = await checkpoint(tx, db, p, at, clock);
      if (!checkedAt || (mode !== 'remove' && localDay(checkedAt, slot.timezone) !== slot.day)
        || localDay(checkedAt, slot.timezone) < slot.day) throw ended;
      return { ok: true, value: { slot, answer, commandId: scope.commandId!, replay: false, checkedAt } };
    });
  } catch (error) { if (error === ended) return fail('unavailable'); throw error; }
}
