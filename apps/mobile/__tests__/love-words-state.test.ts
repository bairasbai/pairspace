import { parseWordFields, validWord, follows, exact } from '../src/auth/love-words-state';
import { word, deleted, context, uuid } from './love-words-fixtures';
it('normalizes required and optional unicode text', () => {
    expect(parseWordFields({ word: '  e\u0301  sun ', meaning: ' x ', saidWhen: '' })).toEqual({ word: 'é sun', meaning: 'x', saidWhen: '' });
    for (const fields of [{ word: '', meaning: '', saidWhen: '' }, { word: 'a', meaning: 'a'.repeat(1001), saidWhen: '' }, { word: 'a', meaning: '', saidWhen: '\u0000' }])
        expect(parseWordFields(fields)).toBeNull();
});
it('strict union identity/version/text and metadata validation', () => {
    expect(validWord(word, context)).toBe(true);
    expect(validWord(deleted, context)).toBe(true);
    for (const value of [null, {}, { ...word, state: 'other' }, { ...word, extra: true }, { ...word, id: 'bad' }, { ...word, authorId: 'bad' },
        { ...word, coupleId: uuid(8) }, { ...word, membershipEpoch: 2 }, { ...word, createdAt: 'bad' }, { ...word, version: 0 }, { ...word, version: 2147483648 },
        { ...word, sequence: 0 }, { ...word, sequence: 101 }, { ...word, word: 3 }, { ...word, meaning: 3 }, { ...word, saidWhen: 3 }, { ...word, edited: 3 },
        { ...word, word: ' Sun ' }, { ...word, meaning: ' Warmth ' }, { ...word, saidWhen: ' Morning ' }, { ...word, word: '' }, { ...word, edited: true },
        { ...deleted, version: 1 }, { ...deleted, word: 'not allowed' }])
        expect(validWord(value, context)).toBe(false);
    expect(validWord(word, { state: 'unmapped', sessionId: 'session' })).toBe(false);
    expect(exact({ b: 1, a: 2 }, 'a,b')).toBe(true);
});
it('monotonic immutable identity and tombstone fences', () => {
    expect(follows(word, { ...word })).toBe(true);
    expect(follows(word, deleted)).toBe(true);
    expect(follows(deleted, word)).toBe(false);
    expect(follows(word, { ...word, version: 2, edited: true })).toBe(true);
    expect(follows(word, { ...word, id: uuid(8) })).toBe(false);
    expect(follows(word, { ...word, state: 'active', word: 'changed' })).toBe(false);
});
