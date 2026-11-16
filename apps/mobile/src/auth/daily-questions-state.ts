import { canonicalDailyDate, dailyPrompt } from '../../../../packages/domain/daily-question/catalog';
import { validDailySlot, type DailySlot, type DailyScope } from '../../../../packages/domain/daily-question/slot';
import { followsDailyAnswerMetadata, validDailyAnswerMetadata, type DailyAnswerMetadata } from '../../../../packages/domain/daily-question/metadata';
import { exact, instant, localDay, normalizeDailyAnswerText, record, uuid } from '../../../../packages/domain/daily-question/validation';
export { exact, instant, localDay, normalizeDailyAnswerText, record, uuid, validDailySlot, validDailyAnswerMetadata };
export type { DailySlot, DailyScope, DailyAnswerMetadata };
export type DailyEntry = Readonly<{ slot: DailySlot; answers: readonly DailyAnswerMetadata[] }>;
export type DailyToday = Readonly<{ day: string; timezone: string; catalogVersion: string; promptId: string; promptRU: string; promptEN: string }>;
export type DailyPage = Readonly<{ slots: readonly DailyEntry[]; today: DailyToday; checkedAt: string; hasMore: boolean; nextBeforeDay: string | null }>;
export type DailyAck = Readonly<{ slot: DailySlot; answer: DailyAnswerMetadata; commandId: string; replay: boolean; checkedAt: string }>;
export type DailyRead = Readonly<{ slot: DailySlot; answer: DailyAnswerMetadata; checkedAt: string; text?: string }>;
export type DailyView = Readonly<{
  generation: number; revision: number; available: boolean; userId: string | null; busy: boolean; checked: boolean;
  slots: readonly DailyEntry[]; today: DailyToday | null; checkedAt: string | null; draft: string;
  reader: Readonly<{ slot: DailySlot; answer: DailyAnswerMetadata; text: string; checkedAt: string; generation: number }> | null;
  readerStatus: 'closed' | 'loading' | 'opened' | 'changed' | 'error';
  pending: boolean; requiresRefresh: boolean; status: 'idle' | 'saving' | 'retry' | 'saved' | 'invalid' | 'conflict' | 'unavailable';
  error: boolean; hasMore: boolean; nextBeforeDay: string | null;
}>;
export const emptyDailyQuestions: DailyView = Object.freeze({ generation: 0, revision: 0, available: false, userId: null,
  busy: false, checked: false, slots: Object.freeze([]), today: null, checkedAt: null, draft: '', reader: null,
  readerStatus: 'closed', pending: false, requiresRefresh: false, status: 'idle', error: false, hasMore: false, nextBeforeDay: null });
const latest = (answer: DailyAnswerMetadata) => answer.removedAt ?? answer.editedAt;
const validClock = (value: unknown, floor: string | null): value is string =>
  instant(value) && (floor === null || (instant(floor) && value >= floor));
export function sameDailySlot(a: DailySlot, b: DailySlot): boolean {
  return Object.keys(a).every(key => JSON.stringify(a[key as keyof DailySlot]) === JSON.stringify(b[key as keyof DailySlot]));
}
function timedSlot(slot: unknown, scope: DailyScope, at: string): slot is DailySlot {
  return validDailySlot(slot, scope) && slot.createdAt <= at && slot.day <= localDay(at, slot.timezone);
}
function timedAnswer(answer: unknown, slot: DailySlot, scope: DailyScope, at: string): answer is DailyAnswerMetadata {
  return validDailyAnswerMetadata(answer, slot, scope) && latest(answer) <= at;
}
function validToday(value: unknown, at: string): value is DailyToday {
  if (!record(value) || !exact(value, 'day,timezone,catalogVersion,promptId,promptRU,promptEN') || typeof value.timezone !== 'string') return false;
  try {
    if (new Intl.DateTimeFormat('en', { timeZone: value.timezone }).resolvedOptions().timeZone !== value.timezone
      || localDay(at, value.timezone) !== value.day) return false;
  } catch { return false; }
  const prompt = dailyPrompt(value.day, value.catalogVersion);
  return prompt !== null && value.promptId === prompt.promptId && value.promptRU === prompt.promptRU && value.promptEN === prompt.promptEN;
}
export function parseDailyPage(value: unknown, scope: DailyScope, floor: string | null, beforeDay: string | null): DailyPage | null {
  if (!record(value) || !exact(value, 'slots,today,checkedAt,hasMore,nextBeforeDay') || !validClock(value.checkedAt, floor)
    || (beforeDay !== null && !canonicalDailyDate(beforeDay)) || !validToday(value.today, value.checkedAt)
    || !Array.isArray(value.slots) || value.slots.length > 100 || typeof value.hasMore !== 'boolean') return null;
  const entries: DailyEntry[] = [], ids = new Set<string>(), answerIds = new Set<string>();
  for (const entry of value.slots) {
    if (!record(entry) || !exact(entry, 'slot,answers') || !timedSlot(entry.slot, scope, value.checkedAt)
      || entry.slot.timezone !== value.today.timezone || !Array.isArray(entry.answers) || entry.answers.length > 2
      || ids.has(entry.slot.id) || (beforeDay !== null && entry.slot.day >= beforeDay)
      || (entries.length > 0 && (entry.slot.day >= entries[entries.length - 1].slot.day
        || entry.slot.participantIds.join(',') !== entries[0].slot.participantIds.join(',')))) return null;
    const authors = new Set<string>();
    for (const answer of entry.answers) {
      if (!timedAnswer(answer, entry.slot, scope, value.checkedAt) || authors.has(answer.authorId) || answerIds.has(answer.id)) return null;
      authors.add(answer.authorId); answerIds.add(answer.id);
    }
    ids.add(entry.slot.id); entries.push({ slot: entry.slot, answers: entry.answers });
  }
  const cursor = value.hasMore && entries.length === 100 ? entries[entries.length - 1].slot.day : null;
  if ((value.hasMore && cursor === null) || value.nextBeforeDay !== cursor) return null;
  return { slots: entries, today: value.today, checkedAt: value.checkedAt, hasMore: value.hasMore, nextBeforeDay: cursor };
}
export function parseDailyAck(value: unknown, scope: DailyScope, floor: string | null, expectedCommandId: string): DailyAck | null {
  if (!record(value) || !exact(value, 'slot,answer,commandId,replay,checkedAt') || !uuid(value.commandId)
    || value.commandId !== expectedCommandId || typeof value.replay !== 'boolean' || !validClock(value.checkedAt, floor)
    || !timedSlot(value.slot, scope, value.checkedAt) || !timedAnswer(value.answer, value.slot, scope, value.checkedAt)) return null;
  return { slot: value.slot, answer: value.answer, commandId: value.commandId, replay: value.replay, checkedAt: value.checkedAt };
}
/** Only an explicit authenticated text response can provide body. No fabricated own-body witness.
 * The server performs today's reciprocal-answer authorization inside its transaction.
 */
export function parseDailyRead(value: unknown, scope: DailyScope, floor: string | null, expectedId: string): DailyRead | null {
  if (!record(value) || !exact(value, 'slot,answer,checkedAt' + (Object.hasOwn(value, 'text') ? ',text' : ''))
    || !validClock(value.checkedAt, floor) || !timedSlot(value.slot, scope, value.checkedAt)
    || !timedAnswer(value.answer, value.slot, scope, value.checkedAt) || value.answer.id !== expectedId) return null;
  if (Object.hasOwn(value, 'text') && (value.answer.contentState !== 'active'
    || typeof value.text !== 'string' || normalizeDailyAnswerText(value.text) !== value.text)) return null;
  return { slot: value.slot, answer: value.answer, checkedAt: value.checkedAt,
    ...(typeof value.text === 'string' ? { text: value.text } : {}) };
}
/** Merges metadata only, without treating an ACK or older page as complete history. */
export function mergeDailyEntries(old: readonly DailyEntry[], incoming: readonly DailyEntry[], scope: DailyScope): DailyEntry[] {
  const merged = [...old];
  for (const entry of incoming) {
    if (!validDailySlot(entry.slot, scope) || entry.answers.length > 2
      || new Set(entry.answers.map(answer => answer.authorId)).size !== entry.answers.length
      || entry.answers.some(answer => !validDailyAnswerMetadata(answer, entry.slot, scope))) throw Error('invalid_daily_revision');
    if (merged.some(value => value.slot.timezone !== entry.slot.timezone
      || value.slot.participantIds.join(',') !== entry.slot.participantIds.join(','))) throw Error('invalid_daily_slot');
    const previous = merged.find(value => value.slot.id === entry.slot.id || value.slot.day === entry.slot.day);
    if (previous && !sameDailySlot(previous.slot, entry.slot)) throw Error('invalid_daily_slot');
    const answers = [...(previous?.answers ?? [])];
    for (const next of entry.answers) {
      const before = answers.find(answer => answer.authorId === next.authorId || answer.id === next.id);
      if (before && !followsDailyAnswerMetadata(before, next, entry.slot, scope)) throw Error('invalid_daily_revision');
      if (merged.some(value => value.slot.id !== entry.slot.id && value.answers.some(answer => answer.id === next.id))) throw Error('invalid_daily_revision');
      const index = answers.indexOf(before!);
      if (index < 0) answers.push(next); else answers[index] = next;
    }
    const index = merged.indexOf(previous!);
    const next = { slot: entry.slot, answers: answers.sort((a, b) => a.authorId.localeCompare(b.authorId)) };
    if (index < 0) merged.push(next); else merged[index] = next;
  }
  return merged.sort((a, b) => b.slot.day.localeCompare(a.slot.day));
}
/** A fresh page must retain known tombstones and answers inside its authoritative range. */
export function checkDailyPageContinuity(old: readonly DailyEntry[], page: DailyPage, beforeDay: string | null, previousToday: DailyToday | null = null): boolean {
  // Even an empty older page must agree with the retained pair/epoch calendar.
  if ((previousToday !== null && previousToday.timezone !== page.today.timezone)
    || old.some(entry => entry.slot.timezone !== page.today.timezone)) return false;
  for (const prior of old) {
    if ((beforeDay !== null && prior.slot.day >= beforeDay)
      || (page.hasMore && prior.slot.day < page.nextBeforeDay!)) continue;
    const entry = page.slots.find(value => value.slot.id === prior.slot.id);
    if (!entry || !sameDailySlot(prior.slot, entry.slot)
      || prior.answers.some(answer => !entry.answers.some(next => next.id === answer.id))) return false;
  }
  return true;
}
/** UI affordance only: metadata cannot authorize fetching a body. The explicit server
 * reader separately validates the canonical own text inside its transaction. */
export function canReadDailyMetadata(entry: DailyEntry, answer: DailyAnswerMetadata, userId: string | null, checkedAt: string | null): boolean {
  if (userId === null || checkedAt === null || !instant(checkedAt)) return false;
  const scope = { coupleId: entry.slot.coupleId, membershipEpoch: entry.slot.membershipEpoch, userId };
  if (!timedSlot(entry.slot, scope, checkedAt) || !timedAnswer(answer, entry.slot, scope, checkedAt)
    || answer.contentState !== 'active') return false;
  return answer.authorId === userId || entry.slot.day < localDay(checkedAt, entry.slot.timezone)
    || entry.answers.some(own => own.authorId === userId && own.contentState === 'active' && timedAnswer(own, entry.slot, scope, checkedAt));
}
