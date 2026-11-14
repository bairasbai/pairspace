import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createHardQuestionsHandler } from '../src/hard-questions-http.ts';
import { adapter, c1, c2, createFixture, id, identityPrincipal, principal, u2 } from './fixtures.ts';
let pg: PGlite;
beforeAll(async () => { pg = await createFixture(); await pg.exec(await readFile(new URL('../migrations/041_hard_questions.sql', import.meta.url), 'utf8')); });
afterAll(async () => pg.close());
const base = `http://localhost/v1/couples/${c1}/hard-questions`, create = { membership_epoch: 1, command_id: id(118001), text: 'Synthetic private HTTP question' };
function make(method = 'POST', value: unknown = create, url = base, headers: Record<string, string> = {
  'content-type': 'application/json', 'idempotency-key': (value as { command_id?: string })?.command_id ?? create.command_id,
}) {
  return new Request(url, { method, headers, ...(method === 'GET' ? {} : { body: typeof value === 'string' ? value : JSON.stringify(value) }) });
}
const db = () => { const d = adapter(pg); return { ...d, sessionAuthority: { ...d.sessionAuthority, authenticate: async () => principal } }; };
it('role-gated routes never expose sealed text; explicit confirmed opening returns it and canonical replay after removal does not', async () => {
  const d = db(), author = createHardQuestionsHandler(d), recipient = createHardQuestionsHandler({ ...d, sessionAuthority: { ...d.sessionAuthority, authenticate: async () => identityPrincipal(u2) } });
  const result = await author(make()); expect(result.status).toBe(200);
  expect(result.headers.get('cache-control')).toBe('no-store'); expect(result.headers.get('x-content-type-options')).toBe('nosniff');
  const value = await result.json() as { value: { question: { id: string } } }; const target = base + '/' + value.value.question.id;
  const read = () => make('GET', null, target + '/text?membership_epoch=1');
  expect(await (await author(read())).json()).toHaveProperty('value.text', create.text);
  expect(await (await recipient(read())).json()).not.toHaveProperty('value.text');
  expect(await (await recipient(make('GET', null, base + '?membership_epoch=1'))).text()).not.toContain(create.text);
  const opening = { membership_epoch: 1, command_id: id(118002), expected_version: 1, confirm: true };
  expect((await recipient(make('POST', { ...opening, confirm: false }, target + '/open'))).status).toBe(400);
  expect(await (await recipient(make('POST', opening, target + '/open'))).json()).toHaveProperty('value.text', create.text);
  expect((await author(make('DELETE', { ...opening, command_id: id(118003), expected_version: 2 }, target))).status).toBe(200);
  expect(await (await recipient(make('POST', opening, target + '/open'))).json()).not.toHaveProperty('value.text');
  expect(await (await author(read())).json()).not.toHaveProperty('value.text');
  const next = await (await author(make('POST', { ...create, command_id: id(118004) }))).json() as { value: { question: { id: string } } };
  expect((await recipient(make('POST', { ...opening, command_id: id(118005) }, base + '/' + next.value.question.id + '/decline'))).status).toBe(200);
  expect((await recipient(make('POST', { ...opening, command_id: id(118006), expected_version: 2 }, base + '/' + next.value.question.id + '/open'))).status).toBe(409);
  expect((await author(make('GET', null, base.replace(c1, c2) + '?membership_epoch=1'))).status).toBe(403);
});
it('enforces methods, exact payload/query/confirmation, idempotency binding and nonrevealing failures', async () => {
  const handler = createHardQuestionsHandler(db());
  for (const [suffix, allow] of [['', 'GET, POST'], ['/x', 'DELETE'], ['/x/open', 'POST'], ['/x/decline', 'POST'], ['/x/text', 'GET']]) {
    const r = await handler(make('PUT', {}, base + suffix)); expect(r.status).toBe(405); expect(r.headers.get('allow')).toBe(allow);
  }
  expect((await handler(make('POST', {}, base + '/x/unknown'))).status).toBe(404);
  for (const q of ['', '?membership_epoch=0', '?membership_epoch=1&membership_epoch=1', '?membership_epoch=1&x=2']) expect((await handler(make('GET', null, base + q))).status).toBe(400);
  expect((await handler(make('POST', create, base + '?x=2'))).status).toBe(400);
  expect((await handler(make('POST', create, base, {}))).status).toBe(415);
  for (const invalid of ['{', null, [], {}, { ...create, extra: 1 }, { ...create, command_id: 'bad' }, { ...create, text: 'x'.repeat(70000) }]) expect((await handler(make('POST', invalid))).status).toBe(400);
  expect((await handler(make('POST', create, base, { 'content-type': 'application/json', 'idempotency-key': id(1) }))).status).toBe(400);
  expect((await handler(make('POST', { ...create, text: 'changed' }))).status).toBe(409);
  const normal = db();
  for (const actor of [null, { ...principal, userId: 'bad' }, { ...principal, source: 'better-auth' as const, authUserId: 'x' }]) expect((await createHardQuestionsHandler({ ...normal, sessionAuthority: { ...normal.sessionAuthority, authenticate: async () => actor } })(make())).status).toBe(401);
  expect((await createHardQuestionsHandler({ ...normal, sessionAuthority: { ...normal.sessionAuthority, recheck: async () => false } })(make())).status).toBe(403);
  const broken = createHardQuestionsHandler({ ...normal, sessionAuthority: { ...normal.sessionAuthority, authenticate: async () => { throw Error('private'); } } });
  expect(await (await broken(make())).json()).toEqual({ ok: false, error: 'temporarily_unavailable' });
});
