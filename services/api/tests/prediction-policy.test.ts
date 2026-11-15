import { describe, it, expect } from 'vitest';
import { parsePredictionSchedule, normalizePredictionBody, validPrediction, mayReadPrediction,
  acknowledgePrediction, declinePrediction, removePrediction, followsPrediction, type Prediction } from '../../../packages/domain/predictions/policy.ts';

const author = '11111111-1111-4111-8111-111111111111';
const recipient = '22222222-2222-4222-8222-222222222222';
const couple = '33333333-3333-4333-8333-333333333333';
const scope = { userId: author, coupleId: couple, membershipEpoch: 1 };
const other = { ...scope, userId: recipient };
const before = '2026-11-16T05:59:59.999Z', due = '2026-11-16T06:00:00.000Z';
const schedule = { localDate: '2026-11-16', localTime: '09:00', timezone: 'Europe/Moscow', offset: '+03:00' };
const now = '2026-11-15T15:00:00.000Z';
const prediction: Prediction = { id: '44444444-4444-4444-8444-444444444444', coupleId: couple,
  authorId: author, recipientId: recipient, membershipEpoch: 1, version: 1, createdAt: now,
  ...schedule, releaseAt: due, contentState: 'active', openedAt: null, declinedAt: null };

describe('prediction release schedule', () => {
  it('stores a canonical UTC snapshot without a default timezone', () => {
    expect(parsePredictionSchedule(schedule, now)).toEqual({ ...schedule, releaseAt: due });
    expect(parsePredictionSchedule({ ...schedule, timezone: 'US/Eastern', offset: '-05:00' }, now)?.timezone).toBe('America/New_York');
  });
  it.each([null, [], {}, { ...schedule, body: 'private' }, { ...schedule, timezone: null },
    { ...schedule, localTime: '24:00' }, { ...schedule, localDate: '2027-02-29' },
    { ...schedule, offset: '-00:00' }, { ...schedule, offset: '+14:01' },
    { ...schedule, timezone: 'invalid' }, { ...schedule, localDate: '2101-01-01' },
    { ...schedule, localDate: '2026-11-15', localTime: '23:59' },
    { ...schedule, localDate: '2026-11-14' }])('rejects malformed/nonfuture schedule %#', value => {
    expect(parsePredictionSchedule(value, now)).toBeNull();
  });
  it.each(['bad', '2026-02-30T00:00:00.000Z', '2026-11-15T15:00:00Z'])('rejects invalid clock %s', clock => {
    expect(parsePredictionSchedule(schedule, clock)).toBeNull();
  });
  it('uses the selected zone day rather than UTC or device day', () => {
    const input = { localDate: '2026-11-16', localTime: '00:01', timezone: 'Pacific/Kiritimati', offset: '+14:00' };
    expect(parsePredictionSchedule(input, '2026-11-15T09:59:59.000Z')).not.toBeNull();
    expect(parsePredictionSchedule(input, '2026-11-15T10:00:00.000Z')).toBeNull();
  });
  it('rejects a DST gap and resolves both explicit fold choices separately', () => {
    const gap = { localDate: '2027-03-14', localTime: '02:30', timezone: 'America/New_York', offset: '-05:00' };
    expect(parsePredictionSchedule(gap, now)).toBeNull();
    expect(parsePredictionSchedule({ ...gap, offset: '-04:00' }, now)).toBeNull();
    const fold = { ...gap, localDate: '2027-11-07', localTime: '01:30' };
    expect(parsePredictionSchedule(fold, now)?.releaseAt).toBe('2027-11-07T06:30:00.000Z');
    expect(parsePredictionSchedule({ ...fold, offset: '-04:00' }, now)?.releaseAt).toBe('2027-11-07T05:30:00.000Z');
  });
});

describe('prediction body bounds', () => {
  it('normalizes multiline Unicode without treating astral characters as two', () => {
    expect(normalizePredictionBody('  e\u0301\r\ntext\r\nnext  ')).toBe('é\ntext\nnext');
    expect(normalizePredictionBody('😀'.repeat(2000))).toHaveLength(4000);
  });
  it.each([null, '', ' \n ', '\rtext', 'text\r', 'a\rb', 'a'.repeat(8001), 'a'.repeat(2001), '😀'.repeat(2001), '\ud800', '\udfff', 'a\ttext', 'a\u0000b', '\tsecret\t', '\u000bsecret\u000b', '\fsecret\f'])('rejects invalid text %#', body => {
    expect(normalizePredictionBody(body)).toBeNull();
  });
});

describe('metadata and visibility', () => {
  it('permits author immediately but never silently opens for recipient', () => {
    expect(validPrediction(prediction, scope)).toBe(true);
    expect(mayReadPrediction(prediction, scope, now)).toBe(true);
    expect(mayReadPrediction(prediction, other, before)).toBe(false);
    expect(mayReadPrediction(prediction, other, due)).toBe(false);
    expect(mayReadPrediction(prediction, other, '2026-11-16T06:00:00.001Z')).toBe(false);
    expect(prediction.openedAt).toBeNull();
  });
  it.each([null, [], { ...prediction, body: 'do not leak' }, { ...prediction, id: 'bad' },
    { ...prediction, authorId: recipient }, { ...prediction, version: 2 },
    { ...prediction, contentState: 'anything' }, { ...prediction, createdAt: 'bad' },
    { ...prediction, releaseAt: now }, { ...prediction, releaseAt: '2026-11-16T07:00:00.000Z' },
    { ...prediction, localDate: '2026-11-17' }, { ...prediction, timezone: 'US/Eastern' },
    { ...prediction, openedAt: before, version: 2 }, { ...prediction, openedAt: 'bad', version: 2 }])('rejects invalid metadata %#', value => {
    expect(validPrediction(value, scope)).toBe(false);
    expect(mayReadPrediction(value, other, due)).toBe(false);
  });
  it.each([{ ...scope, coupleId: recipient }, { ...scope, userId: couple },
    { ...scope, membershipEpoch: 2 }, { ...scope, userId: 'bad' },
    { ...scope, coupleId: 'bad' }, { ...scope, membershipEpoch: 0 },
    { ...scope, membershipEpoch: 2147483647 }])('fails closed across scope %#', badScope => {
    expect(mayReadPrediction(prediction, badScope, due)).toBe(false);
  });
  it('refuses clock rollback before creation and malformed clocks', () => {
    expect(mayReadPrediction(prediction, scope, '2026-11-14T00:00:00.000Z')).toBe(false);
    expect(mayReadPrediction(prediction, scope, 'bad')).toBe(false);
  });
});

describe('explicit transitions and canonical history', () => {
  const opened = { ...prediction, openedAt: due, version: 2 };
  const removed = { ...prediction, contentState: 'removed' as const, version: 2 };
  const openedRemoved = { ...opened, contentState: 'removed' as const, version: 3 };
  it('receipt is explicit recipient-only, due-only, CAS protected and does not consume reading', () => {
    expect(acknowledgePrediction(prediction, other, due, 1, true)).toEqual(opened);
    expect(acknowledgePrediction(prediction, scope, due, 1, true)).toBeNull();
    expect(acknowledgePrediction(prediction, other, before, 1, true)).toBeNull();
    expect(acknowledgePrediction(prediction, other, due, 1, false)).toBeNull();
    expect(acknowledgePrediction(prediction, other, due, 2, true)).toBeNull();
    expect(acknowledgePrediction(opened, other, due, 2, true)).toBeNull();
    expect(mayReadPrediction(opened, other, due)).toBe(true);
    expect(mayReadPrediction(opened, other, before)).toBe(false);
  });
  it('only author can remove; removal is terminal for both regardless of receipt/deadline', () => {
    expect(removePrediction(prediction, scope, 1, true)).toEqual(removed);
    expect(removePrediction(opened, scope, 2, true)).toEqual(openedRemoved);
    expect(removePrediction(prediction, other, 1, true)).toBeNull();
    expect(removePrediction(prediction, scope, 2, true)).toBeNull();
    expect(removePrediction(prediction, scope, 1, false)).toBeNull();
    expect(removePrediction(removed, scope, 2, true)).toBeNull();
    expect(removePrediction(null, scope, 1, true)).toBeNull();
    for (const value of [removed, openedRemoved]) {
      expect(validPrediction(value, scope)).toBe(true);
      expect(mayReadPrediction(value, scope, due)).toBe(false);
      expect(mayReadPrediction(value, other, due)).toBe(false);
      expect(acknowledgePrediction(value, other, due, value.version, true)).toBeNull();
    }
  });
  it('accepts repeated/forward history, rejects rewrites, rollback and receipt after removal', () => {
    for (const [a, b] of [[prediction, prediction], [prediction, opened], [prediction, removed],
      [prediction, openedRemoved], [opened, openedRemoved], [removed, removed]]) {
      expect(followsPrediction(a, b, scope)).toBe(true);
    }
    for (const [a, b] of [[null, opened], [prediction, null], [opened, prediction],
      [removed, prediction], [removed, openedRemoved], [opened, { ...opened, openedAt: '2026-11-17T00:00:00.000Z' }],
      [prediction, { ...prediction, id: recipient }]]) {
      expect(followsPrediction(a, b, scope)).toBe(false);
    }
  });
});


describe('voluntary refusal', () => {
  const declined = { ...prediction, declinedAt: now, version: 2 };
  it('allows explicit recipient refusal while sealed, without erasing author access', () => {
    expect(declinePrediction(prediction, other, now, 1, true)).toEqual(declined);
    expect(mayReadPrediction(declined, other, due)).toBe(false);
    expect(mayReadPrediction(declined, scope, now)).toBe(true);
    expect(acknowledgePrediction(declined, other, due, 2, true)).toBeNull();
    expect(followsPrediction(prediction, declined, scope)).toBe(true);
    expect(followsPrediction(declined, prediction, scope)).toBe(false);
    expect(followsPrediction(declined, { ...declined, declinedAt: due }, scope)).toBe(false);
    const removed = removePrediction(declined, scope, 2, true)!;
    expect(removed.version).toBe(3);
    expect(followsPrediction(declined, removed, scope)).toBe(true);
    expect(mayReadPrediction(removed, scope, due)).toBe(false);
    expect(followsPrediction({ ...prediction, contentState: 'removed', version: 2 }, removed, scope)).toBe(false);
  });
  it('fails closed on invalid state, role, consent, clock and CAS', () => {
    for (const value of [null, declined, { ...prediction, openedAt: due, version: 2 },
      { ...prediction, contentState: 'removed', version: 2 }]) {
      expect(declinePrediction(value, other, due, 2, true)).toBeNull();
    }
    expect(declinePrediction(prediction, scope, due, 1, true)).toBeNull();
    expect(declinePrediction(prediction, other, due, 1, false)).toBeNull();
    expect(declinePrediction(prediction, other, due, 2, true)).toBeNull();
    expect(declinePrediction(prediction, other, 'bad', 1, true)).toBeNull();
    expect(declinePrediction(prediction, other, '2026-11-14T00:00:00.000Z', 1, true)).toBeNull();
    for (const value of [{ ...declined, declinedAt: 'bad' }, { ...declined, declinedAt: '2026-11-14T00:00:00.000Z' },
      { ...declined, openedAt: due }, { ...prediction, declinedAt: undefined }]) {
      expect(validPrediction(value, scope)).toBe(false);
    }
  });
  it('does not use a future opening after server clock rollback', () => {
    const late = '2026-11-17T00:00:00.000Z';
    const opened = acknowledgePrediction(prediction, other, late, 1, true)!;
    expect(mayReadPrediction(opened, other, due)).toBe(false);
    expect(mayReadPrediction(opened, other, late)).toBe(true);
    expect(acknowledgePrediction(prediction, other, 'bad', 1, true)).toBeNull();
  });
});


describe('untrusted runtime values', () => {
  it.each([['active'], ['removed'], { toString: () => 'active' }])('rejects coerced content state %#', contentState => {
    expect(validPrediction({ ...prediction, contentState }, scope)).toBe(false);
  });
  it.each(['false', 'true', 1, {}, [], null, undefined])('requires literal confirmation true %#', input => {
    const confirmation = input as boolean;
    expect(acknowledgePrediction(prediction, other, due, 1, confirmation)).toBeNull();
    expect(declinePrediction(prediction, other, due, 1, confirmation)).toBeNull();
    expect(removePrediction(prediction, scope, 1, confirmation)).toBeNull();
  });
});
