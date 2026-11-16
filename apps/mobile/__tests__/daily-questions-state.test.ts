import { createDailySlot } from '../../../packages/domain/daily-question/slot';
import { createDailyAnswerMetadata, rewriteDailyAnswerMetadata, removeDailyAnswerMetadata } from '../../../packages/domain/daily-question/metadata';
import { dailyPrompt } from '../../../packages/domain/daily-question/catalog';
import { parseDailyPage, parseDailyAck, parseDailyRead, mergeDailyEntries, checkDailyPageContinuity,
  canReadDailyMetadata, emptyDailyQuestions, type DailyEntry, type DailyPage } from '../src/auth/daily-questions-state';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope = { coupleId: id(3), userId: id(1), membershipEpoch: 1 }, other = { ...scope, userId: id(2) };
const at = '2026-11-16T10:00:00.000Z', later = '2026-11-16T11:00:00.000Z', tomorrow = '2026-11-17T10:00:00.000Z';
const slot = createDailySlot({ id: id(4), participantIds: [id(1), id(2)], timezone: 'UTC' }, scope, at)!;
const answer = createDailyAnswerMetadata({ id: id(5) }, slot, scope, at, true)!;
const partner = createDailyAnswerMetadata({ id: id(6) }, slot, other, at, true)!;
const entry: DailyEntry = { slot, answers: [answer, partner] };
const page: DailyPage = { slots: [entry], today: { day: slot.day, timezone: 'UTC', ...dailyPrompt(slot.day)! }, checkedAt: at, hasMore: false, nextBeforeDay: null };
const ack = { slot, answer, commandId: id(9), replay: false, checkedAt: at };
it('parses exact metadata-only collection, ACK and explicit body replies', () => {
  expect(emptyDailyQuestions.reader).toBeNull();
  expect(parseDailyPage(page, scope, null, null)).toEqual(page);
  expect(parseDailyPage(page, scope, at, '2026-11-17')).toEqual(page);
  expect(parseDailyAck(ack, scope, at, id(9))).toEqual(ack);
  for (const value of [{ slot, answer, checkedAt: at }, { slot, answer, checkedAt: at, text: 'Canonical answer' }]) {
    expect(parseDailyRead(value, scope, at, answer.id)).toEqual(value);
  }
});
it('rejects all malformed envelope, metadata, identity and clock variations', () => {
  for (const bad of [null, [], { ...page, extra: 1 }, { ...page, slots: null }, { ...page, slots: Array(101).fill(entry) },
    { ...page, hasMore: 1 }, { ...page, hasMore: true }, { ...page, nextBeforeDay: slot.day }, { ...page, checkedAt: 'bad' }]) {
    expect(parseDailyPage(bad, scope, null, null)).toBeNull();
  }
  for (const today of [null, { ...page.today, extra: true }, { ...page.today, timezone: 2 }, { ...page.today, timezone: 'bad' },
    { ...page.today, timezone: 'US/Eastern' }, { ...page.today, day: '2026-11-15' }, { ...page.today, catalogVersion: 'unknown' },
    { ...page.today, promptRU: 'edited' }]) expect(parseDailyPage({ ...page, today }, scope, null, null)).toBeNull();
  for (const value of [
    { ...entry, extra: true }, { slot: { ...slot, promptEN: 'edited' }, answers: [] }, { slot, answers: [answer, answer] },
    { slot, answers: [answer, partner, partner] }, { slot, answers: [{ ...answer, text: 'body' }] },
    { slot, answers: [{ ...answer, contentState: ['active'] }] }, { slot, answers: null },
  ]) expect(parseDailyPage({ ...page, slots: [value] }, scope, null, null)).toBeNull();
  expect(parseDailyPage({ ...page, slots: [entry, entry] }, scope, null, null)).toBeNull();
  expect(parseDailyPage(page, scope, later, null)).toBeNull();
  expect(parseDailyPage(page, scope, 'bad', null)).toBeNull();
  expect(parseDailyPage(page, scope, null, 'bad')).toBeNull();
  expect(parseDailyPage(page, scope, null, slot.day)).toBeNull();
  expect(parseDailyPage(page, { ...scope, membershipEpoch: 2 }, null, null)).toBeNull();
  for (const bad of [null, { ...ack, text: 'body' }, { ...ack, replay: ['false'] }, { ...ack, commandId: 'bad' },
    { ...ack, answer: { ...answer, contentState: { toString: () => 'active' } } }, { ...ack, checkedAt: '2026-11-15T10:00:00.000Z' }]) {
    expect(parseDailyAck(bad, scope, null, id(9))).toBeNull();
  }
  expect(parseDailyAck(ack, scope, null, id(10))).toBeNull();
  for (const patch of [{ text: '' }, { text: ' noncanonical ' }, { text: null }, { body: 'extra' },
    { answer: { ...answer, text: 'private' } }, { checkedAt: 'bad' }]) {
    expect(parseDailyRead({ slot, answer, checkedAt: at, ...patch }, scope, null, answer.id)).toBeNull();
  }
  const removed = removeDailyAnswerMetadata(answer, slot, scope, at, 1, true)!;
  expect(parseDailyRead({ slot, answer: removed, checkedAt: at, text: 'deleted' }, scope, null, answer.id)).toBeNull();
  expect(parseDailyRead({ slot, answer, checkedAt: at }, scope, null, id(99))).toBeNull();
});
it('accepts exact bounded keyset pages and rejects duplicate day/answer or mismatched pinned zone', () => {
  const entries = Array.from({ length: 100 }, (_, n) => {
    const time = new Date(Date.parse(at) - n * 86400000).toISOString();
    return { slot: createDailySlot({ id: id(100 + n), participantIds: [id(1), id(2)], timezone: 'UTC' }, scope, time)!, answers: [] };
  });
  const full = { ...page, slots: entries, hasMore: true, nextBeforeDay: entries[99].slot.day };
  expect(parseDailyPage(full, scope, null, null)).toEqual(full);
  expect(parseDailyPage({ ...full, nextBeforeDay: entries[98].slot.day }, scope, null, null)).toBeNull();
  expect(parseDailyPage({ ...page, slots: [entry, { ...entry, slot: { ...slot, id: id(99) } }] }, scope, null, null)).toBeNull();
  const pastSlot = entries[1].slot;
  expect(parseDailyPage({ ...page, slots: [entry, { slot: { ...pastSlot, participantIds: [id(1), id(99)] }, answers: [] }] }, scope, null, null)).toBeNull();
  const duplicateAnswer = createDailyAnswerMetadata({ id: answer.id }, pastSlot, scope, pastSlot.createdAt, true)!;
  expect(parseDailyPage({ ...page, slots: [entry, { slot: pastSlot, answers: [duplicateAnswer] }] }, scope, null, null)).toBeNull();
  const zoneSlot = createDailySlot({ id: id(98), participantIds: [id(1), id(2)], timezone: 'Europe/Moscow' }, scope, at)!;
  expect(parseDailyPage({ ...page, slots: [{ slot: zoneSlot, answers: [] }] }, scope, null, null)).toBeNull();
});
it('monotonic merges preserve unknown history and reject replacement/resurrection', () => {
  const changed = rewriteDailyAnswerMetadata(answer, slot, scope, later, 1, true)!;
  expect(mergeDailyEntries([entry], [{ slot, answers: [changed] }], scope)[0].answers).toEqual([changed, partner]);
  expect(mergeDailyEntries([], [entry], scope)).toEqual([entry]);
  expect(() => mergeDailyEntries([entry], [{ slot: { ...slot, id: id(99) }, answers: [] }], scope)).toThrow('invalid_daily_slot');
  expect(() => mergeDailyEntries([entry], [{ slot, answers: [{ ...answer, id: id(99) }] }], scope)).toThrow('invalid_daily_revision');
  expect(() => mergeDailyEntries([{ slot, answers: [changed] }], [entry], scope)).toThrow('invalid_daily_revision');
  for (const value of [{ slot, answers: [answer, answer] }, { slot: { ...slot, day: 'bad' }, answers: [] },
    { slot, answers: [{ ...answer, text: 'body' }] }]) {
    expect(() => mergeDailyEntries([], [value as DailyEntry], scope)).toThrow();
  }
  const oldSlot = createDailySlot({ id: id(40), participantIds: [id(1), id(2)], timezone: 'UTC' }, scope, '2026-11-15T10:00:00.000Z')!;
  expect(mergeDailyEntries([entry], [{ slot: oldSlot, answers: [] }], scope).map(e => e.slot.id)).toEqual([slot.id, oldSlot.id]);
  for (const patch of [{ participantIds: [id(1), id(99)] as const }, { timezone: 'Europe/Moscow' }]) {
    expect(() => mergeDailyEntries([entry], [{ slot: { ...oldSlot, ...patch }, answers: [] }], scope)).toThrow('invalid_daily_slot');
  }
  const collision = createDailyAnswerMetadata({ id: answer.id }, oldSlot, scope, oldSlot.createdAt, true)!;
  expect(() => mergeDailyEntries([entry], [{ slot: oldSlot, answers: [collision] }], scope)).toThrow('invalid_daily_revision');
  expect(checkDailyPageContinuity([entry], page, null)).toBe(true);
  expect(checkDailyPageContinuity([entry], { ...page, slots: [] }, null)).toBe(false);
  expect(checkDailyPageContinuity([entry], { ...page, slots: [{ slot, answers: [] }] }, null)).toBe(false);
  expect(checkDailyPageContinuity([entry], { ...page, slots: [] }, slot.day)).toBe(true);
  expect(checkDailyPageContinuity([{ slot: oldSlot, answers: [] }], { ...page, hasMore: true, nextBeforeDay: slot.day }, null)).toBe(true);
});
it('metadata read affordance fails closed, but is never a substitute for body authorization', () => {
  expect(canReadDailyMetadata(entry, answer, scope.userId, at)).toBe(true);
  expect(canReadDailyMetadata(entry, partner, scope.userId, at)).toBe(true);
  expect(canReadDailyMetadata({ slot, answers: [partner] }, partner, scope.userId, at)).toBe(false);
  expect(canReadDailyMetadata({ slot, answers: [] }, partner, scope.userId, tomorrow)).toBe(true);
  for (const [user, checkedAt] of [[null, at], [scope.userId, null], [scope.userId, 'bad'], [scope.userId, '2026-11-15T10:00:00.000Z']] as const) {
    expect(canReadDailyMetadata(entry, answer, user, checkedAt)).toBe(false);
  }
  const removed = removeDailyAnswerMetadata(answer, slot, scope, at, 1, true)!;
  expect(canReadDailyMetadata(entry, removed, scope.userId, at)).toBe(false);
  expect(canReadDailyMetadata({ slot, answers: [removed] }, partner, scope.userId, at)).toBe(false);
  expect(canReadDailyMetadata({ slot, answers: [{ ...answer, editedAt: later, version: 2 }] }, partner, scope.userId, at)).toBe(false);
});

it('empty older page cannot replace the retained pinned calendar or prior descriptor', () => {
  const empty = { ...page, slots: [] };
  const changed = { ...empty, today: { ...page.today, timezone: 'Europe/Moscow' } };
  expect(parseDailyPage(changed, scope, at, slot.day)).not.toBeNull();
  expect(checkDailyPageContinuity([entry], changed, slot.day)).toBe(false);
  expect(checkDailyPageContinuity([], changed, slot.day, page.today)).toBe(false);
  expect(checkDailyPageContinuity([entry], empty, slot.day, page.today)).toBe(true);
  expect(checkDailyPageContinuity([], empty, slot.day, page.today)).toBe(true);
});
