import { validStem, followsStem, orderStems } from '../src/auth/stems-state';
import { own, incoming, completed, skipped, withdrawn, context, uuid, fixture, list } from './stems-fixtures';
it('strict role projections and finite legal states', () => {
    for (const q of [own, incoming, completed, skipped, withdrawn])
        expect(validStem(q, context)).toBe(true);
    const { recipientContinuation: _, ...removed } = { ...completed, recipientTextState: 'removed' as const, version: 3 };
    const { beginning: __, authorContinuation: ___, ...both } = { ...removed, authorTextState: 'removed' as const, version: 4 };
    const { beginning: _b, ...skipremoved } = { ...skipped, authorTextState: 'removed' as const, version: 3 };
    for (const q of [removed, both, skipremoved])
        expect(validStem(q, context)).toBe(true);
    for (const q of [null, {}, { ...incoming, authorContinuation: '' }, { ...skipped, authorContinuation: 'SECRET' }, { ...own, version: 99 }, { ...withdrawn, beginning: 'oops' }, { ...completed, recipientTextState: 'absent' }, { ...incoming, phase: 'withdrawn' }, { ...withdrawn, phase: 'waiting' }, { ...own, beginning: ' ' }, { ...own, authorContinuation: ' ' }, { ...completed, recipientContinuation: ' ' }, { ...completed, completedAt: own.createdAt.replace('10T', '09T') }, { ...own, sequence: 101 }, { ...own, recipientId: own.authorId }, { ...own, id: 'bad' }, { ...own, phase: 'unknown' }, { ...own, authorTextState: 'unknown' }, { ...own, recipientTextState: 'unknown' }])
        expect(validStem(q, context)).toBe(false);
    expect(validStem(own, { state: 'no_active_pair', sessionId: 's', userId: uuid(1) })).toBe(false);
    expect(followsStem(incoming, completed)).toBe(true);
    expect(followsStem(completed, removed)).toBe(true);
    expect(followsStem(removed, both)).toBe(true);
    for (const [a, b] of [[completed, incoming], [withdrawn, own], [removed, completed], [completed, { ...completed, recipientContinuation: 'changed' }], [completed, { ...completed, completedAt: '2026-11-10T00:02:00.000Z' }], [own, { ...own, beginning: 'Changed' }], [own, { ...own, id: uuid(99) }], [own, { ...own, authorContinuation: undefined }]] as const)
        expect(followsStem(a, b)).toBe(false);
    expect(followsStem(own, { ...own })).toBe(true);
    expect(orderStems(incoming, completed)).toBeLessThan(0);
});
it('actual maximum 100 completed UTF8 JSON histories fit bounded 2 MiB reader', async () => {
    const f = fixture();
    const rounds = Array.from({ length: 100 }, (_, i) => ({ ...completed, id: uuid(100 + i), sequence: 100 - i, beginning: '🧡'.repeat(500), authorContinuation: '🧡'.repeat(2000), recipientContinuation: '🧡'.repeat(2000) }));
    const response = list(rounds);
    const bytes = new TextEncoder().encode(await response.clone().text()).byteLength;
    expect(bytes).toBeGreaterThan(1800000);
    expect(bytes).toBeLessThan(2097152);
    f.operation.mockResolvedValueOnce(response);
    await f.api.load();
    expect(f.api.getSnapshot()).toMatchObject({ checked: true, used: 100 });
    expect(f.api.getSnapshot().rounds).toHaveLength(100);
});
it('rejects graph reversals even when advertised version increases', () => {
    expect(followsStem(completed, { ...completed, phase: 'skipped', version: 3 })).toBe(false);
    expect(followsStem(withdrawn, { ...own, version: 3 })).toBe(false);
    expect(followsStem({ ...completed, recipientTextState: 'removed', version: 3 }, { ...completed, version: 4 })).toBe(false);
    expect(followsStem(completed, { ...completed, completedAt: undefined, version: 3 })).toBe(false);
    const { recipientContinuation: _, ...missing } = { ...completed, recipientTextState: 'absent' };
    expect(validStem(missing, context)).toBe(false);
    expect(validStem({ ...incoming, recipientTextState: 'removed' }, context)).toBe(false);
});
