import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { listBlindRounds, nextBlindRound, openBlindRound, readBlindRound, readSelectedBlindRound, submitBlindAnswer } from '../src/blind-answers.ts';
import { blindQuestion, blindQuestions, findBlindQuestion } from '../../../packages/domain/blind/catalog.ts';
import { createBlindAnswersHandler } from '../src/blind-answers-http.ts';
import { bindSessionAuthority } from '../src/auth-authority.ts';
import { createSyntheticAuthority } from '../src/synthetic-authority.ts';
import { adapter, c1, c2, createFixture, id, identityPrincipal, principal, u2, u3 } from './fixtures.ts';
let pg: PGlite;
const scope = { coupleId: c1, membershipEpoch: 1 };
const catalog = { questionId: 'small-joy', catalogVersion: 1 };
let serial = 9000;
const command = () => id(++serial);
const db = () => adapter(pg);
let firstId: string;
let secondId: string;
let nextCommand: ReturnType<typeof nextInput>;
const nextInput = (predecessor: string) => ({ ...scope, questionId: 'shared-plan', catalogVersion: 1,
  expectedPredecessorRoundId: predecessor, commandId: command(), confirm: true });
beforeAll(async () => {
  pg = await createFixture();
  for (const file of ['010_blind_answers.sql', '011_repeatable_blind_rounds.sql']) await pg.exec(await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8'));
});
afterAll(async () => { await pg.close(); });
async function complete(roundId: string, questionId = 'small-joy') {
  for (const actor of [principal, identityPrincipal(u2)]) expect(await submitBlindAnswer(db(), actor,
    { ...scope, questionId, catalogVersion: 1, roundId, commandId: command(), answer: 'Synthetic answer', confirm: true })).toMatchObject({ ok: true });
}
it('keeps catalog immutable and exact compatibility text', () => {
  expect(blindQuestions).toHaveLength(3);
  expect(blindQuestion.ru).toBe('Какая маленькая радость сделала бы сегодняшний день приятнее?');
  expect(blindQuestion.en).toBe('What small joy would make today nicer?');
  for (const q of blindQuestions) { expect(findBlindQuestion(q.id, 1)).toBe(q); expect(Object.isFrozen(q)).toBe(true); expect(q.ru.length).toBeGreaterThan(10); expect(q.en.length).toBeGreaterThan(10); }
  expect(Object.isFrozen(blindQuestions)).toBe(true);
  expect(findBlindQuestion('small-joy', 2)).toBeUndefined();
  expect(findBlindQuestion('unknown', 1)).toBeUndefined();
});
it('requires a complete immediate predecessor, and replays original immutable targets after advancing', async () => {
  expect(await listBlindRounds(db(), principal, scope)).toEqual({ ok: true, value: { currentRoundId: null, rounds: [], limit: 10 } });
  expect(await nextBlindRound(db(), principal, nextInput(id(999)))).toEqual({ ok: false, error: 'round_conflict' });
  const initialCommand = { ...scope, ...catalog, commandId: command() };
  const opened = await openBlindRound(db(), principal, initialCommand);
  if (!opened.ok || !opened.value.round) throw Error('fixture');
  firstId = opened.value.round.id;
  nextCommand = nextInput(firstId);
  expect(await nextBlindRound(db(), principal, nextCommand)).toEqual({ ok: false, error: 'round_conflict' });
  await complete(firstId);
  const second = await nextBlindRound(db(), principal, nextCommand);
  expect(second).toMatchObject({ ok: true, value: { created: true, replay: false, round: { questionId: 'shared-plan', ownAnswer: null, partnerAnswer: null, revealed: false } } });
  if (!second.ok || !second.value.round) throw Error('fixture');
  secondId = second.value.round.id;
  expect(await nextBlindRound(db(), principal, nextCommand)).toMatchObject({ ok: true, value: { replay: true, round: { id: secondId } } });
  expect(await nextBlindRound(db(), principal, { ...nextCommand, commandId: command() })).toEqual({ ok: false, error: 'round_conflict' });
  for (const change of [{ questionId: 'kind-memory' }, { expectedPredecessorRoundId: secondId }]) expect(await nextBlindRound(db(), principal, { ...nextCommand, ...change })).toEqual({ ok: false, error: 'idempotency_conflict' });
  expect(await readBlindRound(db(), principal, scope)).toMatchObject({ ok: true, value: { round: { id: firstId } } });
  expect(await openBlindRound(db(), principal, initialCommand)).toMatchObject({ ok: true, value: { replay: true, round: { id: firstId } } });
  expect(await openBlindRound(db(), principal, { ...initialCommand, commandId: command() })).toMatchObject({ ok: true, value: { created: false, round: { id: firstId } } });
  const answer = { ...scope, ...catalog, questionId: 'shared-plan', roundId: secondId, commandId: command(), answer: 'Synthetic own', confirm: true };
  expect(await submitBlindAnswer(db(), principal, { ...answer, questionId: 'small-joy' })).toEqual({ ok: false, error: 'invalid_request' });
  expect(await submitBlindAnswer(db(), principal, answer)).toMatchObject({ ok: true });
  expect(await submitBlindAnswer(db(), identityPrincipal(u2), { ...answer, commandId: command() })).toMatchObject({ ok: true });
  const third = await nextBlindRound(db(), principal, { ...nextInput(secondId), questionId: 'kind-memory' });
  expect(third).toMatchObject({ ok: true, value: { created: true } });
  expect(await nextBlindRound(db(), principal, nextCommand)).toMatchObject({ ok: true, value: { replay: true, round: { id: secondId } } });
  expect(await submitBlindAnswer(db(), principal, answer)).toMatchObject({ ok: true, value: { replay: true, round: { id: secondId } } });
  expect(await readSelectedBlindRound(db(), principal, { ...scope, roundId: secondId })).toMatchObject({ ok: true, value: { round: { id: secondId, revealed: true } } });
});
it('limits history to latest ten metadata entries in chain order without answer queries', async () => {
  let history = await listBlindRounds(db(), principal, scope);
  if (!history.ok) throw Error('fixture');
  let current = history.value.currentRoundId!;
  for (let n = 0; n < 10; n++) {
    await complete(current, n === 0 ? 'kind-memory' : 'shared-plan');
    const next = await nextBlindRound(db(), principal, nextInput(current));
    if (!next.ok || !next.value.round) throw Error('fixture');
    current = next.value.round.id;
  }
  const source = db(); const queries: string[] = [];
  const traced = { ...source, transaction: <T>(work: Parameters<typeof source.transaction<T>>[0]) => source.transaction(tx => work({ query: async <R>(sql: string, params?: unknown[]) => { queries.push(sql); return tx.query<R>(sql, params); } })) };
  history = await listBlindRounds(traced, principal, scope);
  if (!history.ok) throw Error('fixture');
  expect(history.value.currentRoundId).toBe(current);
  expect(history.value.rounds).toHaveLength(10);
  expect(history.value.rounds![0].id).toBe(current);
  expect(history.value.rounds!.every(round => Object.keys(round).sort().join(',') === 'catalogVersion,id,questionId')).toBe(true);
  expect(queries.some(sql => sql.includes('blind_answers'))).toBe(false);
  expect(history.value.rounds!.some(round => round.id === firstId || round.id === secondId)).toBe(false);
  expect(await readSelectedBlindRound(db(), principal, { ...scope, roundId: firstId })).toMatchObject({ ok: true });
});
it('rejects malformed inputs, cross-pair reads, stale epochs and lost membership on history and replay', async () => {
  for (const change of [{ confirm: false }, { expectedPredecessorRoundId: 'bad' }, { questionId: 'unknown' }, { catalogVersion: 2 }]) expect(await nextBlindRound(db(), principal, { ...nextCommand, ...change })).toEqual({ ok: false, error: 'invalid_request' });
  expect(await readSelectedBlindRound(db(), principal, { ...scope, roundId: 'bad' })).toEqual({ ok: false, error: 'invalid_request' });
  expect(await readSelectedBlindRound(db(), principal, { ...scope, roundId: id(999) })).toEqual({ ok: false, error: 'unavailable' });
  expect(await readSelectedBlindRound(db(), identityPrincipal(u3), { coupleId: c2, membershipEpoch: 1, roundId: firstId })).toEqual({ ok: false, error: 'unavailable' });
  for (const [operation, input] of [[listBlindRounds, scope], [readSelectedBlindRound, { ...scope, roundId: firstId }], [nextBlindRound, nextCommand]] as const) {
    expect(await operation(db(), principal, { ...input, membershipEpoch: 2 })).toEqual({ ok: false, error: 'stale_membership' });
    expect(await operation(db(), identityPrincipal(u3), input)).toEqual({ ok: false, error: 'unavailable' });
  }
  await pg.query("UPDATE couples SET status='closed' WHERE id=$1", [c1]);
  expect(await nextBlindRound(db(), principal, nextCommand)).toEqual({ ok: false, error: 'unavailable' });
  expect(await listBlindRounds(db(), principal, scope)).toEqual({ ok: false, error: 'unavailable' });
  await pg.query("UPDATE couples SET status='active' WHERE id=$1", [c1]);
});
it('routes strict history/selected/next HTTP contracts without legacy collisions', async () => {
  const handler = createBlindAnswersHandler(bindSessionAuthority(db(), createSyntheticAuthority(async () => principal)));
  const base = `http://localhost/v1/couples/${c1}/blind-rounds`;
  const get = (suffix = '?membership_epoch=1', method = 'GET') => handler(new Request(base + suffix, { method, headers: { authorization: 'Bearer fixture' } }));
  expect((await get()).status).toBe(200);
  expect(await (await get('/' + firstId + '?membership_epoch=1')).json()).toMatchObject({ ok: true, value: { round: { id: firstId } } });
  expect((await get('/next?membership_epoch=1')).status).toBe(405);
  expect((await get('', 'POST')).status).toBe(405);
  expect((await get('/' + firstId, 'POST')).status).toBe(405);
  expect((await get('?membership_epoch=1&limit=10')).status).toBe(400);
  const payload = { command_id: nextCommand.commandId, membership_epoch: 1, expected_predecessor_round_id: firstId,
    question_id: 'shared-plan', catalog_version: 1, confirm: true };
  const post = (body: unknown, key = payload.command_id) => handler(new Request(base + '/next', { method: 'POST',
    headers: { authorization: 'Bearer fixture', 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(body) }));
  expect(await (await post(payload)).json()).toMatchObject({ ok: true, value: { replay: true, round: { id: secondId } } });
  expect((await post(payload, command())).status).toBe(400);
  expect((await post({ ...payload, confirm: false })).status).toBe(400);
  expect((await post({ ...payload, extra: true })).status).toBe(400);
  const key = command();
  expect((await post({ ...payload, command_id: key }, key)).status).toBe(409);
});
it('SQL blocks unfinished predecessors, forks, cross-scope links and noncurrent snapshots', async () => {
  const history = await listBlindRounds(db(), principal, scope);
  if (!history.ok) throw Error('fixture');
  const insert = (couple: string, epoch: number, one: string, two: string, previous: string | null) => pg.query(
    `INSERT INTO blind_rounds(couple_id,membership_epoch,question_id,catalog_version,participant_one,participant_two,predecessor_round_id)
     VALUES($1,$2,'small-joy',1,$3,$4,$5)`, [couple, epoch, one, two, previous]);
  await expect(insert(c1, 1, principal.userId, u2, history.value.currentRoundId!)).rejects.toMatchObject({ code: '23514' });
  await expect(insert(c1, 1, principal.userId, u2, firstId)).rejects.toMatchObject({ code: '23514' });
  await expect(insert(c1, 1, principal.userId, u2, null)).rejects.toMatchObject({ code: '23514' });
  await expect(insert(c1, 2, principal.userId, u2, null)).rejects.toMatchObject({ code: '23514' });
  await expect(insert(c1, 1, principal.userId, u3, null)).rejects.toMatchObject({ code: '23514' });
  await expect(insert(c2, 1, principal.userId, u2, firstId)).rejects.toMatchObject({ code: '23514' });
});
it('forward migration preserves old round, answer and command bytes without backfill', async () => {
  const old = await createFixture();
  try {
    await old.exec(await readFile(new URL('../migrations/010_blind_answers.sql', import.meta.url), 'utf8'));
    const row = (await old.query<{ id: string }>(`INSERT INTO blind_rounds(couple_id,membership_epoch,question_id,catalog_version,participant_one,participant_two)
      VALUES($1,1,'small-joy',1,$2,$3) RETURNING id`, [c1, principal.userId, u2])).rows[0];
    await old.query('INSERT INTO blind_answers(round_id,author_id,body) VALUES($1,$2,$3)', [row.id, principal.userId, 'Synthetic retained']);
    await old.query("INSERT INTO blind_commands(actor_user_id,command_id,round_id,operation) VALUES($1,$2,$3,'open')", [principal.userId, id(9800), row.id]);
    const before = (await old.query('SELECT row_to_json(r) AS data FROM blind_rounds r')).rows;
    const answers = (await old.query('SELECT * FROM blind_answers')).rows;
    const receipts = (await old.query('SELECT * FROM blind_commands')).rows;
    await old.exec(await readFile(new URL('../migrations/011_repeatable_blind_rounds.sql', import.meta.url), 'utf8'));
    expect((await old.query("SELECT to_jsonb(r)-'predecessor_round_id' AS data FROM blind_rounds r")).rows).toEqual(before);
    expect((await old.query('SELECT * FROM blind_answers')).rows).toEqual(answers);
    expect((await old.query('SELECT * FROM blind_commands')).rows).toEqual(receipts);
    expect(await readBlindRound(adapter(old), principal, scope)).toMatchObject({ ok: true, value: { round: { id: row.id, ownAnswer: 'Synthetic retained' } } });
    expect(await openBlindRound(adapter(old), principal, { ...scope, ...catalog, commandId: id(9800) })).toMatchObject({ ok: true, value: { replay: true } });
  } finally { await old.close(); }
});
