import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { listLetters, openLetter, sendLetter } from '../src/letters.ts';
import { createLettersHandler } from '../src/letters-http.ts';
import { bindSessionAuthority } from '../src/auth-authority.ts';
import { createSyntheticAuthority } from '../src/synthetic-authority.ts';
import { adapter, c1, c2, createFixture, id, identityPrincipal, outsider, principal, u1, u2, waiting } from './fixtures.ts';
let pg: PGlite;
const scope = { coupleId: c1, membershipEpoch: 1 };
const command = { ...scope, clientId: id(800), body: 'Synthetic e\u0301\r\nletter' };
const db = () => adapter(pg);
let letterId: string;
beforeAll(async () => { pg = await createFixture(); await pg.exec(await readFile(new URL('../migrations/006_letters.sql', import.meta.url), 'utf8')); });
afterAll(async () => { await pg.close(); });
it('sends normalized immutable text once, lists metadata only and opens only for recipient', async () => {
  expect(await listLetters(db(), principal, scope)).toEqual({ ok: true, value: { letters: [] } });
  const first = await sendLetter(db(), principal, command);
  expect(first).toMatchObject({ ok: true, value: { replay: false, letter: { body: 'Synthetic é\nletter', senderId: u1, recipientId: u2 } } });
  if (!first.ok) throw Error('fixture');
  letterId = first.value.letter.id;
  expect(await sendLetter(db(), principal, command)).toMatchObject({ ok: true, value: { replay: true } });
  expect(await sendLetter(db(), principal, { ...command, body: 'edited' })).toEqual({ ok: false, error: 'idempotency_conflict' });
  expect(await listLetters(db(), principal, scope)).toEqual({ ok: true, value: { letters: [] } });
  const incoming = await listLetters(db(), identityPrincipal(u2), scope);
  expect(incoming).toMatchObject({ ok: true, value: { letters: [{ id: letterId }] } });
  expect(JSON.stringify(incoming)).not.toContain('body');
  expect(await openLetter(db(), identityPrincipal(u2), { ...scope, letterId })).toMatchObject({ ok: true, value: { letter: { body: 'Synthetic é\nletter' } } });
  for (const who of [principal, identityPrincipal(outsider)]) expect(await openLetter(db(), who, { ...scope, letterId })).toEqual({ ok: false, error: 'unavailable' });
  expect(await openLetter(db(), identityPrincipal(u2), { ...scope, letterId: id(999) })).toEqual({ ok: false, error: 'unavailable' });
  expect((await pg.query('SELECT * FROM letters')).rows).toHaveLength(1);
  expect((await pg.query('SELECT * FROM outbox_events')).rows).toHaveLength(0);
});
it('rejects malformed requests, wrong pairs, inactive members, stale scopes and expired sessions', async () => {
  for (const bad of [null, [], {}, { ...command, senderId: u2 }, { ...command, clientId: 'bad' }, { ...command, membershipEpoch: 0 },
    { ...command, body: '' }, { ...command, body: '\u0000' }, { ...command, body: 'x'.repeat(8001) }]) {
    expect(await sendLetter(db(), principal, bad)).toEqual({ ok: false, error: 'invalid_request' });
  }
  expect(await openLetter(db(), principal, { ...scope, letterId: 'bad' })).toEqual({ ok: false, error: 'invalid_request' });
  expect(await listLetters(db(), principal, command)).toEqual({ ok: false, error: 'invalid_request' });
  for (const operation of [sendLetter, listLetters, openLetter]) {
    const input = operation === sendLetter ? command : operation === openLetter ? { ...scope, letterId } : scope;
    expect(await operation(db(), { ...principal, userId: 'bad' }, input)).toEqual({ ok: false, error: 'unavailable' });
    for (const coupleId of [c2, waiting, id(999)]) expect(await operation(db(), principal, { ...input, coupleId })).toEqual({ ok: false, error: 'unavailable' });
    expect(await operation(db(), identityPrincipal(outsider), input)).toEqual({ ok: false, error: 'unavailable' });
    expect(await operation(db(), principal, { ...input, membershipEpoch: 2 })).toEqual({ ok: false, error: 'stale_membership' });
    expect(await operation(db(), { ...principal, tokenExpiresAt: 1 }, input)).toEqual({ ok: false, error: 'unavailable' });
    let calls = 0;
    const source = db();
    expect(await operation(bindSessionAuthority(source, { ...source.sessionAuthority, recheck: async () => ++calls === 1 }), principal, input)).toEqual({ ok: false, error: 'unavailable' });
  }
  await expect(sendLetter({ ...db(), now: () => new Date(NaN) }, principal, command)).rejects.toThrow('invalid_server_clock');
  const source = db();
  await expect(sendLetter(bindSessionAuthority({ ...source, now: () => new Date(NaN) }, { ...source.sessionAuthority, recheck: async () => true }), principal, command)).rejects.toThrow('invalid_server_clock');
  await pg.query('UPDATE couples SET membership_epoch=2 WHERE id=$1', [c1]);
  expect(await sendLetter(db(), principal, { ...command, membershipEpoch: 2 })).toEqual({ ok: false, error: 'idempotency_conflict' });
  await pg.query('UPDATE couples SET membership_epoch=1 WHERE id=$1', [c1]);

});
const path = `/v1/couples/${c1}/letters`;
const body = { client_letter_id: id(802), membership_epoch: 1, body: '<script>synthetic</script>' };
const make = (method = 'POST', input: unknown = body, suffix = '', headers: Record<string, string> = {}) => new Request('http://localhost' + path + suffix, {
  method, headers: { authorization: 'Bearer fixture', 'content-type': 'application/json', 'idempotency-key': id(802), ...headers },
  ...(method === 'POST' ? { body: JSON.stringify(input) } : {}),
});
it('enforces strict HTTP schema, status, no-store and redacted errors', async () => {
  const handler = createLettersHandler(bindSessionAuthority(db(), createSyntheticAuthority(async () => principal)));
  expect((await handler(new Request('http://localhost/unknown'))).status).toBe(404);
  expect((await handler(make('DELETE'))).headers.get('allow')).toBe('GET, POST');
  expect((await handler(make('POST', body, '/' + id(999)))).status).toBe(405);
  expect((await handler(make('GET', null, '?membership_epoch=1'))).status).toBe(200);
  for (const suffix of ['', '?membership_epoch=0', '?membership_epoch=1&membership_epoch=1', '?membership_epoch=1&sender_id=x']) expect((await handler(make('GET', null, suffix))).status).toBe(400);
  expect((await handler(make('POST', null, '?x=1'))).status).toBe(400);
  expect((await handler(make('POST', null, '', { 'content-type': 'text/plain' }))).status).toBe(415);
  for (const input of [null, [], {}, { ...body, client_letter_id: 'bad' }, { ...body, client_letter_id: id(700) }, { ...body, sender_id: u2 }]) expect((await handler(make('POST', input))).status).toBe(400);
  expect((await handler(new Request('http://localhost' + path, { method: 'POST', headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' }, body: '{' }))).status).toBe(400);
  const saved = await handler(make()); expect(saved.status).toBe(201); expect(saved.headers.get('cache-control')).toBe('no-store');
  expect((await handler(make())).status).toBe(200);
  expect((await handler(make('POST', { ...body, body: 'changed' }))).status).toBe(409);
  expect((await handler(make('POST', { ...body, membership_epoch: 0 }))).status).toBe(400);
  expect((await handler(make('GET', null, '/' + letterId + '?membership_epoch=1'))).status).toBe(403);
  const recipient = createLettersHandler(bindSessionAuthority(db(), createSyntheticAuthority(async () => identityPrincipal(u2))));
  expect((await recipient(make('GET', null, '/' + letterId + '?membership_epoch=1'))).status).toBe(200);
  const denied = createLettersHandler(bindSessionAuthority(db(), createSyntheticAuthority(async () => null)));
  expect((await denied(make())).status).toBe(401);
  const bad = createLettersHandler({ ...db(), sessionAuthority: { ...db().sessionAuthority, authenticate: async () => ({ ...principal, userId: 'bad' }) } });
  expect((await bad(make())).status).toBe(401);
  const throws = createLettersHandler({ ...db(), sessionAuthority: { ...db().sessionAuthority, authenticate: async () => { throw new Error('private'); } } });
  expect(await (await throws(make())).json()).toEqual({ ok: false, error: 'temporarily_unavailable' });
});
