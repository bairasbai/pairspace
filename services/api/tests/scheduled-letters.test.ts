import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { listLetters, openLetter, sendLetter } from '../src/letters.ts';
import { createLettersHandler } from '../src/letters-http.ts';
import { bindSessionAuthority } from '../src/auth-authority.ts';
import { createSyntheticAuthority } from '../src/synthetic-authority.ts';
import { adapter, c1, createFixture, id, identityPrincipal, principal, u2 } from './fixtures.ts';
let pg: PGlite;
const scope = { coupleId: c1, membershipEpoch: 1 };
const releaseAt = '2026-11-10T01:00:00Z';
const command = { ...scope, clientId: id(850), body: 'sealed synthetic content', releaseAt, releaseTimezone: 'UTC' };
const db = (time = '2026-11-10T00:00:00Z') => ({ ...adapter(pg), now: () => new Date(time) });
beforeAll(async () => {
  pg = await createFixture();
  for (const file of ['006_letters.sql', '007_scheduled_letters.sql']) await pg.exec(await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8'));
});
afterAll(async () => { await pg.close(); });
it('keeps metadata sealed and excludes body in SQL until exact server release boundary', async () => {
  const saved = await sendLetter(db(), principal, command);
  expect(saved).toMatchObject({ ok: true, value: { letter: { availability: 'sealed', releaseAt: '2026-11-10T01:00:00.000Z' } } });
  if (!saved.ok) throw new Error('fixture');
  const letterId = saved.value.letter.id;
  const recipient = identityPrincipal(u2);
  const listed = await listLetters(db(), recipient, scope);
  expect(listed).toMatchObject({ ok: true, value: { letters: [{ availability: 'sealed', releaseTimezone: 'UTC' }] } });
  expect(JSON.stringify(listed)).not.toContain('body');
  expect(JSON.stringify(listed)).not.toContain(command.body);
  for (const time of ['2026-11-10T00:00:00Z', '2026-11-10T00:59:59.999Z']) {
    expect(await openLetter(db(time), recipient, { ...scope, letterId })).toEqual({ ok: false, error: 'unavailable' });
  }
  expect(await openLetter(db(releaseAt), recipient, { ...scope, letterId })).toMatchObject({ ok: true, value: { letter: { availability: 'available', body: command.body } } });
  expect(await listLetters(db(releaseAt), recipient, scope)).toMatchObject({ ok: true, value: { letters: [{ availability: 'available' }] } });
  expect(await sendLetter(db('2026-11-11T00:00:00Z'), principal, command)).toMatchObject({ ok: true, value: { replay: true } });
  for (const changes of [{ releaseAt: '2026-11-10T02:00:00Z' }, { releaseTimezone: 'Etc/UTC' }, { body: 'edit' }]) {
    expect(await sendLetter(db(), principal, { ...command, ...changes })).toEqual({ ok: false, error: 'idempotency_conflict' });
  }
  const immediate = { ...scope, clientId: command.clientId, body: command.body };
  expect(await sendLetter(db(), principal, immediate)).toEqual({ ok: false, error: 'idempotency_conflict' });
});
it('validates schema and window after waits, preserves exact minimum/maximum', async () => {
  for (const change of [{ releaseAt: null }, { releaseAt: 'bad' }, { releaseTimezone: undefined },
    { releaseAt: '2026-11-10T00:00:59.999Z' }, { releaseAt: '2027-11-11T00:00:00.001Z' }]) {
    expect(await sendLetter(db(), principal, { ...command, clientId: id(851), ...change })).toEqual({ ok: false, error: 'invalid_request' });
  }
  for (const [index, at] of ['2026-11-10T00:01:00Z', '2027-11-11T00:00:00Z'].entries()) {
    expect(await sendLetter(db(), principal, { ...command, clientId: id(852 + index), releaseAt: at })).toMatchObject({ ok: true });
  }
  let checks = 0;
  let time = '2026-11-10T00:00:00Z';
  const source = { ...adapter(pg), now: () => new Date(time) };
  const waiting = bindSessionAuthority(source, { ...source.sessionAuthority, recheck: async () => {
    if (++checks === 2) time = '2026-11-10T00:59:30Z';
    return true;
  } });
  expect(await sendLetter(waiting, principal, { ...command, clientId: id(854) })).toEqual({ ok: false, error: 'invalid_request' });
  await expect(listLetters(bindSessionAuthority({ ...source, now: () => new Date(NaN) }, { ...source.sessionAuthority, recheck: async () => true }), principal, scope)).rejects.toThrow('invalid_server_clock');
});
it('accepts only paired HTTP schedule fields and does not reflect private content on early opens', async () => {
  const handler = createLettersHandler(bindSessionAuthority(db(), createSyntheticAuthority(async () => principal)));
  const input = { client_letter_id: id(855), membership_epoch: 1, body: command.body, release_at: releaseAt, release_timezone: 'UTC' };
  const request = (body: unknown) => new Request(`http://localhost/v1/couples/${c1}/letters`, { method: 'POST',
    headers: { authorization: 'Bearer fixture', 'content-type': 'application/json', 'idempotency-key': input.client_letter_id }, body: JSON.stringify(body) });
  const response = await handler(request(input));
  expect(response.status).toBe(201);
  const value = await response.json() as { value: { letter: { id: string } } };
  const recipient = createLettersHandler(bindSessionAuthority(db(), createSyntheticAuthority(async () => identityPrincipal(u2))));
  const early = await recipient(new Request(`http://localhost/v1/couples/${c1}/letters/${value.value.letter.id}?membership_epoch=1`, { headers: { authorization: 'Bearer fixture' } }));
  expect(early.status).toBe(403);
  expect(await early.json()).toEqual({ ok: false, error: 'unavailable' });
  for (const body of [{ ...input, release_at: undefined }, { ...input, release_timezone: undefined }, { ...input, release_at: 'bad' }]) expect((await handler(request(body))).status).toBe(400);
});
