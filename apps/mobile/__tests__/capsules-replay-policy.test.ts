import { followsCapsule, resealCapsule, removeCapsule, type Capsule } from '../../../packages/domain/capsules/policy.ts';

const author = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const couple = '33333333-3333-4333-8333-333333333333';
const scope = { userId: author, coupleId: couple, membershipEpoch: 1 };
const now = '2026-11-16T08:00:00.000Z';
const later = '2026-11-17T08:00:00.000Z';
const due = '2027-11-16T06:00:00.000Z';
const schedule = { localDate: '2027-11-16', localTime: '09:00', timezone: 'Europe/Moscow', offset: '+03:00' };
const nextSchedule = { ...schedule, localDate: '2028-11-16' };
const capsule: Capsule = { id: '44444444-4444-4444-8444-444444444444', coupleId: couple,
  authorId: author, membershipEpoch: 1, version: 1, createdAt: now, sealedAt: now,
  ...schedule, releaseAt: due, contentState: 'active' };
const resealed = resealCapsule(capsule, scope, later, 1, nextSchedule, true)!;
const removed = removeCapsule(capsule, scope, later, 1, true)!;

it('accepts identical metadata and the real single reseal and removal transitions', () => {
  expect(followsCapsule(capsule, { ...capsule }, scope)).toBe(true);
  expect(followsCapsule(capsule, resealed, scope)).toBe(true);
  expect(followsCapsule(capsule, removed, scope)).toBe(true);
  expect(followsCapsule(removed, { ...removed }, scope)).toBe(true);
});
it.each([null, {}, { ...capsule, text: 'forbidden' }, { ...capsule, version: 0 },
  { ...capsule, sealedAt: 'bad' }, { ...capsule, offset: '+02:00' }])('rejects invalid old or new metadata %#', value => {
  expect(followsCapsule(value, capsule, scope)).toBe(false);
  expect(followsCapsule(capsule, value, scope)).toBe(false);
});
it.each([{ id: other }, { coupleId: other }, { authorId: other }, { membershipEpoch: 2 },
  { createdAt: '2026-11-15T08:00:00.000Z' }])('rejects changed immutable identity %#', patch => {
  expect(followsCapsule(capsule, { ...resealed, ...patch }, scope)).toBe(false);
});
it('rejects stale versions, reversed sealing time and same-version mutation', () => {
  expect(followsCapsule(resealed, capsule, scope)).toBe(false);
  expect(followsCapsule(resealed, { ...resealed, version: 3, sealedAt: now }, scope)).toBe(false);
  expect(followsCapsule(capsule, { ...resealed, version: 1 }, scope)).toBe(false);
  expect(followsCapsule(resealed, { ...resealed, localTime: '10:00', releaseAt: '2028-11-16T07:00:00.000Z' }, scope)).toBe(false);
});
it.each([due, '2027-11-17T08:00:00.000Z'])('rejects a single reseal at or after the old deadline %s', sealedAt => {
  expect(followsCapsule(capsule, { ...resealed, sealedAt }, scope)).toBe(false);
});
it('single removal cannot mutate its schedule or sealing timestamp', () => {
  expect(followsCapsule(capsule, { ...removed, ...nextSchedule, releaseAt: resealed.releaseAt }, scope)).toBe(false);
  expect(followsCapsule(resealed, { ...resealed, contentState: 'removed', version: 3, sealedAt: '2026-11-18T08:00:00.000Z' }, scope)).toBe(false);
});
it('removed metadata is terminal even with increasing versions', () => {
  expect(followsCapsule(removed, { ...removed, version: 3 }, scope)).toBe(false);
  expect(followsCapsule(removed, { ...resealed, version: 3 }, scope)).toBe(false);
  expect(followsCapsule(removed, { ...removed, id: other }, scope)).toBe(false);
});
it('multiple reseals can extend the deadline before a later seal beyond the original deadline', () => {
  const twice = resealCapsule(resealed, scope, '2027-11-17T08:00:00.000Z', 2,
    { ...schedule, localDate: '2029-11-16' }, true)!;
  expect(followsCapsule(capsule, twice, scope)).toBe(true);
  expect(followsCapsule(capsule, removeCapsule(twice, scope, '2027-11-18T08:00:00.000Z', 3, true), scope)).toBe(true);
});
it('delta two ending removed allows only one reseal, strictly before the old deadline', () => {
  const resealedRemoved = removeCapsule(resealed, scope, later, 2, true)!;
  expect(followsCapsule(capsule, resealedRemoved, scope)).toBe(true);
  for (const sealedAt of [due, '2027-11-17T08:00:00.000Z']) {
    expect(followsCapsule(capsule, { ...resealedRemoved, sealedAt }, scope)).toBe(false);
    expect(followsCapsule(capsule, { ...resealedRemoved, sealedAt, version: 4 }, scope)).toBe(true);
  }
});
