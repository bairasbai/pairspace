import { DAILY_CATALOG_VERSION, canonicalDailyDate, dailyPrompt } from '../../../packages/domain/daily-question/catalog.ts';
import { createDailySlot, validDailySlot, type DailyScope } from '../../../packages/domain/daily-question/slot.ts';
import { createDailyAnswer, rewriteDailyAnswer, removeDailyAnswer, validDailyAnswer, followsDailyAnswer,
  canReadDailyAnswer, normalizeDailyAnswerText } from '../../../packages/domain/daily-question/policy.ts';
import { createDailyAnswerMetadata, rewriteDailyAnswerMetadata, removeDailyAnswerMetadata, validDailyAnswerMetadata,
  projectDailyAnswerMetadata, followsDailyAnswerMetadata } from '../../../packages/domain/daily-question/metadata.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope = { coupleId: id(1), membershipEpoch: 1, userId: id(2) };
const partner = { ...scope, userId: id(3) };
const now = '2026-11-16T08:00:00.000Z', later = '2026-11-16T09:00:00.000Z';
const last = '2026-11-16T20:59:59.999Z', tomorrow = '2026-11-16T21:00:00.000Z';
const slotInput = { id: id(4), participantIds: [scope.userId, partner.userId], timezone: 'Europe/Moscow' };
const slot = () => createDailySlot(slotInput, scope, now)!;
const answer = (actor = scope) => createDailyAnswer({ id: actor === scope ? id(5) : id(6), text: 'Synthetic answer\n\nSecond paragraph' }, slot(), actor, now, true)!;
const metadata = () => projectDailyAnswerMetadata(answer());
const removed = () => removeDailyAnswer(answer(), slot(), scope, later, 1, true)!;

describe('original fixed catalogue and canonical calendar', () => {
 it('pins seven versioned prompts to Jan1 and cycles in both directions with exact snapshots', () => {
  expect(DAILY_CATALOG_VERSION).toBe('amio-daily-v1');
  const ids = ['small-discovery', 'comfortable-pace', 'ordinary-detail', 'try-together', 'gentle-change', 'unexpected-smile', 'keep-a-moment'];
  for (let n = 0; n < 7; n++) {
   const prompt = dailyPrompt(`2026-01-0${n + 1}`)!;
   expect(prompt.promptId).toBe(ids[n]); expect(prompt.catalogVersion).toBe(DAILY_CATALOG_VERSION);
   expect(prompt.promptRU.length).toBeGreaterThan(20); expect(prompt.promptEN.length).toBeGreaterThan(20); expect(Object.isFrozen(prompt)).toBe(true);
  }
  expect(dailyPrompt('2026-01-08')).toEqual(dailyPrompt('2026-01-01'));
  expect(dailyPrompt('2025-12-31')).toEqual(dailyPrompt('2026-01-07'));
  expect(dailyPrompt('2024-02-29')).not.toBeNull(); expect(canonicalDailyDate('2000-02-29')).toBe(true);
 });
 it.each([null, undefined, [], {}, 1, '', '2026-1-01', '2026-02-29', '2100-02-29', '2026-04-31', '2026-13-01', '2026-00-01', '2026-01-00', '2026-01-01T00:00:00Z'])('rejects date %#', value => {
  expect(canonicalDailyDate(value)).toBe(false); expect(dailyPrompt(value)).toBeNull();
 });
 it.each([null, 1, {}, '', 'amio-daily-v2'])('unknown catalogue version fails closed %#', version => {
  expect(dailyPrompt('2026-01-01', version)).toBeNull();
 });
});
describe('pinned pair/day slot', () => {
 it('creates exact shared snapshot and canonicalizes IANA aliases', () => {
  const value = slot(); expect(value).toMatchObject({ ...slotInput, day: '2026-11-16', createdAt: now, ...dailyPrompt('2026-11-16') });
  expect(validDailySlot(value, scope)).toBe(true); expect(validDailySlot(value, partner)).toBe(true);
  expect(createDailySlot({ ...slotInput, timezone: 'US/Eastern' }, scope, now)?.timezone).toBe('America/New_York');
 });
 it.each([null, [], {}, { ...slotInput, extra: 1 }, { ...slotInput, id: 'bad' }, { ...slotInput, timezone: 'bad' },
  { ...slotInput, timezone: null }, { ...slotInput, timezone: 'x'.repeat(101) }, { ...slotInput, participantIds: [scope.userId] },
  { ...slotInput, participantIds: [partner.userId, scope.userId] }, { ...slotInput, participantIds: [scope.userId, scope.userId] },
  { ...slotInput, participantIds: [scope.userId, 'bad'] }, { ...slotInput, participantIds: [id(10), id(11)] }])('rejects malformed slot creation %#', value => {
  expect(createDailySlot(value, scope, now)).toBeNull();
 });
 it.each(['bad', '2026-11-16T08:00:00Z', '2026-02-30T08:00:00.000Z'])('rejects invalid clock %s', at => {
  expect(createDailySlot(slotInput, scope, at)).toBeNull();
 });
 it.each([{ extra: true }, { day: '2026-11-17' }, { createdAt: tomorrow }, { timezone: 'US/Eastern' },
  { catalogVersion: 'amio-daily-v2' }, { promptId: 'invented' }, { promptRU: 'Changed' }, { promptEN: 'Changed' },
  { participantIds: [scope.userId, partner.userId, id(20)] }, { content: 'not allowed' }])('rejects mutated pinned slot %#', patch => {
  expect(validDailySlot({ ...slot(), ...patch }, scope)).toBe(false);
 });
 it.each([null, undefined, [], 'scope', 1, { ...scope, userId: 'bad' }, { ...scope, coupleId: 'bad' },
  { ...scope, membershipEpoch: 0 }, { ...scope, membershipEpoch: 1.5 }, { ...scope, membershipEpoch: 2147483647 }])('runtime scope fails closed %#', raw => {
  const actor = raw as DailyScope;
  expect(validDailySlot(slot(), actor)).toBe(false); expect(createDailySlot(slotInput, actor, now)).toBeNull();
 });
 it.each([{ ...scope, userId: id(90) }, { ...scope, coupleId: id(91) }, { ...scope, membershipEpoch: 2 }])('denies foreign actor/pair/epoch %#', actor => {
  expect(validDailySlot(slot(), actor)).toBe(false); expect(validDailyAnswer(answer(), slot(), actor)).toBe(false);
  expect(canReadDailyAnswer(answer(), null, slot(), actor, now)).toBe(false);
 });
 it.each([
  ['America/New_York', '2027-03-14T06:59:59.999Z', '2027-03-14T07:00:00.000Z', '2027-03-14', '2027-03-14'],
  ['America/New_York', '2027-11-07T05:59:59.999Z', '2027-11-07T06:00:00.000Z', '2027-11-07', '2027-11-07'],
  ['Pacific/Apia', '2011-12-30T09:59:59.999Z', '2011-12-30T10:00:00.000Z', '2011-12-29', '2011-12-31'],
  ['Pacific/Kiritimati', '2026-11-16T09:59:59.999Z', '2026-11-16T10:00:00.000Z', '2026-11-16', '2026-11-17'],
 ])('pins actual local day across DST/skipped dates %s', (timezone, first, next, firstDay, nextDay) => {
  expect(createDailySlot({ ...slotInput, timezone }, scope, first)?.day).toBe(firstDay);
  expect(createDailySlot({ ...slotInput, timezone }, scope, next)?.day).toBe(nextDay);
 });
});
describe('full body and body-free answer shapes', () => {
 it('normalizes unicode and line endings, preserves paragraphs and counts codepoints', () => {
  expect(normalizeDailyAnswerText(' e\u0301\r\n\r\nnext ')).toBe('é\n\nnext');
  expect(normalizeDailyAnswerText('🦉'.repeat(2000))).toBe('🦉'.repeat(2000));
  const value = createDailyAnswer({ id: id(7), text: ' e\u0301 ' }, slot(), scope, now, true)!;
  expect(value).toHaveProperty('text', 'é'); expect(validDailyAnswer(value, slot(), scope)).toBe(true);
  const projection = projectDailyAnswerMetadata(value); expect(projection).not.toHaveProperty('text');
  expect(validDailyAnswerMetadata(projection, slot(), scope)).toBe(true); expect(validDailyAnswerMetadata(value, slot(), scope)).toBe(false);
  expect(validDailyAnswer(projection, slot(), scope)).toBe(false);
 });
 it.each([null, undefined, [], {}, 1, '', ' \n ', 'a\rb', '\tanswer', 'answer\u000b', 'a\u0000b', '\ud800', '\udfff',
  'x'.repeat(2001), '🦉'.repeat(2001), 'x'.repeat(8001)])('rejects invalid text %#', value => {
  expect(normalizeDailyAnswerText(value)).toBeNull(); expect(createDailyAnswer({ id: id(7), text: value }, slot(), scope, now, true)).toBeNull();
 });
 it.each([null, [], {}, { id: id(7), text: 'valid', extra: true }, { id: 'bad', text: 'valid' }])('rejects full creation shape %#', value => {
  expect(createDailyAnswer(value, slot(), scope, now, true)).toBeNull();
 });
 it.each([null, [], {}, { id: 'bad' }, { id: id(7), text: 'not metadata' }])('rejects metadata creation shape %#', value => {
  expect(createDailyAnswerMetadata(value, slot(), scope, now, true)).toBeNull();
 });
 it.each([{ text: '' }, { text: ' untrimmed ' }, { text: 'e\u0301' }, { text: null }, { extra: true }, { authorId: id(90) },
  { id: 'bad' }, { slotId: id(90) }, { coupleId: id(90) }, { membershipEpoch: 2 }, { version: 0 }, { version: 1.5 },
  { createdAt: 'bad' }, { createdAt: '2026-11-16T07:59:59.999Z' }, { editedAt: 'bad' }, { editedAt: '2026-11-16T07:59:59.999Z' },
  { editedAt: later }, { editedAt: tomorrow, version: 2 }, { removedAt: later }, { contentState: 'unknown' }, { version: 2147483646 }])('rejects invalid full answer %#', patch => {
  expect(validDailyAnswer({ ...answer(), ...patch }, slot(), scope)).toBe(false);
 });
 it('removal physically omits body in projection and requires coherent reserved version/chronology', () => {
  const value = removed(); expect(value).not.toHaveProperty('text'); expect(validDailyAnswer(value, slot(), scope)).toBe(true);
  for (const patch of [{ text: null }, { text: 'old' }, { removedAt: null }, { removedAt: 'bad' }, { removedAt: '2026-11-16T07:00:00.000Z' },
    { editedAt: later }, { version: 1 }, { version: 2147483647 }, { contentState: 'active' }]) {
   expect(validDailyAnswer({ ...value, ...patch }, slot(), scope)).toBe(false);
  }
 });
});
describe('today mutual gate, historical reveal and trustworthy time', () => {
 it('owner may read today; partner needs own valid active answer in this exact slot', () => {
  expect(canReadDailyAnswer(answer(), null, slot(), scope, now)).toBe(true);
  expect(canReadDailyAnswer(answer(partner), null, slot(), scope, now)).toBe(false);
  expect(canReadDailyAnswer(answer(partner), answer(), slot(), scope, now)).toBe(true);
  expect(canReadDailyAnswer(answer(), answer(partner), slot(), partner, now)).toBe(true);
  expect(canReadDailyAnswer(answer(partner), removed(), slot(), scope, later)).toBe(false);
 });
 it.each([{}, undefined, { ...answer(), text: '' }, { ...answer(), slotId: id(99) }, { ...answer(), coupleId: id(99) },
  { ...answer(), membershipEpoch: 2 }, projectDailyAnswerMetadata(answer()), answer(partner)])('malformed/mismatched own evidence never unlocks today or past %#', own => {
  expect(canReadDailyAnswer(answer(partner), own, slot(), scope, later)).toBe(false);
  expect(canReadDailyAnswer(answer(partner), own, slot(), scope, tomorrow)).toBe(false);
 });
 it('past answers reveal automatically, even without own answer; removed target never reveals', () => {
  expect(canReadDailyAnswer(answer(partner), null, slot(), scope, tomorrow)).toBe(true);
  expect(canReadDailyAnswer(answer(partner), removed(), slot(), scope, tomorrow)).toBe(true);
  expect(canReadDailyAnswer(answer(), null, slot(), scope, tomorrow)).toBe(true);
  expect(canReadDailyAnswer(removed(), null, slot(), partner, tomorrow)).toBe(false);
 });
 it('future/invalid/rollback clocks and future observed own events do not unlock', () => {
  for (const at of ['bad', '2026-11-16T08:00:00Z', '2026-11-15T12:00:00.000Z', '2026-11-16T07:59:59.999Z']) {
   expect(canReadDailyAnswer(answer(), null, slot(), scope, at)).toBe(false);
  }
  const edited = rewriteDailyAnswer(answer(), slot(), scope, later, 1, 'New answer', true)!;
  expect(canReadDailyAnswer(edited, null, slot(), scope, now)).toBe(false);
  expect(canReadDailyAnswer(answer(partner), edited, slot(), scope, now)).toBe(false);
  expect(canReadDailyAnswer(answer(partner), removed(), slot(), scope, now)).toBe(false);
 });
});
describe('confirmed own CAS writes today, terminal deletion any later day', () => {
 it('allows equal-millisecond rewrite, repeated changes today and deletion after the day', () => {
  const original = Object.freeze(answer()), second = rewriteDailyAnswer(original, slot(), scope, now, 1, ' e\u0301 ', true)!;
  expect(second).toMatchObject({ version: 2, editedAt: now, text: 'é' }); expect(original.version).toBe(1);
  const third = rewriteDailyAnswer(second, slot(), scope, last, 2, 'Third', true)!;
  expect(third.version).toBe(3); expect(rewriteDailyAnswer(third, slot(), scope, tomorrow, 3, 'Late', true)).toBeNull();
  expect(createDailyAnswer({ id: id(20), text: 'Late' }, slot(), scope, tomorrow, true)).toBeNull();
  const gone = removeDailyAnswer(third, slot(), scope, tomorrow, 3, true)!;
  expect(gone).toMatchObject({ contentState: 'removed', version: 4, removedAt: tomorrow }); expect(gone).not.toHaveProperty('text');
  expect(rewriteDailyAnswer(gone, slot(), scope, tomorrow, 4, 'Resurrection', true)).toBeNull();
  expect(removeDailyAnswer(gone, slot(), scope, tomorrow, 4, true)).toBeNull();
 });
 it.each([false, 'true', 1, null])('requires literal true confirmation %#', confirmed => {
  const confirm = confirmed as boolean;
  expect(createDailyAnswer({ id: id(20), text: 'New' }, slot(), scope, now, confirm)).toBeNull();
  expect(rewriteDailyAnswer(answer(), slot(), scope, now, 1, 'New', confirm)).toBeNull();
  expect(removeDailyAnswer(answer(), slot(), scope, now, 1, confirm)).toBeNull();
 });
 it('denies foreign writes, stale versions, invalid body/clock and pre-observation time', () => {
  for (const actor of [partner, { ...scope, membershipEpoch: 2 }]) {
   expect(rewriteDailyAnswer(answer(), slot(), actor, now, 1, 'New', true)).toBeNull();
   expect(removeDailyAnswer(answer(), slot(), actor, now, 1, true)).toBeNull();
  }
  for (const version of [0, 2, 1.5, NaN]) {
   expect(rewriteDailyAnswer(answer(), slot(), scope, now, version, 'New', true)).toBeNull();
   expect(removeDailyAnswer(answer(), slot(), scope, now, version, true)).toBeNull();
  }
  for (const at of ['bad', '2026-11-16T07:00:00.000Z']) {
   expect(createDailyAnswer({ id: id(20), text: 'New' }, slot(), scope, at, true)).toBeNull();
   expect(rewriteDailyAnswer(answer(), slot(), scope, at, 1, 'New', true)).toBeNull();
   expect(removeDailyAnswer(answer(), slot(), scope, at, 1, true)).toBeNull();
  }
  expect(rewriteDailyAnswer(answer(), slot(), scope, now, 1, '', true)).toBeNull();
  expect(rewriteDailyAnswer({}, slot(), scope, now, 1, 'New', true)).toBeNull(); expect(removeDailyAnswer({}, slot(), scope, now, 1, true)).toBeNull();
 });
 it('reserves final version for removal with no wraparound or extra rewrite', () => {
  const high = { ...answer(), version: 2147483645 };
  expect(validDailyAnswer(high, slot(), scope)).toBe(true);
  expect(rewriteDailyAnswer(high, slot(), scope, now, high.version, 'New', true)).toBeNull();
  const final = removeDailyAnswer(high, slot(), scope, tomorrow, high.version, true)!;
  expect(final.version).toBe(2147483646); expect(validDailyAnswer(final, slot(), scope)).toBe(true);
  expect(removeDailyAnswer(final, slot(), scope, tomorrow, final.version, true)).toBeNull();
 });
});
describe('reachable progression and body-free witnesses', () => {
 it('accepts identical snapshots and reachable rewrite/version gaps including equal clocks', () => {
  const first = answer(), second = rewriteDailyAnswer(first, slot(), scope, now, 1, 'Second', true)!;
  const third = rewriteDailyAnswer(second, slot(), scope, later, 2, 'Third', true)!;
  const gone = removeDailyAnswer(third, slot(), scope, tomorrow, 3, true)!;
  for (const [old, next] of [[first, first], [first, second], [first, third], [first, gone], [second, third], [second, gone], [third, gone], [gone, gone]]) {
   expect(followsDailyAnswer(old, next, slot(), scope)).toBe(true);
   expect(followsDailyAnswerMetadata(projectDailyAnswerMetadata(old), projectDailyAnswerMetadata(next), slot(), scope)).toBe(true);
  }
  expect(followsDailyAnswer(first, { ...first, version: 10, editedAt: later }, slot(), scope)).toBe(true);
 });
 it.each([{ id: id(90) }, { slotId: id(90) }, { coupleId: id(90) }, { membershipEpoch: 2 }, { authorId: partner.userId },
  { createdAt: later, editedAt: later }, { text: 'Changed without version' }])('rejects immutable mutation %#', patch => {
  expect(followsDailyAnswer(answer(), { ...answer(), ...patch }, slot(), scope)).toBe(false);
 });
 it('rejects stale versions/clocks, same-version edits, immediate removal with changed edit time and resurrection', () => {
  const second = rewriteDailyAnswer(answer(), slot(), scope, later, 1, 'Second', true)!;
  expect(followsDailyAnswer(second, answer(), slot(), scope)).toBe(false);
  expect(followsDailyAnswer(second, { ...second, version: 3, editedAt: now }, slot(), scope)).toBe(false);
  expect(followsDailyAnswer(second, { ...second, editedAt: last }, slot(), scope)).toBe(false);
  const directGone = { ...projectDailyAnswerMetadata(second), version: 3, editedAt: last, removedAt: tomorrow, contentState: 'removed' as const };
  expect(validDailyAnswer(directGone, slot(), scope)).toBe(true); expect(followsDailyAnswer(second, directGone, slot(), scope)).toBe(false);
  expect(followsDailyAnswer(second, { ...directGone, version: 4 }, slot(), scope)).toBe(true);
  expect(followsDailyAnswer(removed(), answer(), slot(), scope)).toBe(false);
  expect(followsDailyAnswer(removed(), { ...removed(), removedAt: tomorrow }, slot(), scope)).toBe(false);
  expect(followsDailyAnswerMetadata({}, metadata(), slot(), scope)).toBe(false);
  expect(followsDailyAnswer({}, answer(), slot(), scope)).toBe(false);
 });
 it('metadata transitions preserve exact shape and never return text', () => {
  const original = createDailyAnswerMetadata({ id: id(8) }, slot(), scope, now, true)!;
  const rewritten = rewriteDailyAnswerMetadata(original, slot(), scope, later, 1, true)!;
  const gone = removeDailyAnswerMetadata(rewritten, slot(), scope, tomorrow, 2, true)!;
  expect(gone).not.toHaveProperty('text'); expect(followsDailyAnswerMetadata(original, gone, slot(), scope)).toBe(true);
  expect(validDailyAnswerMetadata({ ...original, text: 'injected' }, slot(), scope)).toBe(false);
 });
});

it.each([null, {}, [], 'invalid', 'x'.repeat(101)])('strict slot timezone type/value fails closed %#', timezone => {
 expect(validDailySlot({ ...slot(), timezone }, scope)).toBe(false);
 expect(createDailySlot({ ...slotInput, timezone }, scope, now)).toBeNull();
});
it('supports canonical AD years below1000 without misrepresenting BCE or year10000', () => {
 for (const year of ['0001', '0099', '0999']) {
  const at = year + '-01-01T12:00:00.000Z';
  const value = createDailySlot({ ...slotInput, timezone: 'UTC' }, scope, at)!;
  expect(value.day).toBe(year + '-01-01'); expect(validDailySlot(value, scope)).toBe(true);
 }
 expect(canonicalDailyDate('0000-01-01')).toBe(false); expect(dailyPrompt('0000-01-01')).toBeNull();
 expect(createDailySlot({ ...slotInput, timezone: 'UTC' }, scope, '0000-01-01T12:00:00.000Z')).toBeNull();
 expect(createDailySlot({ ...slotInput, timezone: 'America/New_York' }, scope, '0001-01-01T00:00:00.000Z')).toBeNull();
 expect(createDailySlot({ ...slotInput, timezone: 'Pacific/Kiritimati' }, scope, '9999-12-31T23:00:00.000Z')).toBeNull();
});
it('historical midnight rollback denies reading or deleting a locally future slot despite increasing UTC', () => {
 const at = '1988-10-30T02:00:00.000Z', rollback = '1988-10-30T02:30:00.000Z';
 const pinned = createDailySlot({ ...slotInput, timezone: 'America/Goose_Bay' }, scope, at)!;
 expect(pinned.day).toBe('1988-10-30');
 const first = createDailyAnswer({ id: id(5), text: 'Synthetic old calendar answer' }, pinned, scope, at, true)!;
 expect(canReadDailyAnswer(first, null, pinned, scope, rollback)).toBe(false);
 expect(removeDailyAnswer(first, pinned, scope, rollback, 1, true)).toBeNull();
 expect(validDailyAnswer({ ...projectDailyAnswerMetadata(first), contentState: 'removed', version: 2, removedAt: rollback }, pinned, scope)).toBe(false);
});

it('rejects sparse participant arrays rather than skipping missing identity slots', () => {
 const trailing = new Array<string>(2); trailing[0] = scope.userId;
 const leading = new Array<string>(2); leading[1] = scope.userId;
 for (const participantIds of [trailing, leading]) {
  expect(createDailySlot({ ...slotInput, participantIds }, scope, now)).toBeNull();
  expect(validDailySlot({ ...slot(), participantIds }, scope)).toBe(false);
 }
});
