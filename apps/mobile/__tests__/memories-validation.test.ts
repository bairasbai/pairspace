import { normalizeTaskTitle } from '../../../packages/domain/tasks/title';
import { fixture, ack, envelope, memory, uuid, context } from './memories-fixtures';
import { validMemory, sameMemoryContext, memoryOrder } from '../src/auth/memories-state';
it.each(['id', 'creatorId', 'coupleId', 'membershipEpoch', 'title', 'localDate', 'body', 'createdAt'])('rejects invalid memory %s', async field => {
  const f = fixture(); f.operation.mockResolvedValue(ack({ ...memory, [field]: 'bad' })); await f.api.create();
  expect(f.api.getSnapshot()).toMatchObject({ status: 'retry', error: true });
});
it.each([null, [], {}, { ok: false }, { ok: true, value: null }, { ok: true, value: { memory } }])('rejects malformed envelope %p', async body => {
  const f = fixture(); f.operation.mockResolvedValue(new Response(JSON.stringify(body))); await f.api.create(); expect(f.api.getSnapshot().status).toBe('retry');
});
it.each([
  { memory: { ...memory, createdAt: 123 } }, { memory: { ...memory, title: ' unnormalized ' } },
  { memory: { ...memory, creatorId: uuid(4) } }, { memory: { ...memory, title: 'Different' } },
  { memory: { ...memory, localDate: '2028-03-01' } }, { memory: { ...memory, body: 'Different body' } },
  { commandId: uuid(8) }, { replay: 'true' }, { memory: { ...memory, extra: true } },
])('rejects mismatched ACK %p', async changes => {
  const f = fixture(); f.operation.mockResolvedValue(envelope({ memory, commandId: uuid(3), replay: false, ...changes }));
  await f.api.create(); expect(f.api.getSnapshot().status).toBe('retry');
});
it('rejects malformed JSON', async () => {
  const f = fixture(); f.operation.mockResolvedValueOnce(new Response('no JSON')); await f.api.create();
  expect(f.api.getSnapshot().status).toBe('retry');
});
it.each([
  { memories: null, limit: 50 }, { memories: [], limit: 51 }, { memories: [null], limit: 50 },
  { memories: [memory, memory], limit: 50 }, { memories: Array(51).fill(memory), limit: 50 },
  { memories: [{ ...memory, coupleId: uuid(22) }], limit: 50 },
  { memories: [memory, { ...memory, id: uuid(10) }], limit: 50 },
  { memories: [memory, { ...memory, id: uuid(8), createdAt: '2026-11-11T00:00:00.000Z' }], limit: 50 },
])('rejects malformed, unsorted, foreign or unbounded list %p', async value => {
  const f = fixture(); f.operation.mockResolvedValue(envelope(value)); await f.api.list();
  expect(f.api.getSnapshot()).toMatchObject({ error: true, checked: false, memories: [] });
});
it('keeps list bounded and sorted after ACK, including ID tie breaking', async () => {
  const f = fixture(); const memories = Array.from({ length: 50 }, (_, i) => ({ ...memory, id: uuid(100 - i) }));
  f.operation.mockResolvedValueOnce(envelope({ memories, limit: 50 })); await f.api.list();
  f.operation.mockResolvedValueOnce(ack({ ...memory, createdAt: '2026-11-11T00:00:00.000Z' }));
  await f.api.create(); expect(f.api.getSnapshot().memories).toHaveLength(50); expect(f.api.getSnapshot().memories[0].id).toBe(memory.id);
});
it('validates pure state boundaries and deterministic comparator', () => {
  expect(validMemory(memory, { ...context, state: 'waiting_partner' })).toBe(false);
  expect(sameMemoryContext(context, { ...context, userId: uuid(8) })).toBe(false);
  expect(sameMemoryContext(context, { ...context, state: 'waiting_partner' })).toBe(false);
  expect(memoryOrder(memory, memory)).toBe(0);
  expect(memoryOrder(memory, { ...memory, id: uuid(8) })).toBe(-1);
  expect(memoryOrder(memory, { ...memory, createdAt: '2026-11-09T00:00:00.000Z' })).toBe(-1);
});
it('normalizes domain Unicode titles and enforces every input boundary on mobile', () => {
  expect(normalizeTaskTitle(null)).toEqual({ ok: false });
  expect(normalizeTaskTitle('x'.repeat(1601))).toEqual({ ok: false });
  expect(normalizeTaskTitle('\t Cafe\u0301\n together  ')).toEqual({ ok: true, text: 'Café together' });
  expect(normalizeTaskTitle('😀'.repeat(200))).toEqual({ ok: true, text: '😀'.repeat(200) });
  expect(normalizeTaskTitle('\u200B')).toEqual({ ok: false });
});
it.each([
  { ok: true, value: { memory, replay: false, commandId: uuid(3) }, extra: true },
  { ok: true, value: { memory, replay: false, commandId: uuid(3), extra: true } },
])('rejects extra envelope fields %p', async body => {
  const f = fixture(); f.operation.mockResolvedValue(new Response(JSON.stringify(body))); await f.api.create();
  expect(f.api.getSnapshot().status).toBe('retry');
});
it('rejects an oversized list response', async () => {
  const f = fixture(); f.operation.mockResolvedValue(new Response('x'.repeat(1048577))); await f.api.list();
  expect(f.api.getSnapshot()).toMatchObject({ checked: false, error: true });
});
it('publishes normalized Unicode and preserves date-only day without timezone conversion', async () => {
  const f = fixture(); const normalized = { ...memory, title: 'Café', body: ' Café\n😀 ', localDate: '0001-01-01' };
  f.api.setDraft(' Cafe\u0301 '); f.api.setBody(' Cafe\u0301\r\n😀 '); f.api.setLocalDate(normalized.localDate); f.api.setConsent(true);
  f.operation.mockResolvedValueOnce(ack(normalized)); await f.api.create();
  expect(await f.operation.mock.calls[0][0].json()).toMatchObject({ title: normalized.title, body: normalized.body, local_date: '0001-01-01' });
  expect(f.api.getSnapshot()).toMatchObject({ status: 'saved', memories: [normalized] });
});
