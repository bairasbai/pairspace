import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { listHardQuestions, readHardQuestion, sealHardQuestion, openHardQuestion, declineHardQuestion, removeHardQuestion } from '../src/hard-questions.ts';
import { adapter, c1, c2, createFixture, id, identityPrincipal, outsider, principal, u2, waiting } from './fixtures.ts';
let pg: PGlite, number = 111000;
const scope = { coupleId: c1, membershipEpoch: 1 }, recipient = identityPrincipal(u2);
const command = () => ({ ...scope, commandId: id(++number) });
const db = () => adapter(pg);
beforeAll(async () => { pg = await createFixture(); await pg.exec(await readFile(new URL('../migrations/041_hard_questions.sql', import.meta.url), 'utf8')); });
afterAll(async () => pg.close());
async function seal(text = 'Synthetic private question') {
  const input = { ...command(), text }, result = await sealHardQuestion(db(), principal, input);
  if (!result.ok) throw Error('fixture');
  return { input, question: result.value.question };
}
it('seals without body in metadata; unopened recipient never queries body; one consent transition supports later reads and canonical retry', async () => {
  expect(await listHardQuestions(db(), principal, scope)).toMatchObject({ ok: true, value: { questions: [], used: 0, capacity: 100 } });
  const { input, question } = await seal('Synthetic question\n\nSecond paragraph');
  const base = db(); let bodyQueries = 0;
  const observed = { ...base, transaction: <T>(work: Parameters<typeof base.transaction<T>>[0]) => base.transaction(tx => work({ query: async <R>(sql: string, args?: unknown[]) => {
    if (sql.startsWith('SELECT body FROM hard_questions')) bodyQueries++;
    return tx.query<R>(sql, args);
  } })) };
  const detail = { ...scope, questionId: question.id };
  expect(JSON.stringify(await listHardQuestions(observed, recipient, scope))).not.toContain(input.text);
  expect(await readHardQuestion(observed, recipient, detail)).toMatchObject({ ok: true, value: { question, checkedAt: '2026-11-10T00:00:00.000Z' } });
  expect(bodyQueries).toBe(0);
  expect(await readHardQuestion(observed, principal, detail)).toMatchObject({ ok: true, value: { text: input.text } }); expect(bodyQueries).toBe(1);
  const opening = { ...command(), questionId: question.id, expectedVersion: 1, confirm: true };
  expect(await openHardQuestion(db(), principal, opening)).toEqual({ ok: false, error: 'unavailable' });
  const opened = await openHardQuestion(observed, recipient, opening);
  expect(opened).toMatchObject({ ok: true, value: { text: input.text, replay: false, checkedAt: '2026-11-10T00:00:00.000Z', question: { decisionState: 'opened', version: 2, openedAt: '2026-11-10T00:00:00.000Z' } } });
  expect(bodyQueries).toBe(2);
  expect(await openHardQuestion(db(), recipient, opening)).toMatchObject({ ok: true, value: { text: input.text, replay: true } });
  for (let n = 0; n < 2; n++) expect(await readHardQuestion(db(), recipient, detail)).toMatchObject({ ok: true, value: { text: input.text } });
  expect(JSON.stringify(await listHardQuestions(db(), recipient, scope))).not.toContain(input.text);
  expect(await openHardQuestion(db(), recipient, { ...opening, commandId: id(++number), expectedVersion: 2 })).toEqual({ ok: false, error: 'version_conflict' });
  expect(await declineHardQuestion(db(), recipient, { ...opening, commandId: id(++number), expectedVersion: 2 })).toEqual({ ok: false, error: 'version_conflict' });
  expect(await removeHardQuestion(db(), recipient, { ...opening, commandId: id(++number), expectedVersion: 2 })).toEqual({ ok: false, error: 'unavailable' });
  const removed = await removeHardQuestion(db(), principal, { ...opening, commandId: id(++number), expectedVersion: 2 });
  expect(removed).toMatchObject({ ok: true, value: { question: { contentState: 'removed', decisionState: 'opened', version: 3, openedAt: '2026-11-10T00:00:00.000Z' } } });
  expect(removed).not.toHaveProperty('value.text');
  expect(await openHardQuestion(db(), recipient, opening)).toMatchObject({ ok: true, value: { replay: true, question: { contentState: 'removed', decisionState: 'opened' } } });
  expect(await openHardQuestion(db(), recipient, opening)).not.toHaveProperty('value.text');
  expect(await readHardQuestion(db(), principal, detail)).not.toHaveProperty('value.text');
  expect(await readHardQuestion(db(), recipient, detail)).not.toHaveProperty('value.text');
  expect(await sealHardQuestion(db(), principal, input)).toMatchObject({ ok: true, value: { replay: true, question: { contentState: 'removed' } } });
  expect(await sealHardQuestion(db(), principal, { ...input, text: 'different' })).toEqual({ ok: false, error: 'idempotency_conflict' });
  expect((await pg.query('SELECT body FROM hard_questions WHERE id=$1', [question.id])).rows[0]).toEqual({ body: null });
});
it('decline never reveals text and preserves own-author access until removal; withdrawal differs from refusal', async () => {
  const { question } = await seal(), action = { ...command(), questionId: question.id, expectedVersion: 1, confirm: true };
  expect(await declineHardQuestion(db(), principal, action)).toEqual({ ok: false, error: 'unavailable' });
  expect(await declineHardQuestion(db(), recipient, action)).toMatchObject({ ok: true, value: { question: { decisionState: 'declined', version: 2 } } });
  const base = db(); let bodies = 0;
  const observed = { ...base, transaction: <T>(work: Parameters<typeof base.transaction<T>>[0]) => base.transaction(tx => work({ query: async <R>(sql: string, args?: unknown[]) => {
    if (sql.startsWith('SELECT body FROM hard_questions')) bodies++;
    return tx.query<R>(sql, args);
  } })) };
  const detail = { ...scope, questionId: question.id };
  expect(await readHardQuestion(observed, recipient, detail)).not.toHaveProperty('value.text'); expect(bodies).toBe(0);
  expect(await readHardQuestion(db(), principal, detail)).toHaveProperty('value.text', 'Synthetic private question');
  expect(await openHardQuestion(db(), recipient, { ...action, commandId: id(++number), expectedVersion: 2 })).toEqual({ ok: false, error: 'version_conflict' });
  expect(await removeHardQuestion(db(), principal, { ...action, commandId: id(++number), expectedVersion: 2 })).toMatchObject({ ok: true, value: { question: { decisionState: 'declined', contentState: 'removed', version: 3 } } });
  expect(await declineHardQuestion(db(), recipient, action)).toMatchObject({ ok: true, value: { replay: true, question: { decisionState: 'declined', contentState: 'removed' } } });
  const waitingQuestion = (await seal()).question;
  const withdrawal = { ...command(), questionId: waitingQuestion.id, expectedVersion: 1, confirm: true };
  expect(await removeHardQuestion(db(), principal, withdrawal)).toMatchObject({ ok: true, value: { question: { contentState: 'removed', decisionState: 'withdrawn', version: 2 } } });
  expect(await removeHardQuestion(db(), principal, withdrawal)).toMatchObject({ ok: true, value: { replay: true } });
  expect(await openHardQuestion(db(), recipient, { ...withdrawal, commandId: id(++number), expectedVersion: 2 })).toEqual({ ok: false, error: 'version_conflict' });
});
it('strict scope/confirmation/version fields reject wrong actor, both pairs, former/closed/waiting and malformed targets', async () => {
  const creation = { ...command(), text: 'Synthetic boundary question' };
  for (const [operation, input] of [[sealHardQuestion, creation], [listHardQuestions, scope]] as const) {
    for (const coupleId of [c2, waiting, id(999)]) expect(await operation(db(), principal, { ...input, coupleId })).toEqual({ ok: false, error: 'unavailable' });
    for (const actor of [identityPrincipal(outsider), { ...principal, userId: 'bad' }, { ...principal, tokenExpiresAt: 1 }]) expect(await operation(db(), actor, input)).toEqual({ ok: false, error: 'unavailable' });
    expect(await operation(db(), principal, { ...input, membershipEpoch: 2 })).toEqual({ ok: false, error: 'stale_membership' });
    for (const bad of [null, [], {}, { ...input, extra: 1 }, { ...input, coupleId: 'bad' }, { ...input, membershipEpoch: 0 }]) expect(await operation(db(), principal, bad)).toEqual({ ok: false, error: 'invalid_request' });
  }
  for (const bad of [{ ...creation, commandId: 'bad' }, { ...creation, text: '' }]) expect(await sealHardQuestion(db(), principal, bad)).toEqual({ ok: false, error: 'invalid_request' });
  const { question } = await seal(), action = { ...command(), questionId: question.id, expectedVersion: 1, confirm: true };
  for (const bad of [{ ...action, questionId: 'bad' }, { ...action, expectedVersion: 0 }, { ...action, expectedVersion: 2147483647 }, { ...action, confirm: false }, { ...action, commandId: 'bad' }]) expect(await openHardQuestion(db(), recipient, bad)).toEqual({ ok: false, error: 'invalid_request' });
  expect(await openHardQuestion(db(), recipient, { ...action, questionId: id(999) })).toEqual({ ok: false, error: 'unavailable' });
  expect(await openHardQuestion(db(), recipient, { ...action, expectedVersion: 2 })).toEqual({ ok: false, error: 'version_conflict' });
  expect(await readHardQuestion(db(), principal, { ...scope, questionId: 'bad' })).toEqual({ ok: false, error: 'invalid_request' });
  expect(await readHardQuestion(db(), principal, { ...scope, questionId: id(999) })).toEqual({ ok: false, error: 'unavailable' });
  expect(await readHardQuestion(db(), { ...principal, tokenExpiresAt: 1 }, { ...scope, questionId: question.id })).toEqual({ ok: false, error: 'unavailable' });
  expect(await readHardQuestion(db(), principal, { ...scope, membershipEpoch: 2, questionId: question.id })).toEqual({ ok: false, error: 'stale_membership' });
});
it('lifetime100 includes tombstones; existing open/decline/remove/read still work at capacity', async () => {
  const used = Number((await pg.query<{ n: number }>('SELECT count(*)::int n FROM hard_questions')).rows[0].n);
  const last: string[] = [];
  for (let n = used; n < 100; n++) last.push((await seal()).question.id);
  expect(await sealHardQuestion(db(), principal, { ...command(), text: 'over' })).toEqual({ ok: false, error: 'capacity_reached' });
  expect(await openHardQuestion(db(), recipient, { ...command(), questionId: last[0], expectedVersion: 1, confirm: true })).toHaveProperty('value.text');
  expect(await declineHardQuestion(db(), recipient, { ...command(), questionId: last[1], expectedVersion: 1, confirm: true })).toMatchObject({ ok: true });
  expect(await removeHardQuestion(db(), principal, { ...command(), questionId: last[0], expectedVersion: 2, confirm: true })).toMatchObject({ ok: true });
  expect(await listHardQuestions(db(), principal, scope)).toMatchObject({ ok: true, value: { used: 100, capacity: 100 } });
});
it('SQL blocks content/identity/choice rewrites, resurrection, no-ops, physical deletion and receipt mutation', async () => {
  const sealed = (await pg.query<{ id: string }>("SELECT id FROM hard_questions WHERE decision_state='sealed' LIMIT 1")).rows[0].id;
  const opened = (await pg.query<{ id: string }>("SELECT id FROM hard_questions WHERE decision_state='opened' AND content_state='removed' LIMIT 1")).rows[0].id;
  for (const sql of [`UPDATE hard_questions SET body='changed',version=version+1 WHERE id='${sealed}'`,
    `UPDATE hard_questions SET opened_at=opened_at+interval '1 second',version=version+1 WHERE id='${opened}'`,
    `UPDATE hard_questions SET content_state='active',decision_state='sealed',body='resurrected',opened_at=NULL,version=version+1 WHERE id='${opened}'`,
    'UPDATE hard_questions SET version=version', 'UPDATE hard_questions SET sequence=sequence+1,version=version+1',
    'DELETE FROM hard_questions', 'UPDATE hard_question_commands SET fingerprint=fingerprint', 'DELETE FROM hard_question_commands']) await expect(pg.query(sql)).rejects.toMatchObject({ code: '23514' });
});
it('rechecks authority after each wait/body projection and rolls back late opening/receipt failure; clock rollback never fabricates freshness', async () => {
  const base = db();
  const intercept = (trigger: string, kind: 'revoke' | 'empty' | 'throw' | 'badBody' = 'revoke') => {
    let live = true;
    return { ...base, sessionAuthority: { ...base.sessionAuthority, recheck: async (...args: Parameters<typeof base.sessionAuthority.recheck>) => live && base.sessionAuthority.recheck(...args) },
      transaction: <T>(work: Parameters<typeof base.transaction<T>>[0]) => base.transaction(tx => work({ query: async <R>(sql: string, args?: unknown[]) => {
        const result = await tx.query<R>(sql, args);
        if (sql.includes(trigger)) {
          if (kind === 'throw') throw Error('unexpected');
          if (kind === 'empty') return { rows: [] };
          if (kind === 'badBody') return { rows: [{ body: ' invalid ' }] as R[] };
          live = false;
        }
        return result;
      } })) };
  };
  expect(await listHardQuestions(intercept('ORDER BY'), principal, scope)).toEqual({ ok: false, error: 'unavailable' });
  const author = identityPrincipal(id(3)), other = identityPrincipal(id(4));
  const creation = { coupleId: c2, membershipEpoch: 1, commandId: id(++number), text: 'Other pair sealed text' };
  expect(await sealHardQuestion(intercept('AS used FROM hard_questions'), author, creation)).toEqual({ ok: false, error: 'unavailable' });
  expect(await sealHardQuestion(intercept('INSERT INTO hard_question_commands'), author, creation)).toEqual({ ok: false, error: 'unavailable' });
  await expect(sealHardQuestion(intercept('INSERT INTO hard_questions', 'empty'), author, creation)).rejects.toThrow('invalid_hard_question_write');
  await expect(sealHardQuestion(intercept('INSERT INTO hard_question_commands', 'empty'), author, creation)).rejects.toThrow('invalid_hard_question_receipt');
  await expect(sealHardQuestion(intercept('INSERT INTO hard_question_commands', 'throw'), author, creation)).rejects.toThrow('unexpected');
  expect((await pg.query('SELECT id FROM hard_questions WHERE couple_id=$1', [c2])).rows).toHaveLength(0);
  const saved = await sealHardQuestion(base, author, creation); if (!saved.ok) throw Error('fixture');
  const detail = { coupleId: c2, membershipEpoch: 1, questionId: saved.value.question.id };
  expect(await sealHardQuestion(intercept('SELECT fingerprint,question_id'), author, creation)).toEqual({ ok: false, error: 'unavailable' });
  expect(await sealHardQuestion(intercept('AND id=$3 FOR UPDATE'), author, creation)).toEqual({ ok: false, error: 'unavailable' });
  expect(await readHardQuestion(intercept('AND id=$3 FOR UPDATE'), author, detail)).toEqual({ ok: false, error: 'unavailable' });
  expect(await readHardQuestion(intercept('SELECT body FROM hard_questions'), author, detail)).toEqual({ ok: false, error: 'unavailable' });
  await expect(readHardQuestion(intercept('SELECT body FROM hard_questions', 'empty'), author, detail)).rejects.toThrow('invalid_hard_question_body');
  await expect(readHardQuestion(intercept('SELECT body FROM hard_questions', 'badBody'), author, detail)).rejects.toThrow('invalid_hard_question_body');
  const opening = { ...detail, commandId: id(++number), expectedVersion: 1, confirm: true };
  expect(await openHardQuestion(intercept('AND id=$3 FOR UPDATE'), other, opening)).toEqual({ ok: false, error: 'unavailable' });
  expect(await openHardQuestion(intercept('INSERT INTO hard_question_commands'), other, opening)).toEqual({ ok: false, error: 'unavailable' });
  expect(await openHardQuestion(intercept('SELECT body FROM hard_questions'), other, opening)).toEqual({ ok: false, error: 'unavailable' });
  await expect(openHardQuestion(intercept('UPDATE hard_questions', 'empty'), other, opening)).rejects.toThrow('invalid_hard_question_write');
  expect((await readHardQuestion(base, author, detail))).toMatchObject({ ok: true, value: { question: { decisionState: 'sealed', version: 1 } } });
  expect(await openHardQuestion({ ...base, now: () => new Date('2020-01-01Z') }, other, opening)).toEqual({ ok: false, error: 'unavailable' });
  expect(await openHardQuestion({ ...base, now: () => new Date('2026-11-09Z') }, other, opening)).toMatchObject({ ok: true, value: { checkedAt: '2026-11-09T00:00:00.000Z', question: { openedAt: saved.value.question.createdAt } } });
  await expect(listHardQuestions({ ...base, now: () => new Date('bad') }, author, { coupleId: c2, membershipEpoch: 1 })).rejects.toThrow('invalid_server_clock');
});
