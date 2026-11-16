import { describe, it, expect } from 'vitest';
import { nextCapsuleYear, parseCapsuleSchedule, normalizeCapsuleBody, validCapsule,
  mayReadCapsule, capsuleStatus, resealCapsule, removeCapsule, type Capsule } from '../../../packages/domain/capsules/policy.ts';

const author = '11111111-1111-4111-8111-111111111111';
const partner = '22222222-2222-4222-8222-222222222222';
const couple = '33333333-3333-4333-8333-333333333333';
const scope = { userId: author, coupleId: couple, membershipEpoch: 1 };
const now = '2026-11-16T08:00:00.000Z';
const due = '2027-11-16T06:00:00.000Z';
const before = '2027-11-16T05:59:59.999Z';
const schedule = { localDate: '2027-11-16', localTime: '09:00', timezone: 'Europe/Moscow', offset: '+03:00' };
const capsule: Capsule = { id: '44444444-4444-4444-8444-444444444444', coupleId: couple,
  authorId: author, membershipEpoch: 1, version: 1, createdAt: now, sealedAt: now,
  ...schedule, releaseAt: due, contentState: 'active' };
const later = '2026-11-17T08:00:00.000Z';

describe('capsule calendar and explicit schedule', () => {
  it.each([['2026-11-16', '2027-11-16'], ['2028-02-29', '2029-02-28'],
    ['2027-02-28', '2028-02-28'], ['2099-12-31', '2100-12-31']])('suggests a calendar year from %s', (input, expected) => {
    expect(nextCapsuleYear(input)).toBe(expected);
  });
  it.each([null, [], '', '2026-2-01', '2027-02-29', '2026-02-30', '2026-13-01', '2100-01-01', '1999-01-01'])('rejects malformed default date %#', input => {
    expect(nextCapsuleYear(input)).toBeNull();
  });
  it('freezes a canonical UTC instant without inferring a device zone', () => {
    expect(parseCapsuleSchedule(schedule, now)).toEqual({ ...schedule, releaseAt: due });
    expect(parseCapsuleSchedule({ ...schedule, timezone: 'US/Eastern', offset: '-05:00' }, now)?.timezone).toBe('America/New_York');
  });
  it.each([null, [], {}, { ...schedule, text: 'secret' }, { ...schedule, timezone: null },
    { ...schedule, timezone: 'invalid' }, { ...schedule, localTime: '24:00' },
    { ...schedule, localDate: '2027-02-29' }, { ...schedule, offset: '+14:01' },
    { ...schedule, offset: '-00:00' }, { ...schedule, offset: '+02:00' },
    { ...schedule, localDate: '2026-11-16', localTime: '23:59' },
    { ...schedule, localDate: '2026-11-15' }])('fails closed for schedule %#', value => {
    expect(parseCapsuleSchedule(value, now)).toBeNull();
  });
  it.each(['bad', '2026-02-30T00:00:00.000Z', '2026-11-16T08:00:00Z'])('rejects a malformed clock %s', clock => {
    expect(parseCapsuleSchedule(schedule, clock)).toBeNull();
  });
  it('uses the selected local day, not the UTC date', () => {
    const input = { localDate: '2026-11-17', localTime: '00:01', timezone: 'Pacific/Kiritimati', offset: '+14:00' };
    expect(parseCapsuleSchedule(input, '2026-11-16T09:59:59.000Z')).not.toBeNull();
    expect(parseCapsuleSchedule(input, '2026-11-16T10:00:00.000Z')).toBeNull();
  });
  it('does not silently shift DST gaps or select a fold', () => {
    const gap = { localDate: '2027-03-14', localTime: '02:30', timezone: 'America/New_York', offset: '-05:00' };
    expect(parseCapsuleSchedule(gap, now)).toBeNull();
    expect(parseCapsuleSchedule({ ...gap, offset: '-04:00' }, now)).toBeNull();
    const fold = { ...gap, localDate: '2027-11-07', localTime: '01:30' };
    expect(parseCapsuleSchedule(fold, now)?.releaseAt).toBe('2027-11-07T06:30:00.000Z');
    expect(parseCapsuleSchedule({ ...fold, offset: '-04:00' }, now)?.releaseAt).toBe('2027-11-07T05:30:00.000Z');
  });
});

describe('bounded capsule text', () => {
  it('normalizes Unicode and line endings, counting codepoints', () => {
    expect(normalizeCapsuleBody(' e\u0301\r\nsecond ')).toBe('é\nsecond');
    expect(normalizeCapsuleBody('😀'.repeat(2000))).toHaveLength(4000);
  });
  it.each([null, '', ' \n ', 'a\rb', 'a\tb', 'a\u0000b', '\ud800', '\udfff',
    'a'.repeat(8001), 'a'.repeat(2001), '😀'.repeat(2001)])('rejects invalid body %#', input => {
    expect(normalizeCapsuleBody(input)).toBeNull();
  });
});

describe('strict private metadata and release', () => {
  it('hides text even from the author until the exact release boundary', () => {
    expect(validCapsule(capsule, scope)).toBe(true);
    expect(mayReadCapsule(capsule, scope, now)).toBe(false);
    expect(mayReadCapsule(capsule, scope, before)).toBe(false);
    expect(mayReadCapsule(capsule, scope, due)).toBe(true);
    expect(mayReadCapsule(capsule, scope, '2028-01-01T00:00:00.000Z')).toBe(true);
    expect(capsuleStatus(capsule, scope, now)).toBe('sealed');
    expect(capsuleStatus(capsule, scope, due)).toBe('ready');
    expect(capsuleStatus(capsule, scope, 'bad')).toBeNull();
    expect(capsuleStatus(capsule, scope, '2026-11-15T00:00:00.000Z')).toBeNull();
    expect(mayReadCapsule(capsule, scope, 'bad')).toBe(false);
  });
  it.each([{ ...scope, userId: partner }, { ...scope, coupleId: partner },
    { ...scope, membershipEpoch: 2 }, { ...scope, userId: '' },
    { ...scope, coupleId: '' }, { ...scope, membershipEpoch: 0 },
    { ...scope, membershipEpoch: 1.5 }, { ...scope, membershipEpoch: 2147483647 }])('denies partner, other couple and stale/invalid scope %#', input => {
    expect(validCapsule(capsule, input)).toBe(false);
    expect(mayReadCapsule(capsule, input, due)).toBe(false);
    expect(capsuleStatus(capsule, input, due)).toBeNull();
    expect(resealCapsule(capsule, input, later, 1, schedule, true)).toBeNull();
    expect(removeCapsule(capsule, input, now, 1, true)).toBeNull();
  });
  it.each([null, [], {}, { ...capsule, body: 'must never enter metadata' },
    { ...capsule, id: 'bad' }, { ...capsule, authorId: partner }, { ...capsule, version: 0 },
    { ...capsule, version: 1.5 }, { ...capsule, version: 2147483647 },
    { ...capsule, createdAt: 'bad' }, { ...capsule, sealedAt: 'bad' },
    { ...capsule, sealedAt: '2026-11-15T00:00:00.000Z' },
    { ...capsule, sealedAt: later }, { ...capsule, contentState: 'removed' },
    { ...capsule, sealedAt: later, contentState: 'removed', version: 2 },
    { ...capsule, version: 2147483646 },
    { ...capsule, contentState: 'bad' }, { ...capsule, releaseAt: 'bad' },
    { ...capsule, releaseAt: now }, { ...capsule, releaseAt: '2027-11-16T07:00:00.000Z' },
    { ...capsule, timezone: 'US/Eastern' }, { ...capsule, timezone: null },
    { ...capsule, localDate: '2027-02-29' }])('rejects corrupt metadata %#', input => {
    expect(validCapsule(input, scope)).toBe(false);
    expect(mayReadCapsule(input, scope, due)).toBe(false);
  });
});

describe('explicit reseal and terminal removal', () => {
  it('replaces metadata before release without mutating the input or exposing any body', () => {
    const input = Object.freeze({ ...capsule });
    const next = resealCapsule(input, scope, later, 1, { ...schedule, localDate: '2028-11-16' }, true)!;
    expect(next).toEqual({ ...capsule, localDate: '2028-11-16', releaseAt: '2028-11-16T06:00:00.000Z', sealedAt: later, version: 2 });
    expect(validCapsule(next, scope)).toBe(true);
    expect(input.version).toBe(1);
    expect(next).not.toHaveProperty('body');
    expect(resealCapsule(next, scope, later, 1, schedule, true)).toBeNull();
    expect(resealCapsule(next, scope, later, 2, schedule, true)?.version).toBe(3);
  });
  it('allows a shorter future schedule but not today or any old due capsule', () => {
    expect(resealCapsule(capsule, scope, later, 1, { ...schedule, localDate: '2026-11-18' }, true)?.releaseAt).toBe('2026-11-18T06:00:00.000Z');
    expect(resealCapsule(capsule, scope, later, 1, { ...schedule, localDate: '2026-11-17' }, true)).toBeNull();
    expect(resealCapsule(capsule, scope, due, 1, { ...schedule, localDate: '2028-11-16' }, true)).toBeNull();
    expect(resealCapsule(capsule, scope, '2028-01-01T00:00:00.000Z', 1, schedule, true)).toBeNull();
  });
  it('fails closed for unconfirmed, stale and invalid-clock mutations', () => {
    expect(resealCapsule(capsule, scope, later, 1, schedule, false)).toBeNull();
    expect(resealCapsule(capsule, scope, later, 0, schedule, true)).toBeNull();
    expect(resealCapsule(capsule, scope, 'bad', 1, schedule, true)).toBeNull();
    expect(resealCapsule(capsule, scope, '2026-11-15T00:00:00.000Z', 1, schedule, true)).toBeNull();
    expect(resealCapsule(capsule, scope, later, 1, {}, true)).toBeNull();
    expect(removeCapsule(capsule, scope, now, 1, false)).toBeNull();
    expect(removeCapsule(capsule, scope, now, 0, true)).toBeNull();
    expect(removeCapsule(capsule, scope, 'bad', 1, true)).toBeNull();
    expect(removeCapsule(capsule, scope, '2026-11-15T00:00:00.000Z', 1, true)).toBeNull();
  });
  it('allows removal before or after release but never resurrection or subsequent reads', () => {
    for (const clock of [now, due]) {
      const removed = removeCapsule(capsule, scope, clock, 1, true)!;
      expect(removed).toEqual({ ...capsule, contentState: 'removed', version: 2 });
      expect(validCapsule(removed, scope)).toBe(true);
      expect(capsuleStatus(removed, scope, due)).toBe('removed');
      expect(mayReadCapsule(removed, scope, due)).toBe(false);
      expect(removeCapsule(removed, scope, due, 2, true)).toBeNull();
      expect(resealCapsule(removed, scope, later, 2, schedule, true)).toBeNull();
    }
  });
  it('reserves the last version for removal, without integer overflow', () => {
    const near = { ...capsule, version: 2147483644 };
    const lastActive = resealCapsule(near, scope, later, near.version, schedule, true)!;
    expect(lastActive.version).toBe(2147483645);
    expect(resealCapsule(lastActive, scope, later, lastActive.version, schedule, true)).toBeNull();
    const removed = removeCapsule(lastActive, scope, later, lastActive.version, true)!;
    expect(removed.version).toBe(2147483646);
    expect(validCapsule(removed, scope)).toBe(true);
    expect(removeCapsule({ ...capsule, version: 2147483646 }, scope, later, 2147483646, true)).toBeNull();
  });
});
