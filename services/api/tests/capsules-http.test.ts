import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createCapsulesHandler } from '../src/capsules-http.ts';
import { adapter, c1, c2, createFixture, id, identityPrincipal, principal, u2 } from './fixtures.ts';
let pg: PGlite;
beforeAll(async () => { pg = await createFixture(); await pg.exec(await readFile(new URL('../migrations/044_capsules.sql', import.meta.url), 'utf8')); });
afterAll(async () => pg.close());
let featureNow = '2026-11-10T00:00:00.000Z';
const clock = () => new Date(featureNow);
const schedule = { localDate: '2026-11-11', localTime: '09:00', timezone: 'Europe/Moscow', offset: '+03:00' };
const base = `http://localhost/v1/couples/${c1}/capsules`, create = { membership_epoch: 1, command_id: id(119001), text: 'Synthetic private HTTP prediction', schedule, confirm: true };
function make(method = 'POST', value: unknown = create, url = base, headers: Record<string, string> = {
  'content-type': 'application/json', 'idempotency-key': (value as { command_id?: string })?.command_id ?? create.command_id,
}) {
  return new Request(url, { method, headers, ...(method === 'GET' ? {} : { body: typeof value === 'string' ? value : JSON.stringify(value) }) });
}
const db = () => { const d = adapter(pg); return { ...d, sessionAuthority: { ...d.sessionAuthority, authenticate: async () => principal } }; };
it('keeps even metadata private to the author, body locked until due, and every ACK/replay body-free', async () => {
  const d = db(), author = createCapsulesHandler(d, clock), partner = createCapsulesHandler({ ...d, sessionAuthority: { ...d.sessionAuthority, authenticate: async () => identityPrincipal(u2) } }, clock);
  const result = await author(make()); expect(result.status).toBe(200);
  expect(result.headers.get('cache-control')).toBe('no-store'); expect(result.headers.get('x-content-type-options')).toBe('nosniff');
  const ack = await result.json() as { value: { capsule: { id: string } } };
  expect(JSON.stringify(ack)).not.toContain(create.text);
  const target = base + '/' + ack.value.capsule.id;
  const read = () => make('GET', null, target + '/text?membership_epoch=1');
  const sealedRead = await author(read());
  expect(sealedRead.status).toBe(200); expect(await sealedRead.text()).not.toContain(create.text);
  expect((await partner(read())).status).toBe(403);
  expect(await (await partner(make('GET', null, base + '?membership_epoch=1'))).json()).toHaveProperty('value.capsules', []);
  expect(await (await author(make('GET', null, base + '?membership_epoch=1'))).text()).not.toContain(create.text);
  const reseal = { ...create, command_id: id(119002), expected_version: 1, text: 'Replacement synthetic capsule text' };
  expect((await author(make('PUT', { ...reseal, confirm: false }, target))).status).toBe(400);
  expect((await partner(make('PUT', reseal, target))).status).toBe(403);
  const resealed = await author(make('PUT', reseal, target));
  expect(resealed.status).toBe(200); expect(await resealed.text()).not.toContain(reseal.text);
  expect(await (await author(make('PUT', reseal, target))).json()).toHaveProperty('value.replay', true);
  featureNow = '2026-11-11T06:00:00.000Z';
  expect(await (await author(read())).json()).toHaveProperty('value.text', reseal.text);
  expect((await partner(read())).status).toBe(403);
  expect((await author(make('PUT', { ...reseal, command_id: id(119003), expected_version: 2 }, target))).status).toBe(409);
  expect(await (await author(make())).text()).not.toContain(create.text);
  const remove = { membership_epoch: 1, command_id: id(119004), expected_version: 2, confirm: true };
  expect((await partner(make('DELETE', remove, target))).status).toBe(403);
  expect((await author(make('DELETE', remove, target))).status).toBe(200);
  expect(await (await author(make('DELETE', remove, target))).json()).toHaveProperty('value.replay', true);
  expect(await (await author(read())).text()).not.toContain(reseal.text);
  const replayedAfterRemoval = await author(make('PUT', reseal, target));
  expect(replayedAfterRemoval.status).toBe(200); expect(await replayedAfterRemoval.text()).not.toContain(reseal.text);
  featureNow = '2026-11-10T00:00:00.000Z';
  expect((await author(make('POST', { ...create, command_id: id(119005) }))).status).toBe(409);
  expect((await author(make('GET', null, base.replace(c1, c2) + '?membership_epoch=1'))).status).toBe(403);
});
it('enforces methods, exact payload/query/confirmation, idempotency binding and nonrevealing failures', async () => {
  const handler = createCapsulesHandler(db(), clock);
  for (const [suffix, allow] of [['', 'GET, POST'], ['/x', 'PUT, DELETE'], ['/x/text', 'GET']]) {
    const r = await handler(make('PATCH', {}, base + suffix)); expect(r.status).toBe(405); expect(r.headers.get('allow')).toBe(allow);
  }
  expect((await handler(make('POST', {}, base + '/x/unknown'))).status).toBe(404);
  for (const q of ['', '?membership_epoch=0', '?membership_epoch=1&membership_epoch=1', '?membership_epoch=1&x=2']) expect((await handler(make('GET', null, base + q))).status).toBe(400);
  expect((await handler(make('POST', create, base + '?x=2'))).status).toBe(400);
  expect((await handler(make('POST', create, base, {}))).status).toBe(415);
  for (const invalid of ['{', null, [], {}, { ...create, extra: 1 }, { ...create, now: '2100-01-01' }, { ...create, schedule: { ...schedule, releaseAt: '2026-11-10' } }, { ...create, command_id: 'bad' }, { ...create, text: 'x'.repeat(70000) }]) expect((await handler(make('POST', invalid))).status).toBe(400);
  expect((await handler(make('POST', create, base, { 'content-type': 'application/json', 'idempotency-key': id(1) }))).status).toBe(400);
  expect((await handler(make('POST', { ...create, text: 'changed' }))).status).toBe(409);
  const normal = db();
  for (const actor of [null, { ...principal, userId: 'bad' }, { ...principal, source: 'better-auth' as const, authUserId: 'x' }]) expect((await createCapsulesHandler({ ...normal, sessionAuthority: { ...normal.sessionAuthority, authenticate: async () => actor } })(make())).status).toBe(401);
  expect((await createCapsulesHandler({ ...normal, sessionAuthority: { ...normal.sessionAuthority, recheck: async () => false } })(make())).status).toBe(403);
  const broken = createCapsulesHandler({ ...normal, sessionAuthority: { ...normal.sessionAuthority, authenticate: async () => { throw Error('private'); } } });
  expect(await (await broken(make())).json()).toEqual({ ok: false, error: 'temporarily_unavailable' });
});
