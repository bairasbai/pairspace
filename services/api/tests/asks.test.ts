import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { normalizeAskText } from '../../../packages/domain/asks/text.ts';
import { createQuestion, answerQuestion, skipQuestion, removeQuestion, removeAnswer, listQuestions } from '../src/asks.ts';
import { adapter, c1, c2, createFixture, id, identityPrincipal, outsider, principal, u2, waiting } from './fixtures.ts';
let pg: PGlite;
const scope = { coupleId: c1, membershipEpoch: 1 };
const partner = identityPrincipal(u2);
let n = 60000;
const command = () => ({ ...scope, commandId: id(++n) });
const db = () => adapter(pg);
beforeAll(async () => { pg = await createFixture(); await pg.exec("CREATE FUNCTION immutable_shared_date() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'immutable' USING ERRCODE='23514'; END $$;"); await pg.exec(await readFile(new URL('../migrations/037_asks.sql', import.meta.url), 'utf8')); });
afterAll(async () => pg.close());
const newQuestion = async () => {
    const input = { ...command(), text: 'Synthetic question' };
    const result = await createQuestion(db(), principal, input);
    if (!result.ok)
        throw Error('fixture');
    return { input, question: result.value.question };
};
it('normalizes bounded paragraphs, rejects malformed strings and controls', () => {
    expect(normalizeAskText(' e\u0301\r\nnext ')).toBe('é\nnext');
    expect(normalizeAskText('😀'.repeat(2000))).not.toBeNull();
    for (const value of [null, undefined, 3, '', ' ', '\ud800', '\udfff', 'a\tb', '\tq', 'q\t', '\0', '\u0080', 'x'.repeat(2001), 'x'.repeat(8001)])
        expect(normalizeAskText(value)).toBeNull();
});
it('question and one answer are scoped, author-derived; removal never erases another component', async () => {
    expect(await listQuestions(db(), principal, scope)).toMatchObject({ ok: true, value: { questions: [], capacity: 100, used: 0 } });
    const { input, question } = await newQuestion();
    expect(question).toMatchObject({ authorId: principal.userId, recipientId: u2, questionState: 'active', responseState: 'waiting', version: 1 });
    expect(await createQuestion(db(), principal, input)).toMatchObject({ ok: true, value: { replay: true, question } });
    expect(await createQuestion(db(), principal, { ...input, text: 'different' })).toEqual({ ok: false, error: 'idempotency_conflict' });
    const answer = { ...command(), questionId: question.id, expectedVersion: 1, text: 'Synthetic answer' };
    expect(await answerQuestion(db(), principal, answer)).toEqual({ ok: false, error: 'unavailable' });
    const result = await answerQuestion(db(), partner, answer);
    expect(result).toMatchObject({ ok: true, value: { question: { version: 2, responseState: 'answered', answer: 'Synthetic answer', answeredAt: '2026-11-10T00:00:00.000Z' } } });
    expect(await answerQuestion(db(), partner, { ...answer, commandId: id(++n), expectedVersion: 2 })).toEqual({ ok: false, error: 'version_conflict' });
    const removal = { ...command(), questionId: question.id, expectedVersion: 2 };
    expect(await removeQuestion(db(), partner, removal)).toEqual({ ok: false, error: 'unavailable' });
    const removed = await removeQuestion(db(), principal, removal);
    expect(removed).toMatchObject({ ok: true, value: { question: { questionState: 'removed', responseState: 'answered', answer: 'Synthetic answer', version: 3 } } });
    if (!removed.ok)
        throw Error('fixture');
    expect(removed.value.question).not.toHaveProperty('question');
    expect(await createQuestion(db(), principal, input)).toMatchObject({ ok: true, value: { question: { questionState: 'removed', version: 3 }, replay: true } });
    const answerRemoval = { ...command(), questionId: question.id, expectedVersion: 3 };
    expect(await removeAnswer(db(), principal, answerRemoval)).toEqual({ ok: false, error: 'unavailable' });
    const cleared = await removeAnswer(db(), partner, answerRemoval);
    expect(cleared).toMatchObject({ ok: true, value: { question: { responseState: 'answer_removed', version: 4, answeredAt: '2026-11-10T00:00:00.000Z' } } });
    if (!cleared.ok)
        throw Error('fixture');
    expect(cleared.value.question).not.toHaveProperty('answer');
    expect(await answerQuestion(db(), partner, answer)).toMatchObject({ ok: true, value: { question: cleared.value.question, replay: true } });
    expect(await removeAnswer(db(), partner, { ...answerRemoval, commandId: id(++n), expectedVersion: 4 })).toEqual({ ok: false, error: 'version_conflict' });
    expect(await removeQuestion(db(), principal, { ...removal, commandId: id(++n), expectedVersion: 4 })).toEqual({ ok: false, error: 'version_conflict' });
    expect(JSON.stringify((await pg.query('SELECT * FROM ask_commands')).rows)).not.toMatch(/Synthetic/);
});
it('skip is terminal; waiting removal withdraws; pending first then sequence descending', async () => {
    const first = await newQuestion();
    const pending = await newQuestion();
    const skip = { ...command(), questionId: first.question.id, expectedVersion: 1 };
    expect(await skipQuestion(db(), principal, skip)).toEqual({ ok: false, error: 'unavailable' });
    expect(await skipQuestion(db(), partner, skip)).toMatchObject({ ok: true, value: { question: { responseState: 'skipped', version: 2 } } });
    expect(await skipQuestion(db(), partner, { ...skip, commandId: id(++n), expectedVersion: 2 })).toEqual({ ok: false, error: 'version_conflict' });
    expect(await removeQuestion(db(), principal, { ...command(), questionId: first.question.id, expectedVersion: 2 })).toMatchObject({ ok: true, value: { question: { responseState: 'skipped', questionState: 'removed', version: 3 } } });
    const later = await newQuestion();
    expect(await removeQuestion(db(), principal, { ...command(), questionId: later.question.id, expectedVersion: 1 })).toMatchObject({ ok: true, value: { question: { responseState: 'withdrawn', questionState: 'removed', version: 2 } } });
    expect(await answerQuestion(db(), partner, { ...command(), questionId: later.question.id, expectedVersion: 2, text: 'not allowed' })).toEqual({ ok: false, error: 'version_conflict' });
    const list = await listQuestions(db(), partner, scope);
    if (!list.ok)
        throw Error('fixture');
    expect(list.value.questions[0].id).toBe(pending.question.id);
    const activeAnswer = await newQuestion();
    const answer = { ...command(), questionId: activeAnswer.question.id, expectedVersion: 1, text: 'answer' };
    expect(await answerQuestion(db(), partner, answer)).toMatchObject({ ok: true });
    expect(await removeAnswer(db(), partner, { ...command(), questionId: activeAnswer.question.id, expectedVersion: 2 })).toMatchObject({ ok: true, value: { question: { questionState: 'active', responseState: 'answer_removed' } } });
});
it('strict input and all authorization boundaries', async () => {
    const input = { ...command(), text: 'q' };
    for (const [op, data] of [[createQuestion, input], [listQuestions, scope]] as const) {
        for (const coupleId of [c2, waiting, id(999)])
            expect(await op(db(), principal, { ...data, coupleId })).toEqual({ ok: false, error: 'unavailable' });
        for (const p of [identityPrincipal(outsider), { ...principal, userId: 'bad' }, { ...principal, tokenExpiresAt: 1 }])
            expect(await op(db(), p, data)).toEqual({ ok: false, error: 'unavailable' });
        expect(await op(db(), principal, { ...data, membershipEpoch: 2 })).toEqual({ ok: false, error: 'stale_membership' });
        for (const bad of [null, [], {}, { ...data, extra: 1 }, { ...data, coupleId: 'bad' }, { ...data, membershipEpoch: 0 }])
            expect(await op(db(), principal, bad)).toEqual({ ok: false, error: 'invalid_request' });
    }
    for (const bad of [{ ...input, commandId: 'bad' }, { ...input, text: '' }])
        expect(await createQuestion(db(), principal, bad)).toEqual({ ok: false, error: 'invalid_request' });
    for (const bad of [{ ...input, questionId: 'bad', expectedVersion: 1 }, { ...input, questionId: id(88), expectedVersion: 0 }, { ...input, questionId: id(88), expectedVersion: 2147483647 }])
        expect(await answerQuestion(db(), partner, bad)).toEqual({ ok: false, error: 'invalid_request' });
    expect(await skipQuestion(db(), partner, { ...command(), questionId: id(99999), expectedVersion: 1 })).toEqual({ ok: false, error: 'unavailable' });
    const fresh = await newQuestion();
    expect(await skipQuestion(db(), partner, { ...command(), questionId: fresh.question.id, expectedVersion: 2 })).toEqual({ ok: false, error: 'version_conflict' });
});
it('capacity includes all tombstones; at capacity recipients can still respond', async () => {
    const used = Number((await pg.query<{
        used: number;
    }>('SELECT count(*)::int AS used FROM asks')).rows[0].used);
    let last = '';
    for (let i = used; i < 100; i++) {
        last = (await newQuestion()).question.id;
    }
    expect(await createQuestion(db(), principal, { ...command(), text: 'over' })).toEqual({ ok: false, error: 'capacity_reached' });
    expect(await skipQuestion(db(), partner, { ...command(), questionId: last, expectedVersion: 1 })).toMatchObject({ ok: true });
    expect(await listQuestions(db(), principal, scope)).toMatchObject({ ok: true, value: { used: 100, capacity: 100 } });
});
it('SQL rejects identity/content edits, invalid transitions, timestamp rewrites and receipt mutations', async () => {
    const answered = (await pg.query<{
        id: string;
    }>("SELECT id FROM asks WHERE response_state='answer_removed' LIMIT 1")).rows[0].id;
    const pending = (await pg.query<{
        id: string;
    }>("SELECT id FROM asks WHERE response_state='waiting' LIMIT 1")).rows[0].id;
    for (const sql of ["UPDATE asks SET question='changed',version=version+1 WHERE id='" + pending + "'", "UPDATE asks SET answered_at=answered_at+interval '1 second',version=version+1 WHERE id='" + answered + "'", "UPDATE asks SET response_state='waiting',question_state='active',question='resurrected',answered_at=NULL,version=version+1 WHERE id='" + answered + "'", 'UPDATE asks SET version=version', 'DELETE FROM asks', 'UPDATE ask_commands SET fingerprint=fingerprint', 'DELETE FROM ask_commands'])
        await expect(pg.query(sql)).rejects.toMatchObject({ code: '23514' });
});
it('fresh read and replay recheck; final receipt expiry rolls back both components and receipts', async () => {
    const base = db();
    const intercept = (trigger: string, throws = false) => {
        let revoked = false;
        return { ...base, sessionAuthority: { ...base.sessionAuthority, recheck: async (...args: Parameters<typeof base.sessionAuthority.recheck>) => !revoked && base.sessionAuthority.recheck(...args) }, transaction: <T>(work: Parameters<typeof base.transaction<T>>[0]) => base.transaction(tx => work({ query: async <R>(sql: string, params?: unknown[]) => {
                    const result = await tx.query<R>(sql, params);
                    if (sql.includes(trigger)) {
                        if (throws)
                            throw Error('unexpected');
                        revoked = true;
                    }
                    return result;
                } })) };
    };
    expect(await listQuestions(intercept('ORDER BY'), principal, scope)).toEqual({ ok: false, error: 'unavailable' });
    const other = identityPrincipal(id(3)), input = { coupleId: c2, membershipEpoch: 1, commandId: id(++n), text: 'other' };
    expect(await createQuestion(intercept('AS used FROM asks'), other, input)).toEqual({ ok: false, error: 'unavailable' });
    expect(await createQuestion(intercept('INSERT INTO ask_commands'), other, input)).toEqual({ ok: false, error: 'unavailable' });
    expect((await pg.query('SELECT id FROM asks WHERE couple_id=$1', [c2])).rows).toHaveLength(0);
    await expect(createQuestion(intercept('INSERT INTO ask_commands', true), other, input)).rejects.toThrow('unexpected');
    const saved = await createQuestion(base, other, input);
    if (!saved.ok)
        throw Error('fixture');
    expect(await createQuestion(intercept('AND id=$3 FOR UPDATE'), other, input)).toEqual({ ok: false, error: 'unavailable' });
    expect(await removeQuestion(intercept('AND id=$3 FOR UPDATE'), other, { coupleId: c2, membershipEpoch: 1, commandId: id(++n), questionId: saved.value.question.id, expectedVersion: 1 })).toEqual({ ok: false, error: 'unavailable' });
});
it('SQL text constraints reject malformed shapes without relaxing component guards', async () => {
    for (const text of ['', 'x'.repeat(2001), 'e\u0301', ' q', 'q\t', '\u0080']) {
        await expect(pg.query(`INSERT INTO asks(couple_id,author_id,recipient_id,membership_epoch,sequence,version,created_at,question_state,response_state,question)
      VALUES($1,$2,$3,1,2,1,'2026-11-10Z','active','waiting',$4)`, [c2, id(3), id(4), text])).rejects.toMatchObject({ code: '23514' });
    }
});
it('answer timestamp is logical monotonic across application clock rollback; invalid clocks cannot persist', async () => {
    const other = identityPrincipal(id(3)), recipient = identityPrincipal(id(4));
    const scope = { coupleId: c2, membershipEpoch: 1 };
    const create = { ...scope, commandId: id(++n), text: 'clock question' };
    await expect(createQuestion({ ...db(), now: () => new Date(NaN) }, other, create)).rejects.toThrow('invalid_server_clock');
    const saved = await createQuestion(db(), other, create);
    if (!saved.ok)
        throw Error('fixture');
    const answer = { ...scope, commandId: id(++n), questionId: saved.value.question.id, expectedVersion: 1, text: 'clock answer' };
    await expect(answerQuestion({ ...db(), now: () => new Date(NaN) }, recipient, answer)).rejects.toThrow('invalid_server_clock');
    const rolled = { ...db(), now: () => new Date('2026-01-01T00:00:00Z') };
    const result = await answerQuestion(rolled, recipient, answer);
    expect(result).toMatchObject({ ok: true, value: { question: { answeredAt: saved.value.question.createdAt, responseState: 'answered' } } });
    expect(await answerQuestion(rolled, recipient, answer)).toMatchObject({ ok: true, value: { replay: true, question: { answeredAt: saved.value.question.createdAt } } });
    expect(await listQuestions(db(), other, scope)).toMatchObject({ ok: true, value: { questions: expect.arrayContaining([expect.objectContaining({ id: saved.value.question.id, answeredAt: saved.value.question.createdAt })]) } });
    await expect(pg.query("UPDATE asks SET answered_at=created_at-interval '1 second',version=version+1 WHERE id=$1", [saved.value.question.id])).rejects.toMatchObject({ code: '23514' });
});
