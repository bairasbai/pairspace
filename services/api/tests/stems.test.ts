import { readFile } from 'node:fs/promises';
import { beforeAll, afterAll, it, expect } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { normalizeStemText } from '../../../packages/domain/stems/text.ts';
import { createStem, completeStem, skipStem, removeAuthorBundle, removeRecipientContinuation, listStems } from '../src/stems.ts';
import { adapter, c1, c2, createFixture, id, identityPrincipal, outsider, principal, u2, waiting } from './fixtures.ts';
let pg: PGlite, n = 100000;
const scope = { coupleId: c1, membershipEpoch: 1 }, partner = identityPrincipal(u2);
const command = () => ({ ...scope, commandId: id(++n) }), db = () => adapter(pg);
beforeAll(async () => { pg = await createFixture(); await pg.exec("CREATE FUNCTION immutable_shared_date() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'immutable' USING ERRCODE='23514'; END $$;"); await pg.exec(await readFile(new URL('../migrations/039_stems.sql', import.meta.url), 'utf8')); });
afterAll(async () => pg.close());
const start = async () => { const input = { ...command(), beginning: 'Synthetic beginning', ownContinuation: 'Private continuation' }; const result = await createStem(db(), principal, input); if (!result.ok)
    throw Error('fixture'); return { input, round: result.value.round }; };
const trace = () => { const sqls: string[] = [], base = db(); return { sqls, db: { ...base, transaction: <T>(work: Parameters<typeof base.transaction<T>>[0]) => base.transaction(tx => work({ query: <R>(sql: string, params?: unknown[]) => { sqls.push(sql); return tx.query<R>(sql, params); } })) } }; };
const noPrivateSelect = (sqls: string[]) => expect(sqls.filter(s => s.startsWith('SELECT') && /\bauthor_continuation\b/.test(s))).toEqual([]);
it('normalizes bounded paragraphs, rejects unsafe/empty input', () => {
    expect(normalizeStemText(' e\u0301\r\nline ', 'beginning')).toBe('é\nline');
    expect(normalizeStemText('😀'.repeat(500), 'beginning')).not.toBeNull();
    expect(normalizeStemText('😀'.repeat(2000), 'continuation')).not.toBeNull();
    for (const value of [undefined, null, 0, '', ' ', '\ud800', '\udfff', '\tq', 'q\t', '\0', '\u0080', 'x'.repeat(8001)])
        expect(normalizeStemText(value, 'continuation')).toBeNull();
    expect(normalizeStemText('x'.repeat(501), 'beginning')).toBeNull();
    expect(normalizeStemText('x'.repeat(2001), 'continuation')).toBeNull();
});
it('recipient waiting/skip/conflict/replay never SELECT private continuation; author still reads own', async () => {
    const { input, round } = await start();
    expect(round).toMatchObject({ phase: 'waiting', version: 1, authorContinuation: 'Private continuation' });
    const t = trace();
    const listed = await listStems(t.db, partner, scope);
    if (!listed.ok)
        throw Error('fixture');
    expect(listed.value.rounds[0]).not.toHaveProperty('authorContinuation');
    noPrivateSelect(t.sqls);
    const skip = { ...command(), roundId: round.id, expectedVersion: 1 };
    const conflictTrace = trace();
    expect(await skipStem(conflictTrace.db, partner, { ...skip, expectedVersion: 2 })).toMatchObject({ ok: false, error: 'version_conflict', current: { phase: 'waiting' } });
    noPrivateSelect(conflictTrace.sqls);
    const skipTrace = trace();
    const skipped = await skipStem(skipTrace.db, partner, skip);
    expect(skipped).toMatchObject({ ok: true, value: { round: { phase: 'skipped', version: 2 } } });
    expect(JSON.stringify(skipped)).not.toContain('Private continuation');
    noPrivateSelect(skipTrace.sqls);
    const replayTrace = trace();
    expect(await skipStem(replayTrace.db, partner, skip)).toMatchObject({ ok: true, value: { replay: true } });
    noPrivateSelect(replayTrace.sqls);
    expect(await createStem(db(), principal, input)).toMatchObject({ ok: true, value: { round: { phase: 'skipped', authorContinuation: 'Private continuation' } } });
    const removed = await removeAuthorBundle(db(), principal, { ...command(), roundId: round.id, expectedVersion: 2 });
    expect(removed).toMatchObject({ ok: true, value: { round: { phase: 'skipped', authorTextState: 'removed', version: 3 } } });
    expect(JSON.stringify(removed)).not.toContain('Private continuation');
    expect(await completeStem(db(), partner, { ...command(), roundId: round.id, expectedVersion: 3, continuation: 'later' })).toMatchObject({ ok: false, error: 'version_conflict' });
});
it('completion reveals both once; independent removals preserve partner text and logical timestamp', async () => {
    const { input, round } = await start();
    const complete = { ...command(), roundId: round.id, expectedVersion: 1, continuation: 'Partner continuation' };
    expect(await completeStem(db(), principal, complete)).toEqual({ ok: false, error: 'unavailable' });
    const invalid = trace();
    expect(await completeStem(invalid.db, partner, { ...complete, continuation: '' })).toEqual({ ok: false, error: 'invalid_request' });
    expect(invalid.sqls).toHaveLength(0);
    const saved = await completeStem({ ...db(), now: () => new Date('2026-01-02') }, partner, complete);
    expect(saved).toMatchObject({ ok: true, value: { round: { phase: 'completed', version: 2, authorContinuation: 'Private continuation', recipientContinuation: 'Partner continuation', completedAt: round.createdAt } } });
    const stale = await completeStem(db(), partner, { ...complete, commandId: id(++n) });
    expect(stale).toMatchObject({ ok: false, error: 'version_conflict', current: { phase: 'completed', authorContinuation: 'Private continuation' } });
    expect(await removeRecipientContinuation(db(), principal, { ...command(), roundId: round.id, expectedVersion: 2 })).toEqual({ ok: false, error: 'unavailable' });
    const authorRemoved = await removeAuthorBundle(db(), principal, { ...command(), roundId: round.id, expectedVersion: 2 });
    expect(authorRemoved).toMatchObject({ ok: true, value: { round: { phase: 'completed', version: 3, recipientContinuation: 'Partner continuation' } } });
    if (!authorRemoved.ok)
        throw Error('fixture');
    expect(authorRemoved.value.round).not.toHaveProperty('beginning');
    expect(authorRemoved.value.round).not.toHaveProperty('authorContinuation');
    const bothRemoved = await removeRecipientContinuation(db(), partner, { ...command(), roundId: round.id, expectedVersion: 3 });
    expect(bothRemoved).toMatchObject({ ok: true, value: { round: { version: 4, recipientTextState: 'removed', completedAt: round.createdAt } } });
    expect(await completeStem(db(), partner, complete)).toMatchObject({ ok: true, value: { round: { version: 4 }, replay: true } });
    expect(await createStem(db(), principal, input)).toMatchObject({ ok: true, value: { round: { version: 4 }, replay: true } });
    const reverse = await start();
    await completeStem(db(), partner, { ...command(), roundId: reverse.round.id, expectedVersion: 1, continuation: 'other' });
    expect(await removeRecipientContinuation(db(), partner, { ...command(), roundId: reverse.round.id, expectedVersion: 2 })).toMatchObject({ ok: true, value: { round: { authorContinuation: 'Private continuation', recipientTextState: 'removed', version: 3 } } });
    expect(await removeAuthorBundle(db(), principal, { ...command(), roundId: reverse.round.id, expectedVersion: 3 })).toMatchObject({ ok: true, value: { round: { version: 4 } } });
});
it('withdrawal cannot be interpreted as skip or reopen; scope and input strict', async () => {
    const { input, round } = await start();
    const action = { ...command(), roundId: round.id, expectedVersion: 1 };
    expect(await removeAuthorBundle(db(), partner, action)).toEqual({ ok: false, error: 'unavailable' });
    expect(await removeAuthorBundle(db(), principal, action)).toMatchObject({ ok: true, value: { round: { phase: 'withdrawn', version: 2 } } });
    expect(await removeAuthorBundle(db(), principal, { ...action, commandId: id(++n), expectedVersion: 2 })).toMatchObject({ ok: false, error: 'version_conflict' });
    expect(await createStem(db(), principal, { ...input, beginning: 'different' })).toEqual({ ok: false, error: 'idempotency_conflict' });
    for (const bad of [null, [], {}, { ...input, extra: 1 }, { ...input, coupleId: 'bad' }, { ...input, membershipEpoch: 0 }, { ...input, commandId: 'bad' }, { ...input, beginning: '' }, { ...input, ownContinuation: '' }])
        expect(await createStem(db(), principal, bad)).toEqual({ ok: false, error: 'invalid_request' });
    for (const bad of [{ ...action, roundId: 'bad' }, { ...action, expectedVersion: 0 }, { ...action, expectedVersion: 5 }])
        expect(await skipStem(db(), partner, bad)).toEqual({ ok: false, error: 'invalid_request' });
    for (const [op, data] of [[createStem, input], [listStems, scope]] as const) {
        for (const coupleId of [c2, waiting, id(999)])
            expect(await op(db(), principal, { ...data, coupleId })).toEqual({ ok: false, error: 'unavailable' });
        for (const p of [identityPrincipal(outsider), { ...principal, userId: 'bad' }, { ...principal, tokenExpiresAt: 1 }])
            expect(await op(db(), p, data)).toEqual({ ok: false, error: 'unavailable' });
        expect(await op(db(), principal, { ...data, membershipEpoch: 2 })).toEqual({ ok: false, error: 'stale_membership' });
    }
    expect(await listStems(db(), principal, input)).toEqual({ ok: false, error: 'invalid_request' });
    expect(await skipStem(db(), partner, { ...action, roundId: id(999) })).toEqual({ ok: false, error: 'unavailable' });
});
it('post-wait auth failure rolls back commit and receipt before any mutual projection', async () => {
    const { round } = await start(), base = db();
    const complete = { ...command(), roundId: round.id, expectedVersion: 1, continuation: 'not retained' };
    const intercept = (trigger: string, throws = false) => { let revoked = false; const queries: string[] = []; return { queries, db: { ...base, sessionAuthority: { ...base.sessionAuthority, recheck: async (...args: Parameters<typeof base.sessionAuthority.recheck>) => !revoked && base.sessionAuthority.recheck(...args) }, transaction: <T>(work: Parameters<typeof base.transaction<T>>[0]) => base.transaction(tx => work({ query: async <R>(sql: string, params?: unknown[]) => { queries.push(sql); const result = await tx.query<R>(sql, params); if (sql.includes(trigger)) {
                    if (throws)
                        throw Error('unexpected');
                    revoked = true;
                } return result; } })) } }; };
    const expiry = intercept('INSERT INTO stem_commands');
    expect(await completeStem(expiry.db, partner, complete)).toEqual({ ok: false, error: 'unavailable' });
    noPrivateSelect(expiry.queries);
    expect((await pg.query('SELECT recipient_continuation,phase FROM stems WHERE id=$1', [round.id])).rows).toEqual([{ recipient_continuation: null, phase: 'waiting' }]);
    expect((await pg.query('SELECT command_id FROM stem_commands WHERE command_id=$1', [complete.commandId])).rows).toHaveLength(0);
    await expect(completeStem(intercept('INSERT INTO stem_commands', true).db, partner, complete)).rejects.toThrow('unexpected');
    await expect(completeStem({ ...base, now: () => new Date(NaN) }, partner, complete)).rejects.toThrow('invalid_server_clock');
    expect(await listStems(intercept('ORDER BY').db, partner, scope)).toEqual({ ok: false, error: 'unavailable' });
    const afterBody = intercept('SELECT beginning FROM');
    expect(await listStems(afterBody.db, partner, scope)).toEqual({ ok: false, error: 'unavailable' });
    expect(await completeStem(db(), partner, complete)).toMatchObject({ ok: true });
    expect(await completeStem(intercept('AND id=$3 FOR UPDATE').db, partner, complete)).toEqual({ ok: false, error: 'unavailable' });
    expect(await completeStem(intercept('SELECT beginning,author_continuation').db, partner, complete)).toEqual({ ok: false, error: 'unavailable' });
});
it('exact state SQL guards and per-pair capacity include all removed rows', async () => {
    const used = Number((await pg.query<{
        used: number;
    }>('SELECT count(*)::int AS used FROM stems')).rows[0].used);
    let last = '';
    for (let i = used; i < 100; i++)
        last = (await start()).round.id;
    expect(await createStem(db(), principal, { ...command(), beginning: 'over', ownContinuation: 'over' })).toEqual({ ok: false, error: 'capacity_reached' });
    expect(await skipStem(db(), partner, { ...command(), roundId: last, expectedVersion: 1 })).toMatchObject({ ok: true });
    const list = await listStems(db(), partner, scope);
    if (!list.ok)
        throw Error('fixture');
    expect(list.value.used).toBe(100);
    expect(list.value.rounds).toHaveLength(100);
    for (const sql of ['DELETE FROM stems', 'UPDATE stems SET version=version', "UPDATE stems SET author_continuation='edited',version=version+1 WHERE phase='waiting'", "UPDATE stems SET phase='completed',version=2,recipient_text_state='active',recipient_continuation='leak',completed_at=created_at WHERE phase='skipped'", 'UPDATE stem_commands SET fingerprint=fingerprint', 'DELETE FROM stem_commands'])
        await expect(pg.query(sql)).rejects.toMatchObject({ code: '23514' });
});
it('worst maximum code-point response stays beneath the explicit 2MiB transport bound', () => {
    const round = { id: id(1), coupleId: c1, authorId: principal.userId, recipientId: u2, membershipEpoch: 2147483647, sequence: 100, version: 2, createdAt: '2100-12-31T23:59:59.999Z', completedAt: '2100-12-31T23:59:59.999Z', phase: 'completed', authorTextState: 'active', recipientTextState: 'active', beginning: '😀'.repeat(500), authorContinuation: '😀'.repeat(2000), recipientContinuation: '😀'.repeat(2000) };
    const payload = { ok: true, value: { rounds: Array.from({ length: 100 }, () => round), used: 100, capacity: 100, checkedAt: round.createdAt } };
    expect(Buffer.byteLength(JSON.stringify(payload), 'utf8')).toBeLessThan(2 * 1024 * 1024);
});
