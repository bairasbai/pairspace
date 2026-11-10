import { normalizeTaskTitle } from '../../../packages/domain/tasks/title';
import { fixture, ack, envelope, date, uuid, context } from './dates-fixtures';
import { validDate, sameDateContext, dateOrder } from '../src/auth/dates-state';
it.each(['id', 'creatorId', 'coupleId', 'membershipEpoch', 'title', 'localDate', 'timezone', 'createdAt'])('rejects invalid date %s', async field => {
  const f = fixture(); f.operation.mockResolvedValue(ack({ ...date, [field]: 'bad' })); await f.api.create();
  expect(f.api.getSnapshot()).toMatchObject({ status: 'retry', error: true });
});
it.each([null, [], {}, { ok: false }, { ok: true, value: null }, { ok: true, value: { date } }])('rejects malformed envelope %p', async body => {
  const f = fixture(); f.operation.mockResolvedValue(new Response(JSON.stringify(body))); await f.api.create(); expect(f.api.getSnapshot().status).toBe('retry');
});
it.each([
  { date: { ...date, createdAt: 123 } }, { date: { ...date, title: ' unnormalized ' } },
  { date: { ...date, creatorId: uuid(4) } }, { date: { ...date, title: 'Different' } },
  { date: { ...date, localDate: '2028-03-01' } }, { date: { ...date, timezone: 'America/Los_Angeles' } },
  { commandId: uuid(8) }, { replay: 'true' }, { date: { ...date, extra: true } },
])('rejects mismatched ACK %p', async changes => {
  const f = fixture(); f.operation.mockResolvedValue(envelope({ date, commandId: uuid(3), replay: false, ...changes }));
  await f.api.create(); expect(f.api.getSnapshot().status).toBe('retry');
});
it('rejects malformed JSON', async () => {
  const f = fixture(); f.operation.mockResolvedValueOnce(new Response('no JSON')); await f.api.create();
  expect(f.api.getSnapshot().status).toBe('retry');
});
it.each([
  { dates: null, limit: 50 }, { dates: [], limit: 51 }, { dates: [null], limit: 50 },
  { dates: [date, date], limit: 50 }, { dates: Array(51).fill(date), limit: 50 },
  { dates: [{ ...date, coupleId: uuid(22) }], limit: 50 },
  { dates: [date, { ...date, id: uuid(10) }], limit: 50 },
  { dates: [date, { ...date, id: uuid(8), createdAt: '2026-11-11T00:00:00.000Z' }], limit: 50 },
])('rejects malformed, unsorted, foreign or unbounded list %p', async value => {
  const f = fixture(); f.operation.mockResolvedValue(envelope(value)); await f.api.list();
  expect(f.api.getSnapshot()).toMatchObject({ error: true, checked: false, dates: [] });
});
it('keeps list bounded and sorted after ACK, including ID tie breaking', async () => {
  const f = fixture(); const dates = Array.from({ length: 50 }, (_, i) => ({ ...date, id: uuid(100 - i) }));
  f.operation.mockResolvedValueOnce(envelope({ dates, limit: 50 })); await f.api.list();
  f.operation.mockResolvedValueOnce(ack({ ...date, createdAt: '2026-11-11T00:00:00.000Z' }));
  await f.api.create(); expect(f.api.getSnapshot().dates).toHaveLength(50); expect(f.api.getSnapshot().dates[0].id).toBe(date.id);
});
it('validates pure state boundaries and deterministic comparator', () => {
  expect(validDate(date, { ...context, state: 'waiting_partner' })).toBe(false);
  expect(sameDateContext(context, { ...context, userId: uuid(8) })).toBe(false);
  expect(sameDateContext(context, { ...context, state: 'waiting_partner' })).toBe(false);
  expect(dateOrder(date, date)).toBe(0);
  expect(dateOrder(date, { ...date, id: uuid(8) })).toBe(-1);
  expect(dateOrder(date, { ...date, createdAt: '2026-11-09T00:00:00.000Z' })).toBe(-1);
});
it('normalizes domain Unicode titles and enforces every input boundary on mobile', () => {
  expect(normalizeTaskTitle(null)).toEqual({ ok: false });
  expect(normalizeTaskTitle('x'.repeat(1601))).toEqual({ ok: false });
  expect(normalizeTaskTitle('\t Cafe\u0301\n together  ')).toEqual({ ok: true, text: 'Café together' });
  expect(normalizeTaskTitle('😀'.repeat(200))).toEqual({ ok: true, text: '😀'.repeat(200) });
  expect(normalizeTaskTitle('\u200B')).toEqual({ ok: false });
});
