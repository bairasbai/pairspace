import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createSharedTask, changeSharedTask, listSharedTasks } from '../src/shared-tasks.ts';
import { createSharedTasksHandler } from '../src/shared-tasks-http.ts';
import { bindSessionAuthority } from '../src/auth-authority.ts';
import { createSyntheticAuthority } from '../src/synthetic-authority.ts';
import { normalizeTaskTitle } from '../../../packages/domain/tasks/title.ts';
import { adapter, c1, c2, createFixture, id, identityPrincipal, outsider, principal, u2, waiting } from './fixtures.ts';
let pg: PGlite;
const scope = { coupleId: c1, membershipEpoch: 1 };
const command = { ...scope, commandId: id(801), title: ' Synthetic e\u0301\r\n task ' };
const db = () => adapter(pg);
let taskId: string;
beforeAll(async () => { pg = await createFixture(); await pg.exec(await readFile(new URL('../migrations/009_shared_tasks.sql', import.meta.url), 'utf8')); });
afterAll(async () => { await pg.close(); });
it('normalizes bounded plain titles and rejects invalid data', () => {
  expect(normalizeTaskTitle(command.title)).toEqual({ ok: true, text: 'Synthetic é task' });
  for (const title of [null, 1, '', ' \n ', '\u0000', '\u200b', '\ud800', 'x'.repeat(201), 'x'.repeat(1601)]) expect(normalizeTaskTitle(title)).toEqual({ ok: false });
  expect(normalizeTaskTitle('😀'.repeat(200)).ok).toBe(true);
});
it('creates once, both partners list and mutate with immutable replay returning current state', async () => {
  expect(await listSharedTasks(db(), principal, scope)).toEqual({ ok: true, value: { tasks: [], limit: 50 } });
  const first = await createSharedTask(db(), principal, command);
  expect(first).toMatchObject({ ok: true, value: { replay: false, appliedVersion: 1, task: { title: 'Synthetic é task', state: 'open', version: 1 } } });
  if (!first.ok) throw Error('fixture');
  taskId = first.value.task.id;
  expect(await createSharedTask(db(), principal, command)).toMatchObject({ ok: true, value: { replay: true } });
  expect(await createSharedTask(db(), principal, { ...command, title: 'different' })).toEqual({ ok: false, error: 'idempotency_conflict' });
  expect(await listSharedTasks(db(), identityPrincipal(u2), scope)).toMatchObject({ ok: true, value: { tasks: [{ id: taskId }] } });
  const complete = { ...scope, commandId: id(802), taskId, operation: 'complete', expectedVersion: 1 };
  expect(await changeSharedTask(db(), identityPrincipal(u2), complete)).toMatchObject({ ok: true, value: { appliedVersion: 2, task: { state: 'completed', version: 2 } } });
  expect(await changeSharedTask(db(), principal, { ...complete, commandId: id(803) })).toEqual({ ok: false, error: 'version_conflict' });
  expect(await changeSharedTask(db(), principal, { ...complete, commandId: id(803), expectedVersion: 2 })).toEqual({ ok: false, error: 'version_conflict' });
  expect(await changeSharedTask(db(), principal, { ...complete, commandId: id(803), expectedVersion: 2, operation: 'reopen' })).toMatchObject({ ok: true, value: { task: { state: 'open', version: 3 } } });
  expect(await changeSharedTask(db(), identityPrincipal(u2), complete)).toMatchObject({ ok: true, value: { replay: true, appliedVersion: 2, task: { state: 'open', version: 3 } } });
  for (const change of [{ operation: 'reopen' }, { expectedVersion: 2 }, { taskId: id(999) }]) {
    expect(await changeSharedTask(db(), identityPrincipal(u2), { ...complete, ...change })).toEqual({ ok: false, error: 'idempotency_conflict' });
  }
  expect(await changeSharedTask(db(), principal, { ...complete, commandId: command.commandId })).toEqual({ ok: false, error: 'idempotency_conflict' });
  expect(await changeSharedTask(db(), principal, { ...complete, taskId: id(999), commandId: id(990) })).toEqual({ ok: false, error: 'unavailable' });
  expect((await pg.query('SELECT * FROM shared_task_commands')).rows).toHaveLength(3);
});
it('rejects malformed input, inactive/foreign scopes and stale sessions after locks', async () => {
  const change = { ...scope, commandId: id(810), taskId, operation: 'complete', expectedVersion: 3 };
  for (const bad of [null, [], {}, { ...command, actorId: u2 }, { ...command, commandId: 'bad' }, { ...command, membershipEpoch: 0 }, { ...command, title: '' }]) {
    expect(await createSharedTask(db(), principal, bad)).toEqual({ ok: false, error: 'invalid_request' });
  }
  for (const bad of [{ taskId: 'bad' }, { operation: 'toggle' }, { expectedVersion: 0 }, { expectedVersion: 1.1 }, { expectedVersion: 2147483647 }]) {
    expect(await changeSharedTask(db(), principal, { ...change, ...bad })).toEqual({ ok: false, error: 'invalid_request' });
  }
  expect(await listSharedTasks(db(), principal, command)).toEqual({ ok: false, error: 'invalid_request' });
  for (const [operation, input] of [[createSharedTask, command], [changeSharedTask, change], [listSharedTasks, scope]] as const) {
    expect(await operation(db(), { ...principal, userId: 'bad' }, input)).toEqual({ ok: false, error: 'unavailable' });
    for (const coupleId of [c2, waiting, id(999)]) expect(await operation(db(), principal, { ...input, coupleId })).toEqual({ ok: false, error: 'unavailable' });
    expect(await operation(db(), identityPrincipal(outsider), input)).toEqual({ ok: false, error: 'unavailable' });
    expect(await operation(db(), principal, { ...input, membershipEpoch: 2 })).toEqual({ ok: false, error: 'stale_membership' });
    expect(await operation(db(), { ...principal, tokenExpiresAt: 1 }, input)).toEqual({ ok: false, error: 'unavailable' });
    let calls = 0; const source = db();
    expect(await operation(bindSessionAuthority(source, { ...source.sessionAuthority, recheck: async () => ++calls === 1 }), principal, input)).toEqual({ ok: false, error: 'unavailable' });
  }
  const source = db();
  await expect(createSharedTask(bindSessionAuthority({ ...source, now: () => new Date(NaN) }, { ...source.sessionAuthority, recheck: async () => true }), principal, { ...command, commandId: id(899) })).rejects.toThrow('invalid_server_clock');
  await pg.query('UPDATE couples SET membership_epoch=2 WHERE id=$1', [c1]);
  expect(await createSharedTask(db(), principal, { ...command, membershipEpoch: 2 })).toEqual({ ok: false, error: 'idempotency_conflict' });
  await pg.query('UPDATE couples SET membership_epoch=1 WHERE id=$1', [c1]);
});
const path = `/v1/couples/${c1}/tasks`;
const body = { command_id: id(850), membership_epoch: 1, title: 'Synthetic task' };
const make = (method = 'POST', input: unknown = body, suffix = '', headers: Record<string, string> = {}) => new Request('http://localhost' + path + suffix, {
  method, headers: { authorization: 'Bearer fixture', 'content-type': 'application/json', 'idempotency-key': id(850), ...headers },
  ...(method === 'POST' ? { body: JSON.stringify(input) } : {}),
});
it('enforces HTTP methods/schema/auth and keeps errors redacted', async () => {
  const handler = createSharedTasksHandler(bindSessionAuthority(db(), createSyntheticAuthority(async () => principal)));
  expect((await handler(new Request('http://localhost/unknown'))).status).toBe(404);
  expect((await handler(make('DELETE'))).headers.get('allow')).toBe('GET, POST');
  expect((await handler(make('GET', null, '/' + taskId))).status).toBe(405);
  expect((await handler(make('GET', null, '?membership_epoch=1'))).status).toBe(200);
  for (const suffix of ['', '?membership_epoch=0', '?membership_epoch=1&membership_epoch=1', '?membership_epoch=1&actor=x']) expect((await handler(make('GET', null, suffix))).status).toBe(400);
  expect((await handler(make('POST', body, '?x=1'))).status).toBe(400);
  expect((await handler(make('POST', body, '', { 'content-type': 'text/plain' }))).status).toBe(415);
  for (const input of [null, [], {}, { ...body, command_id: 'bad' }, { ...body, command_id: id(800) }, { ...body, actor: u2 }]) expect((await handler(make('POST', input))).status).toBe(400);
  expect((await handler(new Request('http://localhost' + path, { method: 'POST', headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' }, body: '{' }))).status).toBe(400);
  const saved = await handler(make()); expect(saved.status).toBe(201); expect(saved.headers.get('cache-control')).toBe('no-store');
  expect((await handler(make())).status).toBe(200);
  expect((await handler(make('POST', { ...body, title: 'changed' }))).status).toBe(409);
  expect((await handler(make('POST', { ...body, membership_epoch: 0 }))).status).toBe(400);
  const change = { command_id: id(851), membership_epoch: 1, operation: 'complete', expected_version: 3 };
  expect((await handler(make('POST', change, '/' + taskId, { 'idempotency-key': id(851) }))).status).toBe(200);
  expect((await handler(make('POST', change, '/' + id(999), { 'idempotency-key': id(851) }))).status).toBe(409);
  expect((await handler(make('POST', { ...change, command_id: id(852) }, '/' + id(999), { 'idempotency-key': id(852) }))).status).toBe(403);
  for (const principalValue of [null, { ...principal, userId: 'bad' }]) {
    const denied = createSharedTasksHandler(bindSessionAuthority(db(), createSyntheticAuthority(async () => principalValue)));
    expect((await denied(make())).status).toBe(401);
  }
  const throws = createSharedTasksHandler({ ...db(), sessionAuthority: { ...db().sessionAuthority, authenticate: async () => { throw Error('secret title'); } } });
  expect(await (await throws(make())).json()).toEqual({ ok: false, error: 'temporarily_unavailable' });
});
it('database forbids receipt mutation, cross-pair keys, task edits and fractional timestamps', async () => {
  for (const sql of ['UPDATE shared_task_commands SET applied_version=5', 'DELETE FROM shared_task_commands', "UPDATE shared_tasks SET title='edited'", 'UPDATE shared_tasks SET version=version+2']) await expect(pg.query(sql)).rejects.toMatchObject({ code: '23514' });
  await expect(pg.query('UPDATE shared_tasks SET couple_id=$1', [c2])).rejects.toMatchObject({ code: '23514' });
  await expect(pg.query("INSERT INTO shared_tasks(couple_id,creator_id,membership_epoch,title,created_at,updated_at) VALUES($1,$2,1,'synthetic','2026-01-01 00:00:00.000001Z','2026-01-01 00:00:00.000001Z')", [c1, principal.userId])).rejects.toMatchObject({ code: '23514' });
  const result = await changeSharedTask({ ...db(), now: () => new Date('2026-11-09') }, principal, { ...scope, commandId: id(855), taskId, operation: 'reopen', expectedVersion: 4 });
  expect(result).toMatchObject({ ok: true, value: { task: { updatedAt: '2026-11-10T00:00:00.000Z' } } });
});
it('caps stable newest-first lists at fifty and does not reorder on completion', async () => {
  for (let n = 0; n < 51; n++) await createSharedTask(db(), principal, { ...command, commandId: id(900 + n) });
  const result = await listSharedTasks(db(), principal, scope);
  if (!result.ok) throw Error('fixture');
  expect(result.value.tasks).toHaveLength(50);
  const ids = result.value.tasks.map(task => task.id);
  expect(ids).toEqual([...ids].sort().reverse());
  const target = result.value.tasks[10];
  await changeSharedTask(db(), principal, { ...scope, commandId: id(980), taskId: target.id, operation: 'complete', expectedVersion: target.version });
  const next = await listSharedTasks(db(), principal, scope);
  expect(next.ok && next.value.tasks.map(task => task.id)).toEqual(ids);
});
