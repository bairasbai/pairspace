import type { JournalStore, JournalRow } from './types';
import { JournalFault, rowValue } from './validation';
/** Minimal async SQLite capability; no caller can access the private connection through JournalStore. */
export interface JournalSQLite {
    execAsync(sql: string): Promise<void>;
    getFirstAsync<T>(sql: string): Promise<T | null>;
    runAsync(sql: string, value: string): Promise<unknown>;
    closeAsync(): Promise<void>;
}
export async function createSQLiteJournalStore(open: () => Promise<JournalSQLite>): Promise<JournalStore> {
    const db = await open();
    try {
        await db.execAsync('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=2500;');
        const mode = await db.getFirstAsync<{
            journal_mode: string;
        }>('PRAGMA journal_mode');
        const sync = await db.getFirstAsync<{
            synchronous: number;
        }>('PRAGMA synchronous');
        const foreign = await db.getFirstAsync<{
            foreign_keys: number;
        }>('PRAGMA foreign_keys');
        if (mode?.journal_mode.toLowerCase() !== 'wal' || sync?.synchronous !== 2 || foreign?.foreign_keys !== 1)
            throw new Error('journal_durability_unavailable');
        await db.execAsync(`CREATE TABLE IF NOT EXISTS chat_journal_envelope (
      slot INTEGER PRIMARY KEY CHECK(slot=1), envelope TEXT NOT NULL CHECK(length(envelope)<=220000)
    );`);
    }
    catch (error) {
        await db.closeAsync().catch(() => { });
        throw error;
    }
    let tail: Promise<unknown> = Promise.resolve();
    let poisoned = false;
    return {
        transaction<T>(work: (tx: {
            read: () => Promise<JournalRow | null>;
            write: (row: JournalRow) => Promise<void>;
        }) => Promise<T>): Promise<T> {
            const run = tail.then(async () => {
                if (poisoned)
                    throw new Error('journal_connection_unavailable');
                let begun = false;
                try {
                    begun = true;
                    await db.execAsync('BEGIN IMMEDIATE');
                    const value = await work({
                        async read() {
                            const found = await db.getFirstAsync<{
                                envelope: string;
                            }>('SELECT envelope FROM chat_journal_envelope WHERE slot=1');
                            if (!found)
                                return null;
                            if (typeof found.envelope !== 'string' || found.envelope.length > 220000)
                                throw new JournalFault('corrupt');
                            try {
                                return rowValue(JSON.parse(found.envelope));
                            }
                            catch {
                                throw new JournalFault('corrupt');
                            }
                        },
                        async write(row) {
                            rowValue(row);
                            await db.runAsync('INSERT INTO chat_journal_envelope(slot,envelope) VALUES(1,?) ON CONFLICT(slot) DO UPDATE SET envelope=excluded.envelope', JSON.stringify(row));
                        },
                    });
                    await db.execAsync('COMMIT');
                    begun = false;
                    return value;
                }
                catch (error) {
                    if (begun) {
                        try {
                            await db.execAsync('ROLLBACK');
                        }
                        catch {
                            poisoned = true;
                            await db.closeAsync().catch(() => { });
                        }
                    }
                    throw error;
                }
            });
            tail = run.catch(() => { });
            return run;
        },
    };
}
