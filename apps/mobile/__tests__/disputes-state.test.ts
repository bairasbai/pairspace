import { emptyDisputes, createDisputeMetadata, joinDisputeMetadata, removeDisputeMetadata,
  mergeDispute, disputeOrder, validDisputeMetadata, type DisputeView, type DisputeMetadata } from '../src/auth/disputes-state';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope = { userId: id(1), coupleId: id(3), membershipEpoch: 1 }, recipient = { ...scope, userId: id(2) };
const now = '2026-11-16T08:00:00.000Z', later = '2026-11-16T09:00:00.000Z';
const create = (n = 4, at = now) => createDisputeMetadata({ id: id(n), recipientId: id(2),
  judgeDate: '2026-11-17', timezone: 'UTC' }, scope, at, true)!;
const initial = create(), joined = joinDisputeMetadata(initial, recipient, later, 1, true)!;
const view: DisputeView = { ...emptyDisputes, userId: id(1), checkedAt: now, disputes: [initial],
  generation: 1, used: 1, readerStatus: 'opened', reader: { dispute: initial, claim: 'Synthetic claim',
    condition: null, checkedAt: now, generation: 1 } };

it('strict wire metadata rejects body, sequence, enum coercions and broken states', () => {
  expect(validDisputeMetadata(initial, scope)).toBe(true);
  for (const field of ['contentState', 'decisionState'] as const) {
    for (const state of [[initial[field]], Object(initial[field]), { toString: () => initial[field] },
      { toString: () => { throw Error('no coercion'); } }, null, true, 1]) {
      expect(validDisputeMetadata({ ...initial, [field]: state }, scope)).toBe(false);
    }
  }
  for (const patch of [{ claim: 'private' }, { condition: null }, { sequence: 1 }, { version: 99 }]) {
    expect(validDisputeMetadata({ ...initial, ...patch }, scope)).toBe(false);
  }
});
it('merges monotonic metadata, preserves used floor and scrubs stale readers', () => {
  expect(mergeDispute(view, initial, now)).toEqual({ disputes: [initial], used: 1, reader: view.reader });
  expect(mergeDispute(view, joined, later)).toEqual({ disputes: [joined], used: 1, reader: null });
  expect(mergeDispute({ ...view, used: 99 }, initial, now).used).toBe(99);
  expect(mergeDispute({ ...view, reader: null }, initial, now).reader).toBeNull();
  expect(mergeDispute({ ...view, generation: 2 }, initial, now).reader).toBeNull();
  expect(mergeDispute(view, create(5), now).reader).toEqual(view.reader);
  const removed = removeDisputeMetadata(initial, scope, now, 1, true)!;
  expect(mergeDispute({ ...view, reader: { ...view.reader!, dispute: removed } }, create(5), now).reader).toBeNull();
  expect(mergeDispute({ ...view, checkedAt: null, disputes: [], used: 0 }, initial, now).used).toBe(1);
});
it('rejects clock rollback, event future, history rollback and over-capacity inserts', () => {
  expect(() => mergeDispute(view, initial, 'bad')).toThrow('invalid_dispute_revision');
  expect(() => mergeDispute(view, initial, '2026-11-16T07:00:00.000Z')).toThrow('invalid_dispute_revision');
  expect(() => mergeDispute(view, joined, now)).toThrow('invalid_dispute_revision');
  expect(() => mergeDispute({ ...view, disputes: [joined] }, initial, later)).toThrow('invalid_dispute_revision');
  expect(() => mergeDispute(view, { ...initial, claim: 'body' } as DisputeMetadata, now)).toThrow('invalid_dispute_revision');
  const full = { ...view, disputes: Array.from({ length: 100 }, (_, n) => create(n + 10)), used: 100 };
  expect(() => mergeDispute(full, initial, now)).toThrow('invalid_dispute_revision');
  expect(mergeDispute(full, full.disputes[0], now).disputes).toHaveLength(100);
});
it('orders records deterministically without exposing SQL sequence', () => {
  expect(disputeOrder(initial, initial)).toBe(0);
  expect(disputeOrder(initial, create(5))).toBe(1);
  expect(disputeOrder(create(5), initial)).toBe(-1);
  expect(disputeOrder(initial, create(5, later))).toBe(1);
  expect(disputeOrder(create(5, later), initial)).toBe(-1);
});
