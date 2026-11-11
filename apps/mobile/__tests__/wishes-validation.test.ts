import { normalizeTaskTitle } from '../../../packages/domain/tasks/title';
import { fixture, ack, envelope, wish, uuid, context } from './wishes-fixtures';
import { validWish, sameWishContext, wishOrder } from '../src/auth/wishes-state';
it.each(['id', 'creatorId', 'coupleId', 'membershipEpoch', 'title', 'state', 'version', 'createdAt', 'updatedAt'])('rejects invalid wish %s', async field => {
  const f = fixture(); f.operation.mockResolvedValue(ack({ ...wish, [field]: 'bad' })); await (f.api.setConsent(true), f.api.create());
  expect(f.api.getSnapshot()).toMatchObject({ status: 'retry', error: true });
});
it.each([null, [], {}, { ok: false }, { ok: true, value: null }, { ok: true, value: { wish } }])('rejects malformed envelope %p', async body => {
  const f = fixture(); f.operation.mockResolvedValue(new Response(JSON.stringify(body))); await (f.api.setConsent(true), f.api.create()); expect(f.api.getSnapshot().status).toBe('retry');
});
it.each([
  { wish: { ...wish, version: 0 } }, { wish: { ...wish, version: 1.1 } }, { wish: { ...wish, version: Number.MAX_SAFE_INTEGER + 1 } },
  { wish: { ...wish, createdAt: 123 } }, { wish: { ...wish, updatedAt: '2026-11-09T00:00:00.000Z' } },
  { wish: { ...wish, title: ' unnormalized ' } }, { wish: { ...wish, creatorId: uuid(4) } },
  { wish: { ...wish, state: 'fulfilled' } }, { wish: { ...wish, version: 2 }, replay: false },
  { commandId: uuid(8) }, { replay: 'true' }, { appliedVersion: 2 }, { wish: { ...wish, extra: true } },
])('rejects mismatched ACK %p', async changes => {
  const f = fixture(); f.operation.mockResolvedValue(envelope({ wish, commandId: uuid(3), replay: false, appliedVersion: 1, ...changes }));
  await (f.api.setConsent(true), f.api.create()); expect(f.api.getSnapshot().status).toBe('retry');
});
it('rejects malformed JSON, wrong operation target, old current version', async () => {
  const f = fixture(); f.operation.mockResolvedValueOnce(new Response('no JSON')); await (f.api.setConsent(true), f.api.create()); expect(f.api.getSnapshot().status).toBe('retry');
  f.controller.reset(); f.controller.sync(); f.operation.mockResolvedValueOnce(envelope({ wishes: [wish], limit: 50 })); await f.api.list();
  f.operation.mockResolvedValueOnce(ack({ ...wish, id: uuid(8), version: 2, state: 'fulfilled' }, 2)); await f.api.fulfill(wish.id);
  expect(f.api.getSnapshot().status).toBe('retry');
  f.operation.mockResolvedValueOnce(ack(wish, 2, true)); await f.api.retry(); expect(f.api.getSnapshot().status).toBe('retry');
});
it.each([
  { wishes: null, limit: 50 }, { wishes: [], limit: 51 }, { wishes: [null], limit: 50 },
  { wishes: [wish, wish], limit: 50 }, { wishes: Array(51).fill(wish), limit: 50 },
  { wishes: [{ ...wish, coupleId: uuid(22) }], limit: 50 },
  { wishes: [wish, { ...wish, id: uuid(10) }], limit: 50 },
  { wishes: [wish, { ...wish, id: uuid(8), createdAt: '2026-11-11T00:00:00.000Z', updatedAt: '2026-11-11T00:00:00.000Z' }], limit: 50 },
])('rejects malformed, unsorted, foreign or unbounded list %p', async value => {
  const f = fixture(); f.operation.mockResolvedValue(envelope(value)); await f.api.list();
  expect(f.api.getSnapshot()).toMatchObject({ error: true, checked: false, wishes: [] });
});
it('keeps list bounded and sorted after ACK, including ID tie breaking', async () => {
  const f = fixture(); const wishes = Array.from({ length: 50 }, (_, i) => ({ ...wish, id: uuid(100 - i) }));
  f.operation.mockResolvedValueOnce(envelope({ wishes, limit: 50 })); await f.api.list();
  f.operation.mockResolvedValueOnce(ack({ ...wish, createdAt: '2026-11-11T00:00:00.000Z', updatedAt: '2026-11-11T00:00:00.000Z' }));
  await (f.api.setConsent(true), f.api.create()); expect(f.api.getSnapshot().wishes).toHaveLength(50); expect(f.api.getSnapshot().wishes[0].id).toBe(wish.id);
});
it('validates pure state boundaries and deterministic comparator', () => {
  expect(validWish(wish, { ...context, state: 'waiting_partner' })).toBe(false);
  expect(sameWishContext(context, { ...context, userId: uuid(8) })).toBe(false);
  expect(sameWishContext(context, { ...context, state: 'waiting_partner' })).toBe(false);
  expect(wishOrder(wish, wish)).toBe(0);
  expect(wishOrder(wish, { ...wish, id: uuid(8) })).toBe(-1);
  expect(wishOrder(wish, { ...wish, createdAt: '2026-11-09T00:00:00.000Z' })).toBe(-1);
});
it('normalizes domain Unicode titles and enforces every input boundary on mobile', () => {
  expect(normalizeTaskTitle(null)).toEqual({ ok: false });
  expect(normalizeTaskTitle('x'.repeat(1601))).toEqual({ ok: false });
  expect(normalizeTaskTitle('\t Cafe\u0301\n together  ')).toEqual({ ok: true, text: 'Café together' });
  expect(normalizeTaskTitle('😀'.repeat(200))).toEqual({ ok: true, text: '😀'.repeat(200) });
  expect(normalizeTaskTitle('\u200B')).toEqual({ ok: false });
});
