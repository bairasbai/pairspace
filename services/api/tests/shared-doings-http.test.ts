import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createSharedDoingsHandler } from '../src/shared-doings-http.ts';
import { adapter, c1, c2, createFixture, id, identityPrincipal, principal, u2 } from './fixtures.ts';
let pg: PGlite;
beforeAll(async () => { pg = await createFixture(); await pg.exec(await readFile(new URL('../migrations/042_shared_doings.sql', import.meta.url), 'utf8')); });
afterAll(async () => pg.close());
const base = `http://localhost/v1/couples/${c1}/shared-doings`;
const create = { membership_epoch: 1, command_id: id(128001), confirm: true, title: 'Synthetic HTTP course', kind: 'course', parts: 3 };
function make(method = 'POST', value: unknown = create, url = base, headers: Record<string, string> = {
  'content-type': 'application/json', 'idempotency-key': (value as { command_id?: string })?.command_id ?? create.command_id,
}) { return new Request(url, { method, headers, ...(method === 'GET' ? {} : { body: typeof value === 'string' ? value : JSON.stringify(value) }) }); }
const db = () => { const d = adapter(pg); return { ...d, sessionAuthority: { ...d.sessionAuthority, authenticate: async () => principal } }; };
it('serves separate progress and explicit join/withdraw, canonical retry after removal never returns old shared content', async () => {
  const d = db(), author = createSharedDoingsHandler(d), other = createSharedDoingsHandler({ ...d, sessionAuthority: { ...d.sessionAuthority, authenticate: async () => identityPrincipal(u2) } });
  const response = await author(make()); expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store'); expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  const result = await response.json() as { value: { doing: { id: string } } }, target = base + '/' + result.value.doing.id;
  expect(await (await other(make('GET', null, base + '?membership_epoch=1'))).json()).toHaveProperty('value.doings.0.title', create.title);
  expect(await (await other(make('GET', null, base + '?membership_epoch=1'))).json()).not.toHaveProperty('value.doings.0.recipientAt');
  const joining = { membership_epoch: 1, command_id: id(128002), expected_version: 1, confirm: true };
  expect((await other(make('POST', { ...joining, confirm: false }, target + '/join'))).status).toBe(400);
  expect(await (await other(make('POST', joining, target + '/join'))).json()).toHaveProperty('value.doing.recipientAt', 0);
  const advancing = { ...joining, command_id: id(128003), expected_version: 2, part: 2 };
  expect(await (await other(make('POST', advancing, target + '/advance'))).json()).toHaveProperty('value.doing.recipientAt', 2);
  expect((await other(make('POST', { ...joining, command_id: id(128004), expected_version: 3 }, target + '/decline'))).status).toBe(200);
  expect((await author(make('DELETE', { ...joining, command_id: id(128005), expected_version: 4 }, target))).status).toBe(200);
  const replay = await (await other(make('POST', advancing, target + '/advance'))).json();
  expect(replay).toMatchObject({ ok: true, value: { replay: true, doing: { contentState: 'removed', decisionState: 'declined' } } });
  for (const field of ['title', 'kind', 'parts', 'authorAt', 'recipientAt']) expect(replay).not.toHaveProperty('value.doing.' + field);
  expect((await author(make('GET', null, base.replace(c1, c2) + '?membership_epoch=1'))).status).toBe(403);
});
it('enforces routes, methods, strict keys, confirmation, scope and idempotency with opaque failures', async () => {
  const handler = createSharedDoingsHandler(db());
  for (const [suffix, allow] of [['', 'GET, POST'], ['/x', 'DELETE'], ['/x/join', 'POST'], ['/x/decline', 'POST'], ['/x/advance', 'POST']]) {
    const response = await handler(make('PUT', {}, base + suffix)); expect(response.status).toBe(405); expect(response.headers.get('allow')).toBe(allow);
  }
  expect((await handler(make('POST', {}, base + '/x/unknown'))).status).toBe(404);
  for (const query of ['', '?membership_epoch=0', '?membership_epoch=1&membership_epoch=1', '?membership_epoch=1&x=2']) expect((await handler(make('GET', null, base + query))).status).toBe(400);
  expect((await handler(make('POST', create, base + '?x=2'))).status).toBe(400);
  expect((await handler(make('POST', create, base, {}))).status).toBe(415);
  for (const invalid of ['{', null, [], {}, { ...create, extra: 1 }, { ...create, command_id: 'bad' }, { ...create, title: 'x'.repeat(70000) }]) expect((await handler(make('POST', invalid))).status).toBe(400);
  expect((await handler(make('POST', create, base, { 'content-type': 'application/json', 'idempotency-key': id(1) }))).status).toBe(400);
  expect((await handler(make('POST', { ...create, title: 'changed' }))).status).toBe(409);
  const normal = db();
  for (const actor of [null, { ...principal, userId: 'bad' }, { ...principal, source: 'better-auth' as const, authUserId: 'x' }]) expect((await createSharedDoingsHandler({ ...normal, sessionAuthority: { ...normal.sessionAuthority, authenticate: async () => actor } })(make())).status).toBe(401);
  expect((await createSharedDoingsHandler({ ...normal, sessionAuthority: { ...normal.sessionAuthority, recheck: async () => false } })(make())).status).toBe(403);
  const broken = createSharedDoingsHandler({ ...normal, sessionAuthority: { ...normal.sessionAuthority, authenticate: async () => { throw Error('private'); } } });
  expect(await (await broken(make())).json()).toEqual({ ok: false, error: 'temporarily_unavailable' });
});
