import { normalizeTaskTitle } from '../../../packages/domain/tasks/title';
import { fixture, ack, envelope, task, uuid, context } from './tasks-fixtures';
import { validTask, sameTaskContext, taskOrder } from '../src/auth/tasks-state';
it.each(['id', 'creatorId', 'coupleId', 'membershipEpoch', 'title', 'state', 'version', 'createdAt', 'updatedAt'])('rejects invalid task %s', async field => {
  const f = fixture(); f.operation.mockResolvedValue(ack({ ...task, [field]: 'bad' })); await f.api.create();
  expect(f.api.getSnapshot()).toMatchObject({ status: 'retry', error: true });
});
it.each([null, [], {}, { ok: false }, { ok: true, value: null }, { ok: true, value: { task } }])('rejects malformed envelope %p', async body => {
  const f = fixture(); f.operation.mockResolvedValue(new Response(JSON.stringify(body))); await f.api.create(); expect(f.api.getSnapshot().status).toBe('retry');
});
it.each([
  { task: { ...task, version: 0 } }, { task: { ...task, version: 1.1 } }, { task: { ...task, version: Number.MAX_SAFE_INTEGER + 1 } },
  { task: { ...task, createdAt: 123 } }, { task: { ...task, updatedAt: '2026-11-09T00:00:00.000Z' } },
  { task: { ...task, title: ' unnormalized ' } }, { task: { ...task, creatorId: uuid(4) } },
  { task: { ...task, state: 'completed' } }, { task: { ...task, version: 2 }, replay: false },
  { commandId: uuid(8) }, { replay: 'true' }, { appliedVersion: 2 }, { task: { ...task, extra: true } },
])('rejects mismatched ACK %p', async changes => {
  const f = fixture(); f.operation.mockResolvedValue(envelope({ task, commandId: uuid(3), replay: false, appliedVersion: 1, ...changes }));
  await f.api.create(); expect(f.api.getSnapshot().status).toBe('retry');
});
it('rejects malformed JSON, wrong operation target, old current version', async () => {
  const f = fixture(); f.operation.mockResolvedValueOnce(new Response('no JSON')); await f.api.create(); expect(f.api.getSnapshot().status).toBe('retry');
  f.controller.reset(); f.controller.sync(); f.operation.mockResolvedValueOnce(envelope({ tasks: [task], limit: 50 })); await f.api.list();
  f.operation.mockResolvedValueOnce(ack({ ...task, id: uuid(8), version: 2, state: 'completed' }, 2)); await f.api.complete(task.id);
  expect(f.api.getSnapshot().status).toBe('retry');
  f.operation.mockResolvedValueOnce(ack(task, 2, true)); await f.api.retry(); expect(f.api.getSnapshot().status).toBe('retry');
});
it.each([
  { tasks: null, limit: 50 }, { tasks: [], limit: 51 }, { tasks: [null], limit: 50 },
  { tasks: [task, task], limit: 50 }, { tasks: Array(51).fill(task), limit: 50 },
  { tasks: [{ ...task, coupleId: uuid(22) }], limit: 50 },
  { tasks: [task, { ...task, id: uuid(10) }], limit: 50 },
  { tasks: [task, { ...task, id: uuid(8), createdAt: '2026-11-11T00:00:00.000Z', updatedAt: '2026-11-11T00:00:00.000Z' }], limit: 50 },
])('rejects malformed, unsorted, foreign or unbounded list %p', async value => {
  const f = fixture(); f.operation.mockResolvedValue(envelope(value)); await f.api.list();
  expect(f.api.getSnapshot()).toMatchObject({ error: true, checked: false, tasks: [] });
});
it('keeps list bounded and sorted after ACK, including ID tie breaking', async () => {
  const f = fixture(); const tasks = Array.from({ length: 50 }, (_, i) => ({ ...task, id: uuid(100 - i) }));
  f.operation.mockResolvedValueOnce(envelope({ tasks, limit: 50 })); await f.api.list();
  f.operation.mockResolvedValueOnce(ack({ ...task, createdAt: '2026-11-11T00:00:00.000Z', updatedAt: '2026-11-11T00:00:00.000Z' }));
  await f.api.create(); expect(f.api.getSnapshot().tasks).toHaveLength(50); expect(f.api.getSnapshot().tasks[0].id).toBe(task.id);
});
it('validates pure state boundaries and deterministic comparator', () => {
  expect(validTask(task, { ...context, state: 'waiting_partner' })).toBe(false);
  expect(sameTaskContext(context, { ...context, userId: uuid(8) })).toBe(false);
  expect(sameTaskContext(context, { ...context, state: 'waiting_partner' })).toBe(false);
  expect(taskOrder(task, task)).toBe(0);
  expect(taskOrder(task, { ...task, id: uuid(8) })).toBe(-1);
  expect(taskOrder(task, { ...task, createdAt: '2026-11-09T00:00:00.000Z' })).toBe(-1);
});
it('normalizes domain Unicode titles and enforces every input boundary on mobile', () => {
  expect(normalizeTaskTitle(null)).toEqual({ ok: false });
  expect(normalizeTaskTitle('x'.repeat(1601))).toEqual({ ok: false });
  expect(normalizeTaskTitle('\t Cafe\u0301\n together  ')).toEqual({ ok: true, text: 'Café together' });
  expect(normalizeTaskTitle('😀'.repeat(200))).toEqual({ ok: true, text: '😀'.repeat(200) });
  expect(normalizeTaskTitle('\u200B')).toEqual({ ok: false });
});
