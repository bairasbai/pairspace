import { draftValue, pendingValue, rowValue, scopeKey, snapshotValue, utf8Bytes } from '../src/chat/journal/validation';
import { journalFixture, journalScope } from './journal-fixture';
import { createJournal } from '../src/chat/journal/engine';
it('validates canonical shapes and UTF8 bounds without trimming or truncation', () => {
    expect(utf8Bytes('aéБашҡорт🙂\n')).toBeGreaterThan('aéБашҡорт🙂\n'.length);
    for (const input of [null, [], {}, { revision: -1, text: 'a' }, { revision: 0, text: 'a', replyToId: '' }, { revision: 0, text: 1 }, { revision: 0, text: ' '.repeat(8001) }])
        expect(() => draftValue(input)).toThrow('invalid');
    for (const input of [{ clientId: '', body: 'x', draftRevision: 0 }, { clientId: 'x', body: 'x', draftRevision: 0, replyToId: '' }, { clientId: 'x', body: 'x', draftRevision: -1 }])
        expect(() => pendingValue(input)).toThrow('invalid');
    expect(() => snapshotValue({})).toThrow('corrupt');
    expect(() => snapshotValue({ draft: { revision: 0, text: 'bad\u0000' }, pending: null })).toThrow('corrupt');
    expect(() => snapshotValue({ draft: { revision: 0, text: 'line\r\n' }, pending: null })).toThrow('corrupt');
    expect(() => rowValue({})).toThrow('corrupt');
    expect(scopeKey({ ...journalScope, origin: 'http://localhost:3000' })).toContain('localhost');
    expect(() => scopeKey({ ...journalScope, origin: 'ftp://pair.example.test' })).toThrow('invalid');
});
it('retains multilingual >2048-byte text and a newer draft when preparing older captured send', async () => {
    const f = journalFixture(), j = f.engine(), bound = await j.bindVerifiedScope(journalScope);
    if (!bound.ok)
        throw Error('bind');
    const t = bound.value;
    const body = ('Башҡортса Русский English🙂\n').repeat(130);
    expect(utf8Bytes(body)).toBeGreaterThan(2048);
    expect(await j.saveDraft(t, { revision: 5, text: body })).toEqual({ ok: true, value: null });
    expect(await j.saveDraft(t, { revision: 6, text: 'New draft' })).toEqual({ ok: true, value: null });
    expect(await j.prepareSend(t, { clientId: 'id-5', body, draftRevision: 5 })).toEqual({ ok: true, value: null });
    expect(await j.restore(t)).toEqual({ ok: true, value: { draft: { revision: 6, text: 'New draft' }, pending: { clientId: 'id-5', body, draftRevision: 5 } } });
    expect(JSON.stringify(f.row)).not.toContain('Русский');
    expect(JSON.stringify(f.key)).not.toContain('Русский');
    expect(await j.settlePending(t, 'id-5', 4)).toEqual({ ok: false, error: 'conflict' });
    expect(await j.settlePending(t, 'id-5', 5)).toEqual({ ok: true, value: null });
});
it('explicit reset can repair corrupt metadata, while bind and retire never silently overwrite it', async () => {
    const f = journalFixture(), j = f.engine(), bound = await j.bindVerifiedScope(journalScope);
    if (!bound.ok)
        throw Error('bind');
    const original = f.row!;
    for (const corrupted of [{ ...original, scope: null, hasDraft: true }, { ...original, hasDraft: true }, { ...original, sealed: { data: 'not base64' } }]) {
        f.row = corrupted;
        expect(await j.bindVerifiedScope(journalScope)).toEqual({ ok: false, error: 'corrupt' });
        expect(() => rowValue(corrupted)).toThrow('corrupt');
    }
    expect(await j.retire(bound.value)).toEqual({ ok: false, error: 'corrupt' });
    expect(await j.reset()).toEqual({ ok: true, value: null });
    expect(f.key).toBeNull();
    expect(f.row?.scope).toBeNull();
});
it('authenticated but oversized or inconsistent decoded records fail closed; invalid generated identities never bind', async () => {
    const f = journalFixture(), initial = f.engine(), first = await initial.bindVerifiedScope(journalScope);
    if (!first.ok)
        throw Error('bind');
    await initial.saveDraft(first.value, { revision: 0, text: 'Existing' });
    for (const plaintext of ['x'.repeat(110001), JSON.stringify({ draft: null, pending: null }), JSON.stringify({ draft: { revision: 9, text: 'Wrong revision' }, pending: null })]) {
        const j = createJournal({ store: f.store, keys: f.keys, cipher: { ...f.cipher, open: async () => plaintext }, randomId: () => 'other' });
        const bound = await j.bindVerifiedScope(journalScope);
        if (!bound.ok)
            throw Error('bind');
        expect(await j.restore(bound.value)).toEqual({ ok: false, error: 'corrupt' });
    }
    const empty = journalFixture();
    expect(await createJournal({ ...empty, randomId: () => '' }).bindVerifiedScope(journalScope)).toEqual({ ok: false, error: 'invalid' });
    const wrong = createJournal({ ...empty, keys: { ...empty.keys, create: async () => ({ installationId: 'wrong', secret: 'opaque' }) }, randomId: () => 'expected' });
    expect(await wrong.bindVerifiedScope(journalScope)).toEqual({ ok: false, error: 'locked' });
});
