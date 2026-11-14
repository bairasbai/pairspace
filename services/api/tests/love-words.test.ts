import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { normalizeWordText } from '../../../packages/domain/words/text.ts';
import { createLoveWord, editLoveWord, deleteLoveWord, listLoveWords } from '../src/love-words.ts';
import { adapter, c1, c2, createFixture, id, identityPrincipal, outsider, principal, u2, waiting } from './fixtures.ts';
let pg: PGlite;
const scope = { coupleId: c1, membershipEpoch: 1 };
const create = { ...scope, commandId: id(9001), word: '  Synthetic e\u0301\n word ', meaning: ' meaning\r\nline ', saidWhen: '' };
const db = () => adapter(pg);
beforeAll(async () => {
    pg = await createFixture();
    await pg.exec('CREATE FUNCTION immutable_shared_date() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION \'immutable\' USING ERRCODE=\'23514\'; END $$;');
    await pg.exec(await readFile(new URL('../migrations/036_love_words.sql', import.meta.url), 'utf8'));
});
afterAll(async () => pg.close());
it('normalizes optional text and Unicode bounded by code points, rejects malformed/control input', () => {
    expect(normalizeWordText(undefined, 'optional')).toBe('');
    expect(normalizeWordText(' e\u0301\r\nline ', 'optional')).toBe('é\nline');
    expect(normalizeWordText(' a\t\nb ', 'word')).toBe('a b');
    expect(normalizeWordText('😀'.repeat(120), 'word')).not.toBeNull();
    expect(normalizeWordText('😀'.repeat(1000), 'optional')).not.toBeNull();
    for (const input of [null, 3, '\ud800', '\udfff', '\0', '\u0080', 'x'.repeat(4001)])
        expect(normalizeWordText(input, 'optional')).toBeNull();
    for (const input of ['', ' ', '😀'.repeat(121)])
        expect(normalizeWordText(input, 'word')).toBeNull();
    for (const input of ['x\ty', 'x'.repeat(1001)])
        expect(normalizeWordText(input, 'optional')).toBeNull();
});
it('creates shared words, current canonical retries, no-op and authored deletion with no plaintext receipt', async () => {
    expect(await listLoveWords(db(), principal, scope)).toMatchObject({ ok: true, value: { words: [], used: 0, capacity: 100 } });
    const result = await createLoveWord(db(), principal, create);
    expect(result).toMatchObject({ ok: true, value: { replay: false, word: { word: 'Synthetic é word', meaning: 'meaning\nline', state: 'active', version: 1, edited: false } } });
    if (!result.ok)
        throw Error('fixture');
    const wordId = result.value.word.id;
    expect(await listLoveWords(db(), identityPrincipal(u2), scope)).toMatchObject({ ok: true, value: { words: [result.value.word], used: 1 } });
    expect(await createLoveWord(db(), principal, create)).toMatchObject({ ok: true, value: { replay: true } });
    expect(await createLoveWord(db(), principal, { ...create, word: 'Changed' })).toEqual({ ok: false, error: 'idempotency_conflict' });
    const edit = { ...create, wordId, commandId: id(9002), expectedVersion: 1 };
    expect(await editLoveWord(db(), principal, edit)).toMatchObject({ ok: true, value: { word: { version: 1, edited: false } } });
    expect(await editLoveWord(db(), identityPrincipal(u2), edit)).toEqual({ ok: false, error: 'unavailable' });
    expect(await editLoveWord(db(), principal, { ...edit, commandId: id(9003), word: 'Changed' })).toMatchObject({ ok: true, value: { word: { version: 2, edited: true } } });
    expect(await editLoveWord(db(), principal, { ...edit, commandId: id(9004) })).toEqual({ ok: false, error: 'version_conflict' });
    expect(await createLoveWord(db(), principal, create)).toMatchObject({ ok: true, value: { word: { word: 'Changed', version: 2 }, replay: true } });
    const removal = { ...scope, wordId, commandId: id(9005), expectedVersion: 2 };
    expect(await deleteLoveWord(db(), identityPrincipal(u2), removal)).toEqual({ ok: false, error: 'unavailable' });
    const deleted = await deleteLoveWord(db(), principal, removal);
    expect(deleted).toMatchObject({ ok: true, value: { word: { state: 'deleted', version: 3 } } });
    expect(JSON.stringify(deleted)).not.toMatch(/Changed|meaning|saidWhen|edited/);
    expect(await deleteLoveWord(db(), principal, removal)).toMatchObject({ ok: true, value: { replay: true } });
    expect(await createLoveWord(db(), principal, create)).toMatchObject({ ok: true, value: { word: { state: 'deleted' } } });
    expect(await editLoveWord(db(), principal, { ...edit, commandId: id(9006), expectedVersion: 3 })).toEqual({ ok: false, error: 'version_conflict' });
    expect((await pg.query('SELECT word,meaning,said_when,edited FROM love_words WHERE id=$1', [wordId])).rows).toEqual([{ word: null, meaning: null, said_when: null, edited: null }]);
    expect(JSON.stringify((await pg.query('SELECT * FROM love_word_commands')).rows)).not.toMatch(/Synthetic|Changed|meaning/);
    expect(await editLoveWord(db(), principal, { ...edit, wordId: id(9999), commandId: id(9099) })).toEqual({ ok: false, error: 'unavailable' });
});
it('scope/auth/shape guards apply to list, mutation and replay', async () => {
    for (const [op, input] of [[createLoveWord, create], [listLoveWords, scope]] as const) {
        for (const coupleId of [c2, waiting, id(999)])
            expect(await op(db(), principal, { ...input, coupleId })).toEqual({ ok: false, error: 'unavailable' });
        expect(await op(db(), identityPrincipal(outsider), input)).toEqual({ ok: false, error: 'unavailable' });
        expect(await op(db(), { ...principal, userId: 'bad' }, input)).toEqual({ ok: false, error: 'unavailable' });
        expect(await op(db(), { ...principal, tokenExpiresAt: 1 }, input)).toEqual({ ok: false, error: 'unavailable' });
        expect(await op(db(), principal, { ...input, membershipEpoch: 2 })).toEqual({ ok: false, error: 'stale_membership' });
        for (const bad of [null, [], {}, { ...input, extra: 1 }, { ...input, coupleId: 'bad' }, { ...input, membershipEpoch: 0 }])
            expect(await op(db(), principal, bad)).toEqual({ ok: false, error: 'invalid_request' });
    }
    for (const bad of [{ ...create, commandId: 'bad' }, { ...create, word: '' }, { ...create, meaning: null }, { ...create, saidWhen: 3 }])
        expect(await createLoveWord(db(), principal, bad)).toEqual({ ok: false, error: 'invalid_request' });
    for (const bad of [{ ...create, wordId: 'bad', expectedVersion: 1 }, { ...create, wordId: id(5), expectedVersion: 0 }, { ...create, wordId: id(5), expectedVersion: 2147483647 }])
        expect(await editLoveWord(db(), principal, bad)).toEqual({ ok: false, error: 'invalid_request' });
});
it('capacity includes tombstones; duplicate words allowed; edit remains possible at capacity', async () => {
    let last = '';
    for (let n = 2; n <= 100; n++) {
        const result = await createLoveWord(db(), principal, { ...scope, commandId: id(10000 + n), word: 'same' });
        if (!result.ok)
            throw Error('fixture');
        last = result.value.word.id;
    }
    expect(await createLoveWord(db(), principal, { ...scope, commandId: id(10200), word: 'over' })).toEqual({ ok: false, error: 'capacity_reached' });
    expect(await editLoveWord(db(), principal, { ...scope, commandId: id(10201), wordId: last, expectedVersion: 1, word: 'edited' })).toMatchObject({ ok: true });
    const list = await listLoveWords(db(), principal, scope);
    expect(list).toMatchObject({ ok: true, value: { used: 100, capacity: 100 } });
    if (list.ok) {
        expect(list.value.words).toHaveLength(100);
        expect(list.value.words[0].sequence).toBe(100);
        expect(list.value.words[99].state).toBe('deleted');
    }
});
it('SQL protects identity, terminal bodies and immutable receipts', async () => {
    for (const sql of ["UPDATE love_words SET word='revived' WHERE state='deleted'", 'DELETE FROM love_words', 'UPDATE love_words SET version=version', 'UPDATE love_word_commands SET fingerprint=fingerprint', 'DELETE FROM love_word_commands'])
        await expect(pg.query(sql)).rejects.toMatchObject({ code: '23514' });
});
it('rechecks after reads and receipts, rolls back on final auth failure, preserves unexpected errors', async () => {
    const base = db();
    const intercept = (trigger: string, action: 'revoke' | 'throw' = 'revoke') => {
        let revoked = false;
        return { ...base, sessionAuthority: { ...base.sessionAuthority, recheck: async (...args: Parameters<typeof base.sessionAuthority.recheck>) => !revoked && base.sessionAuthority.recheck(...args) },
            transaction: <T>(work: Parameters<typeof base.transaction<T>>[0]) => base.transaction(tx => work({ query: async <R>(sql: string, params?: unknown[]) => {
                    const result = await tx.query<R>(sql, params);
                    if (sql.includes(trigger)) {
                        if (action === 'throw')
                            throw Error('unexpected_database_failure');
                        revoked = true;
                    }
                    return result;
                } })) };
    };
    expect(await listLoveWords(intercept('ORDER BY sequence DESC'), principal, scope)).toEqual({ ok: false, error: 'unavailable' });
    expect(await createLoveWord(intercept('AND id=$3 FOR UPDATE'), principal, create)).toEqual({ ok: false, error: 'unavailable' });
    // Partner writes against the second pair avoid the full synthetic lifetime cap.
    const second = { coupleId: c2, membershipEpoch: 1, commandId: id(11001), word: 'second' };
    const other = identityPrincipal(id(3));
    expect(await createLoveWord(intercept('AS used FROM love_words'), other, second)).toEqual({ ok: false, error: 'unavailable' });
    expect(await createLoveWord(intercept('INSERT INTO love_word_commands'), other, second)).toEqual({ ok: false, error: 'unavailable' });
    expect((await pg.query('SELECT id FROM love_words WHERE couple_id=$1', [c2])).rows).toHaveLength(0);
    expect((await pg.query('SELECT command_id FROM love_word_commands WHERE couple_id=$1', [c2])).rows).toHaveLength(0);
    await expect(createLoveWord(intercept('INSERT INTO love_word_commands', 'throw'), other, second)).rejects.toThrow('unexpected_database_failure');
    const success = await createLoveWord(base, other, second);
    if (!success.ok)
        throw Error('fixture');
    expect(await editLoveWord(intercept('AND id=$3 FOR UPDATE'), other, { ...second, commandId: id(11002), wordId: success.value.word.id, expectedVersion: 1 })).toEqual({ ok: false, error: 'unavailable' });
});
