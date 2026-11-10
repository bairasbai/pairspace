import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { readCareSignal, sendCareSignal } from '../src/care-signals.ts';
import { createCareSignalHandler } from '../src/care-signals-http.ts';
import { bindSessionAuthority } from '../src/auth-authority.ts';
import { createSyntheticAuthority } from '../src/synthetic-authority.ts';
import { adapter, c1, c2, createFixture, id, identityPrincipal, outsider, principal, u1, u2, waiting } from './fixtures.ts';
let pg: PGlite;
let clock = new Date('2026-11-10T00:00:00Z');
const scope = { coupleId: c1, membershipEpoch: 1 };
const command = { ...scope, clientId: id(700) };
const db = () => ({ ...adapter(pg), now: () => clock });
beforeAll(async () => { pg = await createFixture(); await pg.exec(await readFile(new URL('../migrations/005_care_signals.sql', import.meta.url), 'utf8')); });
afterAll(async () => { await pg.close(); });
it('stores a fixed signal once, returns only incoming signal, enforces cooldown and rolling visibility', async () => {
  expect(await readCareSignal(db(), principal, scope)).toEqual({ ok: true, value: { signal: null } });
  const first = await sendCareSignal(db(), principal, command);
  expect(first).toMatchObject({ ok: true, value: { replay: false, signal: { senderId: u1, recipientId: u2, kind: 'thinking_of_you' } } });
  expect(await sendCareSignal(db(), principal, command)).toMatchObject({ ok: true, value: { replay: true } });
  expect(await sendCareSignal(db(), principal, { ...command, clientId: id(701) })).toEqual({ ok: false, error: 'cooldown' });
  expect(await readCareSignal(db(), principal, scope)).toEqual({ ok: true, value: { signal: null } });
  expect(await readCareSignal(db(), identityPrincipal(u2), scope)).toMatchObject({ ok: true, value: { signal: { clientId: command.clientId } } });
  clock = new Date(clock.getTime() + 60000);
  expect(await sendCareSignal(db(), principal, { ...command, clientId: id(701) })).toMatchObject({ ok: true, value: { replay: false } });
  clock = new Date(clock.getTime() + 86400000);
  expect(await readCareSignal(db(), identityPrincipal(u2), scope)).toEqual({ ok: true, value: { signal: null } });
  expect(await sendCareSignal(db(), principal, command)).toMatchObject({ ok: true, value: { replay: true } });
  expect((await pg.query('SELECT * FROM care_signals')).rows).toHaveLength(2);
  expect((await pg.query('SELECT * FROM outbox_events')).rows).toHaveLength(0);
});
it('fails closed for invalid inputs, foreign/waiting/missing pairs and stale membership', async () => {
  for (const bad of [null, [], {}, { ...command, senderId: u2 }, { ...command, clientId: 'bad' }, { ...command, membershipEpoch: 0 }]) {
    expect(await sendCareSignal(db(), principal, bad)).toEqual({ ok: false, error: 'invalid_request' });
  }
  expect(await readCareSignal(db(), principal, command)).toEqual({ ok: false, error: 'invalid_request' });
  for (const operation of [sendCareSignal, readCareSignal]) {
    const input = operation === sendCareSignal ? command : scope;
    expect(await operation(db(), { ...principal, userId: 'bad' }, input)).toEqual({ ok: false, error: 'unavailable' });
    for (const coupleId of [c2, waiting, id(999)]) expect(await operation(db(), principal, { ...input, coupleId })).toEqual({ ok: false, error: 'unavailable' });
    expect(await operation(db(), identityPrincipal(outsider), input)).toEqual({ ok: false, error: 'unavailable' });
    expect(await operation(db(), principal, { ...input, membershipEpoch: 2 })).toEqual({ ok: false, error: 'stale_membership' });
    expect(await operation(db(), { ...principal, tokenExpiresAt: 1 }, input)).toEqual({ ok: false, error: 'unavailable' });
    const invalidClock = { ...db(), now: () => new Date(NaN) };
    await expect(operation(invalidClock, principal, input)).rejects.toThrow('invalid_server_clock');
  }
});
it('binds command forever to original epoch/recipient and rechecks session after pair lock', async () => {
  await pg.query('UPDATE couples SET membership_epoch=2 WHERE id=$1', [c1]);
  expect(await sendCareSignal(db(), principal, { ...command, membershipEpoch: 2 })).toEqual({ ok: false, error: 'idempotency_conflict' });
  await pg.query('UPDATE couples SET membership_epoch=1 WHERE id=$1', [c1]);
  for (const operation of [sendCareSignal, readCareSignal]) {
    let calls = 0;
    const source = db();
    const authority = { ...source.sessionAuthority, recheck: async () => ++calls === 1 };
    expect(await operation(bindSessionAuthority(source, authority), principal, operation === sendCareSignal ? command : scope)).toEqual({ ok: false, error: 'unavailable' });
    const invalidClock = bindSessionAuthority({ ...source, now: () => new Date(NaN) }, { ...authority, recheck: async () => true });
    await expect(operation(invalidClock, principal, operation === sendCareSignal ? command : scope)).rejects.toThrow('invalid_server_clock');
  }
  await pg.query('UPDATE auth_sessions SET revoked_at=CURRENT_TIMESTAMP WHERE id=$1', [principal.sessionId]);
  expect(await sendCareSignal(db(), principal, command)).toEqual({ ok: false, error: 'unavailable' });
  await pg.query('UPDATE auth_sessions SET revoked_at=NULL WHERE id=$1', [principal.sessionId]);
});
const path = `/v1/couples/${c1}/care-signals`;
const make = (method = 'POST', body: unknown = { client_signal_id: id(702), membership_epoch: 1 }, suffix = '', headers: Record<string, string> = {}) => new Request('http://localhost' + path + suffix, {
  method, headers: { authorization: 'Bearer fixture', 'content-type': 'application/json', 'idempotency-key': id(702), ...headers },
  ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
});
it('strict HTTP contract, status, headers, authentication, retries and redacted failure', async () => {
  const handler = createCareSignalHandler(bindSessionAuthority(db(), createSyntheticAuthority(async () => principal)));
  expect((await handler(new Request('http://localhost/unknown'))).status).toBe(404);
  expect((await handler(make('DELETE'))).headers.get('allow')).toBe('GET, POST');
  expect((await handler(make('GET', null, '?membership_epoch=1'))).status).toBe(200);
  for (const suffix of ['', '?membership_epoch=1&membership_epoch=1', '?membership_epoch=1&sender_id=x']) expect((await handler(make('GET', null, suffix))).status).toBe(400);
  expect((await handler(make('POST', null, '?x=1'))).status).toBe(400);
  expect((await handler(make('POST', null, '', { 'content-type': 'text/plain' }))).status).toBe(415);
  for (const body of [null, [], {}, { client_signal_id: 'bad', membership_epoch: 1 }, { client_signal_id: id(700), membership_epoch: 1 }, { client_signal_id: id(702), membership_epoch: 1, sender_id: u2 }]) expect((await handler(make('POST', body))).status).toBe(400);
  expect((await handler(new Request('http://localhost' + path, { method: 'POST', headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' }, body: '{' }))).status).toBe(400);
  const saved = await handler(make()); expect(saved.status).toBe(201); expect(saved.headers.get('cache-control')).toBe('no-store');
  expect((await handler(make())).status).toBe(200);
  const cooldown = await handler(make('POST', { client_signal_id: id(703), membership_epoch: 1 }, '', { 'idempotency-key': id(703) }));
  expect(cooldown.status).toBe(429); expect(cooldown.headers.get('retry-after')).toBe('60');
  expect((await handler(make('POST', { client_signal_id: id(702), membership_epoch: 9 }))).status).toBe(409);
  expect((await handler(make('POST', { client_signal_id: id(702), membership_epoch: 0 }))).status).toBe(400);
  const denied = createCareSignalHandler(bindSessionAuthority(db(), createSyntheticAuthority(async () => null)));
  expect((await denied(make())).status).toBe(401);
  const bad = createCareSignalHandler({ ...db(), sessionAuthority: { ...db().sessionAuthority, authenticate: async () => ({ ...principal, userId: 'bad' }) } });
  expect((await bad(make())).status).toBe(401);
  const revoked = createCareSignalHandler(bindSessionAuthority(db(), createSyntheticAuthority(async () => ({ ...principal, tokenExpiresAt: 1 }))));
  expect((await revoked(make())).status).toBe(403);
  const broken = createCareSignalHandler({ ...db(), transaction: async () => { throw new Error('private'); } });
  const failure = await broken(make()); expect(failure.status).toBe(401);
  const throws = createCareSignalHandler({ ...db(), sessionAuthority: { ...db().sessionAuthority, authenticate: async () => { throw new Error('private'); } } });
  expect(await (await throws(make())).json()).toEqual({ ok: false, error: 'temporarily_unavailable' });
});
