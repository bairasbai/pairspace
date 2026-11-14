import { parseScaleInput, validSlot, followsSlot, orderScale, exact } from '../src/auth/scale-state';
import { slot, removed, context, uuid } from './scale-fixtures';
it('blank is not zero; explicit decimal whole value only', () => {
    expect(parseScaleInput('0')).toBe(0);
    expect(parseScaleInput('100')).toBe(100);
    expect(parseScaleInput('50')).toBe(50);
    for (const value of ['', ' ', '-1', '-0', '101', '0.5', 'NaN', '01', '1e2', '+0', '1000'])
        expect(parseScaleInput(value)).toBeNull();
});
it('validates immutable date/zone identity, union and numeric value', () => {
    expect(validSlot(slot, context)).toBe(true);
    expect(validSlot(removed, context)).toBe(true);
    for (const value of [null, {}, { ...slot, state: 'other' }, { ...slot, extra: 1 }, { ...slot, id: 'bad' }, { ...slot, authorId: 'bad' }, { ...slot, coupleId: uuid(8) },
        { ...slot, membershipEpoch: 2 }, { ...slot, createdAt: 'bad' }, { ...slot, localDate: '2026-02-30' }, { ...slot, timezone: '+03:00' }, { ...slot, version: 0 },
        { ...slot, version: 2147483648 }, { ...slot, value: null }, { ...slot, value: 0.1 }, { ...slot, value: 101 }, { ...removed, version: 1 }, { ...removed, value: 0 }])
        expect(validSlot(value, context)).toBe(false);
    expect(validSlot(slot, { state: 'unmapped', sessionId: 'session' })).toBe(false);
    expect(exact({ b: 1, a: 2 }, 'a,b')).toBe(true);
});
it('removal fences old data but permits genuine higher version publication without restoring old cache', () => {
    expect(followsSlot(slot, { ...slot })).toBe(true);
    expect(followsSlot(slot, removed)).toBe(true);
    expect(followsSlot(removed, { ...slot, version: 3, value: 20 })).toBe(true);
    for (const next of [{ ...slot, version: 2 }, { ...slot, version: 1 }, { ...removed, id: uuid(8) }, { ...removed, localDate: '2026-11-09' }, { ...removed, timezone: 'Asia/Tokyo' }])
        expect(followsSlot(removed, next)).toBe(false);
    expect(followsSlot(slot, { ...slot, value: 9 })).toBe(false);
    expect(orderScale(slot, { ...slot, localDate: '2026-11-09' })).toBeLessThan(0);
    expect(orderScale(slot, { ...slot, authorId: uuid(8) })).toBeLessThan(0);
});
it('no-op cannot increment version; later genuine cycles can return same current value', () => {
    expect(followsSlot(slot, { ...slot, version: 2 })).toBe(false);
    expect(followsSlot(removed, { ...removed, version: 3 })).toBe(false);
    expect(followsSlot(slot, { ...slot, version: 3 })).toBe(true);
    expect(followsSlot(removed, { ...removed, version: 4 })).toBe(true);
    expect(followsSlot(removed, { ...slot, version: 3, value: 0 })).toBe(true);
});
