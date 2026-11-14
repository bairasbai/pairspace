import { createSQLiteJournalStore, type JournalSQLite } from '../src/chat/journal/sqlite-store';
import type { JournalRow } from '../src/chat/journal/types';
import { latch } from './journal-fixture';
const row: JournalRow = { installationId: 'install-1', generation: 1, lease: 1, scope: 'scope', revision: 0, draftRevision: -1, pendingFloor: -1, hasDraft: false, hasPending: false, sealed: null };
function sqlite() {
    const calls: string[] = [];
    let envelope: string | null = null, fail = '';
    const db: JournalSQLite = {
        async execAsync(sql) { calls.push(sql); if (fail && sql.includes(fail))
            throw Error('synthetic_sql'); },
        async getFirstAsync<T>(sql: string): Promise<T | null> {
            calls.push(sql);
            let value: unknown;
            if (sql === 'PRAGMA journal_mode')
                value = { journal_mode: 'wal' };
            else if (sql === 'PRAGMA synchronous')
                value = { synchronous: 2 };
            else if (sql === 'PRAGMA foreign_keys')
                value = { foreign_keys: 1 };
            else
                value = envelope === null ? null : { envelope };
            return value as T | null;
        },
        async runAsync(sql, value) { calls.push(sql); envelope = value; },
        async closeAsync() { calls.push('CLOSE'); },
    };
    return { db, calls, get envelope() { return envelope; }, set envelope(value) { envelope = value; }, set fail(value: string) { fail = value; } };
}
it('uses private configured connection and serial BEGIN IMMEDIATE transactions with bound ciphertext JSON', async () => {
    const f = sqlite(), store = await createSQLiteJournalStore(async () => f.db), gate = latch();
    const first = store.transaction(async (tx) => { expect(await tx.read()).toBeNull(); await tx.write(row); gate.arrive(); await gate.gate; return 'one'; });
    await gate.reached;
    const second = store.transaction(async (tx) => { expect(await tx.read()).toEqual(row); return 'two'; });
    expect(f.calls.filter(s => s === 'BEGIN IMMEDIATE')).toHaveLength(1);
    gate.release();
    expect(await first).toBe('one');
    expect(await second).toBe('two');
    expect(f.calls.filter(s => s === 'COMMIT')).toHaveLength(2);
    expect(f.envelope).toBe(JSON.stringify(row));
    expect(f.calls.some(s => s.includes('VALUES(1,?)'))).toBe(true);
});
it('fails closed on non-durable configuration, corrupted rows and commit/rollback uncertainty', async () => {
    const bad = sqlite();
    const original = bad.db.getFirstAsync;
    bad.db.getFirstAsync = async <T>(sql: string) => sql === 'PRAGMA synchronous' ? { synchronous: 1 } as T : original<T>(sql);
    await expect(createSQLiteJournalStore(async () => bad.db)).rejects.toThrow('journal_durability_unavailable');
    expect(bad.calls).toContain('CLOSE');
    const f = sqlite(), store = await createSQLiteJournalStore(async () => f.db);
    f.envelope = '{';
    await expect(store.transaction(tx => tx.read())).rejects.toThrow('corrupt');
    expect(f.calls).toContain('ROLLBACK');
    f.envelope = 'x'.repeat(220001);
    await expect(store.transaction(tx => tx.read())).rejects.toThrow('corrupt');
    f.envelope = null;
    f.fail = 'COMMIT';
    await expect(store.transaction(tx => tx.write(row))).rejects.toThrow('synthetic_sql');
    f.fail = 'ROLLBACK';
    await expect(store.transaction(async () => { throw Error('work'); })).rejects.toThrow('work');
    expect(f.calls).toContain('CLOSE');
    await expect(store.transaction(async () => null)).rejects.toThrow('journal_connection_unavailable');
    const begin = sqlite(), other = await createSQLiteJournalStore(async () => begin.db);
    begin.fail = 'BEGIN';
    await expect(other.transaction(async () => null)).rejects.toThrow('synthetic_sql');
    expect(begin.calls).toContain('ROLLBACK');
});
it('cleanup failures never replace the original error or allow a poisoned connection to resume', async () => {
    const init = sqlite();
    init.fail = 'PRAGMA';
    init.db.closeAsync = async () => { throw Error('close_failure'); };
    await expect(createSQLiteJournalStore(async () => init.db)).rejects.toThrow('synthetic_sql');
    const f = sqlite(), store = await createSQLiteJournalStore(async () => f.db);
    f.fail = 'ROLLBACK';
    f.db.closeAsync = async () => { throw Error('close_failure'); };
    await expect(store.transaction(async () => { throw Error('original_work_failure'); })).rejects.toThrow('original_work_failure');
    await expect(store.transaction(async () => null)).rejects.toThrow('journal_connection_unavailable');
});
