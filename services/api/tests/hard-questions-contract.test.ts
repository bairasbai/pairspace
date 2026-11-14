import { expect, it } from 'vitest';
import { canReadQuestion, exact, followsQuestion, instant, orderQuestions, record, uuid, validQuestion, type HardQuestion } from '../../../packages/domain/hard/metadata.ts';
import { normalizeHardText } from '../../../packages/domain/hard/text.ts';
import { id } from './fixtures.ts';
const scope = { coupleId: id(10), membershipEpoch: 1, userId: id(1) };
const sealed: HardQuestion = { id: id(20), coupleId: scope.coupleId, authorId: scope.userId, recipientId: id(2), membershipEpoch: 1,
  sequence: 1, version: 1, createdAt: '2026-11-10T00:00:00.000Z', contentState: 'active', decisionState: 'sealed' };
const opened: HardQuestion = { ...sealed, version: 2, decisionState: 'opened', openedAt: sealed.createdAt };
const declined: HardQuestion = { ...sealed, version: 2, decisionState: 'declined' };
const withdrawn: HardQuestion = { ...sealed, version: 2, contentState: 'removed', decisionState: 'withdrawn' };
const states = [sealed, opened, declined, withdrawn, { ...opened, version: 3, contentState: 'removed' as const }, { ...declined, version: 3, contentState: 'removed' as const }];
it('accepts exactly six body-free states and enforces immutable identity, terminal choices and legal version jumps', () => {
  const permitted = [[0,1,2,3,4,5], [1,4], [2,5], [3], [4], [5]];
  for (let a = 0; a < states.length; a++) {
    expect(validQuestion(states[a], scope)).toBe(true);
    for (let b = 0; b < states.length; b++) expect(followsQuestion(states[a], states[b])).toBe(permitted[a].includes(b));
    for (const extra of [{ text: 'hidden' }, { body: null }, { preview: '' }, { unknown: true }]) expect(validQuestion({ ...states[a], ...extra }, scope)).toBe(false);
  }
  for (const bad of [null, [], 4, {}, { ...sealed, contentState: 'x' }, { ...sealed, decisionState: 'x' },
    { ...sealed, id: 'bad' }, { ...sealed, authorId: 'bad' }, { ...sealed, recipientId: 'bad' }, { ...sealed, recipientId: sealed.authorId },
    { ...sealed, authorId: id(3), recipientId: id(4) }, { ...sealed, coupleId: id(11) }, { ...sealed, membershipEpoch: 2 },
    { ...sealed, sequence: 0 }, { ...sealed, sequence: 101 }, { ...sealed, sequence: 1.5 }, { ...sealed, createdAt: 'bad' },
    { ...sealed, version: 2 }, { ...sealed, contentState: 'removed' }, { ...withdrawn, contentState: 'active' },
    { ...opened, openedAt: 'bad' }, { ...opened, openedAt: '2020-01-01T00:00:00.000Z' }]) expect(validQuestion(bad, scope)).toBe(false);
  for (const field of ['id', 'coupleId', 'authorId', 'recipientId'] as const) expect(followsQuestion(opened, { ...opened, [field]: id(99) })).toBe(false);
  expect(followsQuestion(opened, { ...opened, createdAt: '2026-11-11T00:00:00.000Z' })).toBe(false);
  expect(followsQuestion(opened, { ...opened, openedAt: '2026-11-11T00:00:00.000Z' })).toBe(false);
  expect(followsQuestion(opened, { ...opened, version: 1 })).toBe(false);
  expect(followsQuestion(states[4], opened)).toBe(false);
  expect(followsQuestion(sealed, { ...sealed, sequence: 2 })).toBe(false);
  expect([opened, { ...sealed, id: id(21), sequence: 2 }, sealed].sort(orderQuestions).map(q => q.sequence)).toEqual([2,1,1]);
  expect(canReadQuestion(sealed, sealed.authorId)).toBe(true); expect(canReadQuestion(sealed, sealed.recipientId)).toBe(false);
  expect(canReadQuestion(opened, sealed.recipientId)).toBe(true); expect(canReadQuestion(states[4], sealed.authorId)).toBe(false);
  expect(canReadQuestion(opened, id(99))).toBe(false);
});
it('normalizes Unicode plain questions at2000 codepoints and rejects malformed/control/raw excess input', () => {
  expect(normalizeHardText(' e\u0301\r\n\r next ')).toBe('é\n\n next');
  expect(normalizeHardText('🦉'.repeat(2000))).not.toBeNull();
  for (const value of [null, 4, '', ' ', '\ud800', '\udfff', 'a\tb', 'x\0', '\u0080', 'x'.repeat(2001), 'x'.repeat(8001)]) expect(normalizeHardText(value)).toBeNull();
});
it('rejects nonrecords, unknown keys, invalid UUIDs and noncanonical clocks', () => {
  expect(record({})).toBe(true); expect(record(null)).toBe(false); expect(record([])).toBe(false);
  expect(exact({ a: 1 }, 'a')).toBe(true); expect(exact({ a: 1, b: 2 }, 'a')).toBe(false);
  expect(uuid(id(1))).toBe(true); expect(uuid(1)).toBe(false); expect(uuid('bad')).toBe(false);
  expect(instant(sealed.createdAt)).toBe(true);
  for (const value of [1, '', '2026-02-30T00:00:00.000Z', '2026-01-01Z', '2026-99-01T00:00:00.000Z']) expect(instant(value)).toBe(false);
});
