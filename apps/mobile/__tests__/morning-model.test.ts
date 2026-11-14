import { canonicalMorningSlot, parseMorningPage, parseMorningPreference, parseMorningSlot,
  type MorningScope, type MorningSlot } from '../src/auth/morning-model';
const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const scope: MorningScope = { userId: id(1), coupleId: id(3), membershipEpoch: 1 };
const slot: MorningSlot = {
  id: id(4), coupleId: id(3), membershipEpoch: 1, senderId: id(1), recipientId: id(2),
  localDate: '2026-11-12', localTime: '09:00', timezone: 'UTC', offset: '+00:00',
  releaseAt: '2026-11-12T09:00:00.000Z', preferenceVersion: 1,
  createdAt: '2026-11-11T00:00:00.000Z', state: 'sealed', prepared: false,
};
const preference = { userId: id(1), timezone: 'UTC', localTime: '09:00', version: 1 };
const page = () => ({ readId: id(9), serverNow: '2026-11-12T08:00:00.000Z', preferences: [preference],
  slots: [slot], hasOlder: false, hasNewer: false, olderCursor: null, newerCursor: null, lastAvailableId: null });
const parse = (v: unknown) => parseMorningPage(v, scope, id(9), 'latest');
describe('morning metadata privacy and snapshot validation', () => {
  test('sender readiness required, recipient readiness forbidden; no body leak', () => {
    expect(parseMorningSlot(slot, scope)).toEqual(slot);
    const { prepared: _prepared, ...incoming } = { ...slot, senderId: id(2), recipientId: id(1), openedAt: null };
    expect(parseMorningSlot(incoming, scope)).toEqual(incoming);
    expect(parseMorningSlot({ ...incoming, prepared: false }, scope)).toBeNull();
    expect(parseMorningSlot({ ...slot, prepared: undefined }, scope)).toBeNull();
    expect(parseMorningSlot({ ...slot, body: 'secret' }, scope)).toBeNull();
    expect(parseMorningSlot(null, scope)).toBeNull();
    expect(parseMorningSlot(slot, { ...scope, membershipEpoch: 0 })).toBeNull();
  });
  test.each([
    { id: 'bad' }, { coupleId: id(5) }, { membershipEpoch: 2 }, { senderId: id(5), recipientId: id(6) },
    { recipientId: id(1) }, { senderId: 'bad' }, { recipientId: 'bad' }, { preferenceVersion: 0 },
    { localDate: '2101-01-01' }, { localDate: '2026-02-30' }, { localTime: '24:00' },
    { timezone: 'Invalid/Zone' }, { timezone: '' }, { offset: '+14:01' }, { offset: '-00:00' },
    { offset: '+15:00' }, { releaseAt: '2026-11-12T09:00:00Z' }, { releaseAt: '2026-11-12T10:00:00.000Z' },
    { createdAt: 'invalid' }, { createdAt: slot.releaseAt }, { state: 'read' },
    { state: 'available', prepared: false }, { state: 'missed', prepared: true },
  ])('rejects malformed or cross-scope slot %j', patch => {
    expect(parseMorningSlot({ ...slot, ...patch }, scope)).toBeNull();
  });
  test('offset snapshot is arithmetic, independent from current timezone rules', () => {
    expect(parseMorningSlot({ ...slot, offset: '+05:30', releaseAt: '2026-11-12T03:30:00.000Z' }, scope)).not.toBeNull();
    expect(parseMorningSlot({ ...slot, offset: '-04:00', releaseAt: '2026-11-12T13:00:00.000Z' }, scope)).not.toBeNull();
    expect(parseMorningSlot({ ...slot, state: 'available', prepared: true }, scope)).not.toBeNull();
    expect(parseMorningSlot({ ...slot, state: 'missed' }, scope)).not.toBeNull();
  });
  test('preferences exact shape and valid zone/time/version', () => {
    expect(parseMorningPreference(preference)).toEqual(preference);
    expect(parseMorningPreference(preference, scope)).toEqual(preference);
    for (const v of [null, [], { ...preference, extra: 1 }, { ...preference, userId: 'bad' },
      { ...preference, timezone: 'x'.repeat(101) }, { ...preference, localTime: 9 },
      { ...preference, localTime: '9:00' }, { ...preference, version: 1.1 }]) {
      expect(parseMorningPreference(v)).toBeNull();
    }
    expect(parseMorningPreference(preference, { ...scope, userId: 'bad' })).toBeNull();
  });
});
describe('morning page boundaries', () => {
  test('valid first/empty page, off-page incoming latest identifier', () => {
    expect(parse(page())).toEqual(page());
    expect(parse({ ...page(), slots: [], preferences: [], lastAvailableId: id(20) })).not.toBeNull();
    const incoming = { ...slot, senderId: id(2), recipientId: id(1), state: 'available', openedAt: null };
    delete (incoming as Partial<MorningSlot>).prepared;
    expect(parse({ ...page(), slots: [incoming], serverNow: slot.releaseAt, lastAvailableId: slot.id })).not.toBeNull();
  });
  test.each([
    { readId: id(8) }, { extra: true }, { serverNow: 'bad' }, { hasOlder: 1 }, { hasNewer: true },
    { lastAvailableId: 'bad' }, { lastAvailableId: slot.id }, { preferences: [preference, preference] },
    { preferences: [{ ...preference, userId: id(5) }] }, { slots: [slot, slot] },
    { slots: Array(31).fill(slot) }, { preferences: Array(3).fill(preference) },
    { preferences: [null] }, { slots: [null] }, { hasOlder: true }, { olderCursor: { id: id(7), releaseAt: slot.releaseAt } },
    { serverNow: slot.releaseAt }, { slots: [{ ...slot, state: 'available', prepared: true }] },
  ])('rejects invalid page %j', patch => { expect(parse({ ...page(), ...patch })).toBeNull(); });
  test('descending tie order and anchor edges/cursors', () => {
    const newer = { ...slot, id: id(5) };
    const cursor = { id: slot.id, releaseAt: slot.releaseAt };
    const first = { ...page(), slots: [newer, slot], hasOlder: true, olderCursor: cursor };
    expect(parse(first)).not.toBeNull();
    expect(parse({ ...first, slots: [slot, newer] })).toBeNull();
    expect(parseMorningPage(page(), scope, id(9), 'before', { ...cursor, id: id(5) })).not.toBeNull();
    expect(parseMorningPage(page(), scope, id(9), 'after', { ...cursor, id: id(2) })).not.toBeNull();
    expect(parseMorningPage(page(), scope, id(9), 'before', cursor)).toBeNull();
    expect(parseMorningPage(page(), scope, id(9), 'after', cursor)).toBeNull();
    expect(parseMorningPage(page(), scope, id(9), 'before')).toBeNull();
    expect(parseMorningPage(page(), scope, id(9), 'after', { id: 'bad', releaseAt: '' })).toBeNull();
    expect(parseMorningPage(first, scope, id(9), 'oldest')).toBeNull();
    expect(parseMorningPage({ ...page(), hasNewer: true, newerCursor: cursor }, scope, id(9), 'oldest')).not.toBeNull();
    expect(parseMorningPage(page(), scope, 'bad', 'latest')).toBeNull();
    expect(parse(null)).toBeNull();
  });
});
describe('canonical slot transitions', () => {
  test('preserves immutable snapshot, readiness and terminal states', () => {
    const ready = { ...slot, prepared: true };
    const available: MorningSlot = { ...ready, state: 'available' };
    expect(canonicalMorningSlot(slot, ready)).toEqual(ready);
    expect(canonicalMorningSlot(ready, available)).toEqual(available);
    expect(canonicalMorningSlot(available, available)).toEqual(available);
    expect(canonicalMorningSlot(ready, slot)).toBeNull();
    expect(canonicalMorningSlot(available, ready)).toBeNull();
    expect(canonicalMorningSlot(slot, { ...slot, preferenceVersion: 2 })).toBeNull();
    const { prepared: _prepared, ...without } = slot;
    expect(canonicalMorningSlot(slot, without)).toBeNull();
    expect(canonicalMorningSlot({ ...slot, state: 'missed' }, available)).toBeNull();
  });
});

describe('recipient opening latch', () => {
  const { prepared: _prepared, ...metadata } = slot;
  const incoming: MorningSlot = { ...metadata, senderId: id(2), recipientId: id(1), openedAt: null };
  const opened: MorningSlot = { ...incoming, state: 'available', openedAt: slot.releaseAt };
  test('recipient requires latch field; sender must never expose it', () => {
    expect(parseMorningSlot(incoming, scope)).toEqual(incoming);
    const { openedAt: _openedAt, ...missing } = incoming;
    expect(parseMorningSlot(missing, scope)).toBeNull();
    expect(parseMorningSlot({ ...slot, openedAt: null }, scope)).toBeNull();
    for (const openedAt of ['bad', '2026-11-11T09:00:00.000Z']) {
      expect(parseMorningSlot({ ...opened, openedAt }, scope)).toBeNull();
    }
    expect(parseMorningSlot({ ...opened, state: 'sealed' }, scope)).toBeNull();
    expect(parseMorningSlot({ ...opened, state: 'missed' }, scope)).toBeNull();
  });
  test('latched available survives clock rollback without device inference', () => {
    expect(parseMorningSlot(opened, scope)).toEqual(opened);
    expect(parse({ ...page(), slots: [opened], lastAvailableId: opened.id })).not.toBeNull();
    expect(parse({ ...page(), slots: [{ ...opened, openedAt: null }] })).toBeNull();
  });
  test('opening is irreversible and original timestamp immutable', () => {
    expect(canonicalMorningSlot(incoming, opened)).toEqual(opened);
    expect(canonicalMorningSlot(opened, opened)).toEqual(opened);
    expect(canonicalMorningSlot(opened, { ...opened, openedAt: null })).toBeNull();
    expect(canonicalMorningSlot(opened, { ...opened, openedAt: '2026-11-12T10:00:00.000Z' })).toBeNull();
    expect(canonicalMorningSlot(opened, incoming)).toBeNull();
    expect(canonicalMorningSlot(incoming, { ...opened, openedAt: 'bad' })).toBeNull();
    const { openedAt: _openedAt, ...missing } = incoming;
    expect(canonicalMorningSlot(incoming, missing)).toBeNull();
  });
});
