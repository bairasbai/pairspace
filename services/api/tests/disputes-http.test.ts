import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createDisputesHandler } from '../src/disputes-http.ts';
import { adapter, c1, c2, createFixture, id, identityPrincipal, principal, u2 } from './fixtures.ts';
let pg: PGlite;
beforeAll(async () => { pg = await createFixture(); await pg.exec(await readFile(new URL('../migrations/045_disputes.sql', import.meta.url), 'utf8')); });
afterAll(async () => pg.close());
let now = '2026-11-10T00:00:00.000Z';
const clock = () => new Date(now);
const base = `http://localhost/v1/couples/${c1}/disputes`;
const create = { membership_epoch: 1, command_id: id(121001), claim: 'Synthetic shared HTTP claim', condition: 'Optional shared activity', judge_date: '2026-11-11', timezone: 'Europe/Moscow', confirm: true };
function make(method = 'POST', value: unknown = create, url = base, headers: Headers | Record<string, string> = {
  'content-type': 'application/json', 'idempotency-key': (value as { command_id?: string })?.command_id ?? create.command_id,
}) {
  return new Request(url, { method, headers, ...(method === 'GET' ? {} : { body: typeof value === 'string' ? value : JSON.stringify(value) }) });
}
const db = () => { const d = adapter(pg); return { ...d, sessionAuthority: { ...d.sessionAuthority, authenticate: async () => principal } }; };
const noText = (value: unknown) => { expect(JSON.stringify(value)).not.toMatch(/"(?:claim|condition|body|text)"\s*:/); };
it('lists and command ACKs omit terms; separate read is shared, consent and due verdict are explicit, removal is body-free', async () => {
  const d = db(), author = createDisputesHandler(d, clock), recipient = createDisputesHandler({ ...d, sessionAuthority: { ...d.sessionAuthority, authenticate: async () => identityPrincipal(u2) } }, clock);
  const response = await author(make()); expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store'); expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  const made = await response.json() as { value: { dispute: { id: string } } }; noText(made);
  const target = base + '/' + made.value.dispute.id;
  for (const actor of [author, recipient]) {
    noText(await (await actor(make('GET', null, base + '?membership_epoch=1'))).json());
    expect(await (await actor(make('GET', null, target + '/text?membership_epoch=1'))).json()).toMatchObject({ value: { claim: create.claim, condition: create.condition } });
  }
  const join = { membership_epoch: 1, command_id: id(121002), expected_version: 1, confirm: true };
  expect((await author(make('POST', join, target + '/join'))).status).toBe(403);
  const accepted = await recipient(make('POST', join, target + '/join')); expect(accepted.status).toBe(200); noText(await accepted.json());
  expect(await (await recipient(make('POST', join, target + '/join'))).json()).toHaveProperty('value.replay', true);
  const resolve = { ...join, command_id: id(121003), expected_version: 2, winner_id: null };
  expect((await author(make('POST', resolve, target + '/resolve'))).status).toBe(409);
  now = '2026-11-10T21:00:00.000Z';
  const result = await author(make('POST', resolve, target + '/resolve')); expect(result.status).toBe(200); noText(await result.json());
  expect((await recipient(make('POST', { ...join, command_id: id(121004), expected_version: 3 }, target + '/decline'))).status).toBe(409);
  const removal = { ...join, command_id: id(121005), expected_version: 3 };
  expect((await recipient(make('DELETE', removal, target))).status).toBe(403);
  const removed = await author(make('DELETE', removal, target)); expect(removed.status).toBe(200); noText(await removed.json());
  noText(await (await author(make('GET', null, target + '/text?membership_epoch=1'))).json());
  noText(await (await author(make())).json());
  expect((await author(make('GET', null, base.replace(c1, c2) + '?membership_epoch=1'))).status).toBe(403);
});
it('decline remains possible after due without choosing a winner', async () => {
  now = '2026-11-10T00:00:00.000Z'; const d = db(), author = createDisputesHandler(d, clock);
  const recipient = createDisputesHandler({ ...d, sessionAuthority: { ...d.sessionAuthority, authenticate: async () => identityPrincipal(u2) } }, clock);
  const response = await author(make('POST', { ...create, command_id: id(121010), condition: null })); expect(response.status).toBe(200);
  const made = await response.json() as { value: { dispute: { id: string } } }; const target = base + '/' + made.value.dispute.id;
  now = '2026-11-11T00:00:00.000Z'; const command = { membership_epoch: 1, command_id: id(121011), expected_version: 1, confirm: true };
  expect((await recipient(make('POST', command, target + '/join'))).status).toBe(409);
  const declined = await recipient(make('POST', { ...command, command_id: id(121012) }, target + '/decline'));
  expect(declined.status).toBe(200); noText(await declined.json());
});
it('enforces methods, exact queries and payloads, decoded duplicate keys and idempotency binding', async () => {
  const handler = createDisputesHandler(db(), clock);
  for (const [suffix, allow] of [['', 'GET, POST'], ['/x', 'DELETE'], ['/x/join', 'POST'], ['/x/decline', 'POST'], ['/x/resolve', 'POST'], ['/x/text', 'GET']]) {
    const r = await handler(make('PUT', {}, base + suffix)); expect(r.status).toBe(405); expect(r.headers.get('allow')).toBe(allow);
  }
  expect((await handler(make('POST', {}, base + '/x/unknown'))).status).toBe(404);
  for (const q of ['', '?membership_epoch=0', '?membership_epoch=1&membership_epoch=1', '?membership_epoch=1&x=2', '?membership_epoch=1&membership_%65poch=1']) expect((await handler(make('GET', null, base + q))).status).toBe(400);
  expect((await handler(make('POST', create, base + '?x=2'))).status).toBe(400);
  expect((await handler(make('POST', create, base, {}))).status).toBe(415);
  for (const invalid of ['{', null, [], {}, { ...create, extra: 1 }, { ...create, command_id: 'bad' }, { ...create, claim: 'x'.repeat(70000) },
    '{"confirm":false,"confirm":true}', '{"confirm":false,"confi\\u0072m":true}', '{"nested":{"a":1,"\\u0061":2}}']) expect((await handler(make('POST', invalid))).status).toBe(400);
  for (const key of ['command_id', 'command_\\u0069d', 'confirm']) {
    const raw = JSON.stringify(create).slice(0, -1) + ',"' + key + '":' + JSON.stringify(key === 'confirm' ? true : create.command_id) + '}';
    expect((await handler(make('POST', raw))).status).toBe(400);
  }
  const duplicateHeader = new Headers({ 'content-type': 'application/json', 'idempotency-key': create.command_id }); duplicateHeader.append('idempotency-key', create.command_id);
  expect((await handler(make('POST', create, base, duplicateHeader))).status).toBe(400);
  expect((await handler(make('POST', create, base, { 'content-type': 'application/json', 'idempotency-key': id(1) }))).status).toBe(400);
  const command = { membership_epoch: 1, command_id: id(121100), expected_version: 1, confirm: true };
  expect((await handler(make('POST', command, base + '/' + id(1) + '/resolve'))).status).toBe(400);
  expect((await handler(make('POST', { ...command, winner_id: null }, base + '/' + id(1) + '/join'))).status).toBe(400);
});
it('fails closed for authentication, transaction recheck and opaque backend errors', async () => {
  const normal = db();
  for (const actor of [null, { ...principal, userId: 'bad' }, { ...principal, source: 'better-auth' as const, authUserId: 'x' }]) expect((await createDisputesHandler({ ...normal, sessionAuthority: { ...normal.sessionAuthority, authenticate: async () => actor } })(make())).status).toBe(401);
  expect((await createDisputesHandler({ ...normal, sessionAuthority: { ...normal.sessionAuthority, recheck: async () => false } })(make())).status).toBe(403);
  const broken = createDisputesHandler({ ...normal, sessionAuthority: { ...normal.sessionAuthority, authenticate: async () => { throw Error('private'); } } });
  expect(await (await broken(make())).json()).toEqual({ ok: false, error: 'temporarily_unavailable' });
});
