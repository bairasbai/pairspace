import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { openBlindRound, readBlindRound, submitBlindAnswer } from '../src/blind-answers.ts';
import { createBlindAnswersHandler } from '../src/blind-answers-http.ts';
import { bindSessionAuthority } from '../src/auth-authority.ts';
import { createSyntheticAuthority } from '../src/synthetic-authority.ts';
import { normalizeAnswer } from '../../../packages/domain/blind/answer.ts';
import { adapter, c1, c2, createFixture, id, identityPrincipal, outsider, principal, u2, u3, waiting } from './fixtures.ts';
let pg: PGlite;
const scope = { coupleId: c1, membershipEpoch: 1 };
const catalog = { questionId: 'small-joy', catalogVersion: 1 };
const command = { ...scope, ...catalog, commandId: id(801) };
const db = () => adapter(pg);
let roundId: string;
beforeAll(async () => { pg = await createFixture(); for (const file of ['010_blind_answers.sql', '011_repeatable_blind_rounds.sql']) await pg.exec(await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8')); });
afterAll(async () => { await pg.close(); });
it('normalizes bounded answers and rejects invalid scalar input', () => {
  expect(normalizeAnswer(' Synthetic e\u0301\n answer ')).toEqual({ ok: true, text: 'Synthetic é answer' });
  for (const answer of [null, 1, '', ' \n ', '\u0000', '\u200b', '\ud800', 'x'.repeat(1001), 'x'.repeat(8001)]) expect(normalizeAnswer(answer)).toEqual({ ok: false });
  expect(normalizeAnswer('😀'.repeat(1000)).ok).toBe(true);
});
it('opens only one round, records immutable retries, and never queries partner body before mutual submission', async () => {
  expect(await readBlindRound(db(), principal, scope)).toEqual({ ok: true, value: { round: null } });
  const first = await openBlindRound(db(), principal, command);
  expect(first).toMatchObject({ ok: true, value: { replay: false, created: true, round: { ownAnswer: null, partnerAnswer: null, revealed: false } } });
  if (!first.ok || !first.value.round) throw Error('fixture');
  roundId = first.value.round.id;
  expect(await openBlindRound(db(), principal, command)).toMatchObject({ ok: true, value: { replay: true } });
  expect(await openBlindRound(db(), identityPrincipal(u2), { ...command, commandId: id(802) })).toMatchObject({ ok: true, value: { created: false, round: { id: roundId } } });
  const answer = { ...command, commandId: id(803), roundId, answer: 'Synthetic first', confirm: true };
  expect(await submitBlindAnswer(db(), principal, answer)).toMatchObject({ ok: true, value: { replay: false, round: { ownAnswer: 'Synthetic first', partnerAnswer: null, revealed: false } } });
  const source = db(); const queries: { sql: string; params?: unknown[] }[] = [];
  const traced = { ...source, transaction: <T>(work: Parameters<typeof source.transaction<T>>[0]) => source.transaction(tx => work({ query: async <R>(sql: string, params?: unknown[]) => { queries.push({ sql, params }); return tx.query<R>(sql, params); } })) };
  expect(await readBlindRound(traced, identityPrincipal(u2), scope)).toMatchObject({ ok: true, value: { round: { ownAnswer: null, partnerAnswer: null, revealed: false } } });
  expect(queries.filter(q => /SELECT body FROM blind_answers/.test(q.sql)).map(q => q.params?.[1])).toEqual([u2]);
  expect(await submitBlindAnswer(db(), principal, answer)).toMatchObject({ ok: true, value: { replay: true } });
  expect(await submitBlindAnswer(db(), principal, { ...answer, answer: 'changed' })).toEqual({ ok: false, error: 'idempotency_conflict' });
  expect(await submitBlindAnswer(db(), principal, { ...answer, roundId: id(999) })).toEqual({ ok: false, error: 'idempotency_conflict' });
  expect(await submitBlindAnswer(db(), principal, { ...answer, commandId: id(804) })).toEqual({ ok: false, error: 'already_submitted' });
  expect(await submitBlindAnswer(db(), principal, { ...answer, commandId: command.commandId })).toEqual({ ok: false, error: 'idempotency_conflict' });
  expect(await submitBlindAnswer(db(), identityPrincipal(u2), { ...answer, commandId: id(805), answer: 'Synthetic second' })).toMatchObject({ ok: true, value: { round: { ownAnswer: 'Synthetic second', partnerAnswer: 'Synthetic first', revealed: true } } });
  expect(await submitBlindAnswer(db(), principal, answer)).toMatchObject({ ok: true, value: { replay: true, round: { ownAnswer: 'Synthetic first', partnerAnswer: 'Synthetic second', revealed: true } } });
  expect(await openBlindRound(db(), principal, { ...command, commandId: id(806) })).toMatchObject({ ok: true, value: { round: { id: roundId, revealed: true } } });
  expect((await pg.query('SELECT id FROM blind_rounds')).rows).toHaveLength(1);
});
it('rejects all malformed scope, catalog, confirmation and auth states', async () => {
  const answer = { ...command, commandId: id(810), roundId, answer: 'Synthetic', confirm: true };
  for (const bad of [null, [], {}, { ...command, extra: 1 }, { ...command, commandId: 'bad' }, { ...command, membershipEpoch: 0 }, { ...command, questionId: 'bad' }, { ...command, catalogVersion: 2 }]) {
    expect(await openBlindRound(db(), principal, bad)).toEqual({ ok: false, error: 'invalid_request' });
  }
  for (const change of [{ roundId: 'bad' }, { confirm: false }, { answer: '' }]) expect(await submitBlindAnswer(db(), principal, { ...answer, ...change })).toEqual({ ok: false, error: 'invalid_request' });
  expect(await readBlindRound(db(), principal, command)).toEqual({ ok: false, error: 'invalid_request' });
  expect(await submitBlindAnswer(db(), principal, { ...answer, roundId: id(999) })).toEqual({ ok: false, error: 'unavailable' });
  expect(await submitBlindAnswer(db(), identityPrincipal(u3), { ...answer, coupleId: c2 })).toEqual({ ok: false, error: 'unavailable' });
  for (const [operation, input] of [[openBlindRound, command], [submitBlindAnswer, answer], [readBlindRound, scope]] as const) {
    expect(await operation(db(), { ...principal, userId: 'bad' }, input)).toEqual({ ok: false, error: 'unavailable' });
    for (const coupleId of [c2, waiting, id(999)]) expect(await operation(db(), principal, { ...input, coupleId })).toEqual({ ok: false, error: 'unavailable' });
    expect(await operation(db(), identityPrincipal(outsider), input)).toEqual({ ok: false, error: 'unavailable' });
    expect(await operation(db(), principal, { ...input, membershipEpoch: 2 })).toEqual({ ok: false, error: 'stale_membership' });
    expect(await operation(db(), { ...principal, tokenExpiresAt: 1 }, input)).toEqual({ ok: false, error: 'unavailable' });
    let checks = 0; const source = db();
    expect(await operation(bindSessionAuthority(source, { ...source.sessionAuthority, recheck: async () => ++checks === 1 }), principal, input)).toEqual({ ok: false, error: 'unavailable' });
  }
  await pg.query('UPDATE couples SET membership_epoch=2 WHERE id=$1', [c1]);
  expect(await openBlindRound(db(), principal, { ...command, membershipEpoch: 2 })).toEqual({ ok: false, error: 'idempotency_conflict' });
  await pg.query('UPDATE couples SET membership_epoch=1 WHERE id=$1', [c1]);
  await pg.query("UPDATE couples SET status='closed' WHERE id=$1", [c1]);
  expect(await readBlindRound(db(), principal, scope)).toEqual({ ok: false, error: 'unavailable' });
  await pg.query("UPDATE couples SET status='active' WHERE id=$1", [c1]);
});
const path = `/v1/couples/${c1}/blind-round`;
const body = { command_id: id(850), membership_epoch: 1, question_id: 'small-joy', catalog_version: 1 };
const make = (method = 'POST', input: unknown = body, suffix = '', headers: Record<string, string> = {}) => new Request('http://localhost' + path + suffix, {
  method, headers: { authorization: 'Bearer fixture', 'content-type': 'application/json', 'idempotency-key': id(850), ...headers },
  ...(method === 'POST' ? { body: JSON.stringify(input) } : {}),
});
it('enforces HTTP schema, routes, authorization and redacted failures', async () => {
  const handler = createBlindAnswersHandler(bindSessionAuthority(db(), createSyntheticAuthority(async () => principal)));
  expect((await handler(new Request('http://localhost/unknown'))).status).toBe(404);
  expect((await handler(make('DELETE'))).headers.get('allow')).toBe('GET, POST');
  expect((await handler(make('GET', null, '/' + roundId + '/answer'))).status).toBe(405);
  expect((await handler(make('GET', null, '?membership_epoch=1'))).status).toBe(200);
  for (const suffix of ['', '?membership_epoch=0', '?membership_epoch=1&membership_epoch=1', '?membership_epoch=1&actor=x']) expect((await handler(make('GET', null, suffix))).status).toBe(400);
  expect((await handler(make('POST', body, '?x=1'))).status).toBe(400);
  expect((await handler(make('POST', body, '', { 'content-type': 'text/plain' }))).status).toBe(415);
  for (const input of [null, [], {}, { ...body, command_id: 'bad' }, { ...body, command_id: id(800) }, { ...body, actor: u2 }]) expect((await handler(make('POST', input))).status).toBe(400);
  expect((await handler(new Request('http://localhost' + path, { method: 'POST', headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' }, body: '{' }))).status).toBe(400);
  const saved = await handler(make()); expect(saved.status).toBe(200); expect(saved.headers.get('cache-control')).toBe('no-store');
  expect((await handler(make())).status).toBe(200);
  expect((await handler(make('POST', { ...body, membership_epoch: 0 }))).status).toBe(400);
  const answer = { ...body, answer: 'Synthetic', confirm: true };
  expect((await handler(make('POST', answer, '/' + roundId + '/answer'))).status).toBe(409);
  expect((await handler(make('POST', { ...answer, command_id: id(851) }, '/' + id(999) + '/answer', { 'idempotency-key': id(851) }))).status).toBe(403);
  for (const principalValue of [null, { ...principal, userId: 'bad' }, { ...principal, source: 'better-auth' as const, authUserId: 'synthetic-auth' }]) {
    const denied = createBlindAnswersHandler(bindSessionAuthority(db(), createSyntheticAuthority(async () => principalValue)));
    expect((await denied(make())).status).toBe(401);
  }
  const throws = createBlindAnswersHandler({ ...db(), sessionAuthority: { ...db().sessionAuthority, authenticate: async () => { throw Error('secret answer'); } } });
  expect(await (await throws(make())).json()).toEqual({ ok: false, error: 'temporarily_unavailable' });
  const other = createBlindAnswersHandler(bindSessionAuthority(db(), createSyntheticAuthority(async () => identityPrincipal(u3))));
  const first = await other(new Request('http://localhost' + path.replace(c1, c2), { method: 'POST', headers: { authorization: 'Bearer fixture', 'content-type': 'application/json', 'idempotency-key': id(850) }, body: JSON.stringify(body) }));
  expect(first.status).toBe(201);
});
it('database rejects record edits, deletion and nonparticipant answers or receipts', async () => {
  for (const table of ['blind_rounds', 'blind_answers', 'blind_commands']) {
    await expect(pg.query(`DELETE FROM ${table}`)).rejects.toMatchObject({ code: '23514' });
  }
  for (const sql of ["UPDATE blind_rounds SET question_id='other'", "UPDATE blind_answers SET body='edited'", "UPDATE blind_commands SET operation='answer'"]) await expect(pg.query(sql)).rejects.toMatchObject({ code: '23514' });
  await expect(pg.query('INSERT INTO blind_answers(round_id,author_id,body) VALUES($1,$2,$3)', [roundId, outsider, 'Synthetic'])).rejects.toMatchObject({ code: '23514' });
  await expect(pg.query("INSERT INTO blind_commands(actor_user_id,command_id,round_id,operation) VALUES($1,$2,$3,'open')", [outsider, id(890), roundId])).rejects.toMatchObject({ code: '23514' });
});
