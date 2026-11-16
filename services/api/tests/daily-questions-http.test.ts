import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createDailyQuestionsHandler } from '../src/daily-questions-http.ts';
import { adapter, c1, c2, createFixture, id, identityPrincipal, principal, u2 } from './fixtures.ts';
let pg: PGlite;
beforeAll(async () => { pg = await createFixture(); await pg.exec(await readFile(new URL('../migrations/046_daily_questions.sql', import.meta.url), 'utf8')); });
afterAll(async () => pg.close());
let now = '2026-11-10T00:00:00.000Z';
const clock = () => new Date(now);
const base = `http://localhost/v1/couples/${c1}/daily-questions`;
const creation = { membership_epoch: 1, command_id: id(125001), confirm: true, expected_day: '2026-11-10', text: 'Synthetic first daily answer' };
function make(method = 'POST', value: unknown = creation, url = base, headers: Headers | Record<string, string> = {
  'content-type': 'application/json', 'idempotency-key': (value as { command_id?: string })?.command_id ?? creation.command_id,
}) {
  return new Request(url, { method, headers, ...(method === 'GET' ? {} : { body: typeof value === 'string' ? value : JSON.stringify(value) }) });
}
const db = () => { const d = adapter(pg); return { ...d, sessionAuthority: { ...d.sessionAuthority, authenticate: async () => principal } }; };
const noText = (value: unknown) => expect(JSON.stringify(value)).not.toMatch(/"(?:text|body)"\s*:/);
it('list and acknowledgements remain body-free; explicit today read needs own active answer; past auto-reveals and deletion stays terminal', async () => {
  const d = db(), author = createDailyQuestionsHandler(d, clock, () => 'UTC');
  const partner = createDailyQuestionsHandler({ ...d, sessionAuthority: { ...d.sessionAuthority, authenticate: async () => identityPrincipal(u2) } }, clock, () => 'UTC');
  const history = () => make('GET', null, base + '?membership_epoch=1');
  const empty = await author(history()); expect(empty.status).toBe(200);
  expect(empty.headers.get('cache-control')).toBe('no-store'); expect(empty.headers.get('x-content-type-options')).toBe('nosniff');
  expect(await empty.json()).toMatchObject({ value: { slots: [], today: { day: '2026-11-10', timezone: 'UTC' }, nextBeforeDay: null } });
  const response = await author(make()); expect(response.status).toBe(200);
  const created = await response.json() as { value: { answer: { id: string } } }; noText(created);
  const target = base + '/answers/' + created.value.answer.id, read = () => make('GET', null, target + '/text?membership_epoch=1');
  expect(await (await author(read())).json()).toHaveProperty('value.text', creation.text);
  noText(await (await partner(read())).json()); noText(await (await partner(history())).json());
  const rewrite = { membership_epoch: 1, command_id: id(125002), confirm: true, expected_version: 1, text: 'Synthetic rewritten answer' };
  expect((await partner(make('PUT', rewrite, target))).status).toBe(403);
  const edited = await author(make('PUT', rewrite, target)); expect(edited.status).toBe(200); noText(await edited.json());
  const second = await partner(make('POST', { ...creation, command_id: id(125003), text: 'Synthetic other answer' })); expect(second.status).toBe(200);
  const partnerAnswer = await second.json() as { value: { answer: { id: string } } };
  expect(await (await partner(read())).json()).toHaveProperty('value.text', rewrite.text);
  const removePartner = { membership_epoch: 1, command_id: id(125004), confirm: true, expected_version: 1 };
  expect((await partner(make('DELETE', removePartner, base + '/answers/' + partnerAnswer.value.answer.id))).status).toBe(200);
  noText(await (await partner(read())).json());
  expect((await partner(make('POST', { ...creation, command_id: id(125005) }))).status).toBe(409);
  now = '2026-11-11T00:00:00.000Z';
  expect(await (await partner(read())).json()).toHaveProperty('value.text', rewrite.text);
  expect((await author(make('PUT', { ...rewrite, command_id: id(125006), expected_version: 2 }, target))).status).toBe(409);
  const retry = await author(make()); expect(retry.status).toBe(200); noText(await retry.json());
  const removal = { membership_epoch: 1, command_id: id(125007), confirm: true, expected_version: 2 };
  const gone = await author(make('DELETE', removal, target)); expect(gone.status).toBe(200); noText(await gone.json());
  noText(await (await author(read())).json()); noText(await (await author(make())).json());
  noText(await (await author(history())).json());
  expect((await author(make('GET', null, base + '?before_day=2026-11-10&membership_epoch=1'))).status).toBe(200);
  expect((await author(make('GET', null, base.replace(c1, c2) + '?membership_epoch=1'))).status).toBe(403);
});
it('rejects unsupported methods, unknown/duplicate query or JSON keys and combined idempotency headers', async () => {
  const handler = createDailyQuestionsHandler(db(), clock);
  for (const [suffix, allow] of [['', 'GET, POST'], ['/answers/x', 'PUT, DELETE'], ['/answers/x/text', 'GET']]) {
    const response = await handler(make('PATCH', {}, base + suffix)); expect(response.status).toBe(405); expect(response.headers.get('allow')).toBe(allow);
  }
  for (const path of ['/x', '/answers', '/answers/x/other']) expect((await handler(make('GET', null, base + path))).status).toBe(404);
  for (const query of ['', '?membership_epoch=0', '?membership_epoch=1&membership_epoch=1', '?membership_epoch=1&membership_%65poch=1',
    '?membership_epoch=1&timezone=UTC', '?membership_epoch=1&before_day=', '?membership_epoch=1&before_day=2026-02-30',
    '?membership_epoch=1&before_day=2026-11-10&before_day=2026-11-09']) expect((await handler(make('GET', null, base + query))).status).toBe(400);
  expect((await handler(make('GET', null, base + '/answers/' + id(1) + '/text?membership_epoch=1&before_day=2026-11-10'))).status).toBe(400);
  expect((await handler(make('POST', creation, base + '?extra=1'))).status).toBe(400);
  expect((await handler(make('POST', creation, base, {}))).status).toBe(415);
  for (const value of ['{', null, [], {}, { ...creation, timezone: 'UTC' }, { ...creation, now: '2100-01-01' }, { ...creation, command_id: 'bad' }, { ...creation, text: 'x'.repeat(70000) }]) {
    expect((await handler(make('POST', value))).status).toBe(400);
  }
  for (const raw of [JSON.stringify(creation).slice(0, -1) + ',"te\\u0078t":"replaced"}',
    JSON.stringify(creation).replace('"confirm":true', '"confirm":false,"confirm":true'),
    JSON.stringify(creation).replace('"text":"Synthetic first daily answer"', '"text":{"x":1,"\\u0078":2}')]) {
    expect((await handler(make('POST', raw))).status).toBe(400);
  }
  const headers = new Headers({ 'content-type': 'application/json', 'idempotency-key': creation.command_id }); headers.append('idempotency-key', creation.command_id);
  expect((await handler(make('POST', creation, base, headers))).status).toBe(400);
  expect((await handler(make('POST', creation, base, { 'content-type': 'application/json', 'idempotency-key': id(99) }))).status).toBe(400);
  const mutation = { membership_epoch: 1, command_id: id(125100), confirm: true, expected_version: 1 };
  expect((await handler(make('PUT', mutation, base + '/answers/' + id(1)))).status).toBe(400);
  expect((await handler(make('DELETE', { ...mutation, text: 'forbidden' }, base + '/answers/' + id(1)))).status).toBe(400);
});
it('auth and transaction recheck fail closed and exceptions never expose backend details', async () => {
  const normal = db();
  for (const actor of [null, { ...principal, userId: 'bad' }, { ...principal, source: 'better-auth' as const, authUserId: 'x' }]) {
    expect((await createDailyQuestionsHandler({ ...normal, sessionAuthority: { ...normal.sessionAuthority, authenticate: async () => actor } })(make())).status).toBe(401);
  }
  expect((await createDailyQuestionsHandler({ ...normal, sessionAuthority: { ...normal.sessionAuthority, recheck: async () => false } })(make())).status).toBe(403);
  const broken = createDailyQuestionsHandler({ ...normal, sessionAuthority: { ...normal.sessionAuthority, authenticate: async () => { throw Error('private'); } } });
  expect(await (await broken(make())).json()).toEqual({ ok: false, error: 'temporarily_unavailable' });
});
