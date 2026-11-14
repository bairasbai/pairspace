import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { JournalCipher, JournalKey, JournalKeys, JournalRow, JournalStore } from '../src/chat/journal/types';
import { createJournal } from '../src/chat/journal/engine';
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export function journalFixture() {
    let row: JournalRow | null = null, key: JournalKey | null = null;
    let sequence = 0, failWrite = false, failCommit = false, failAfterCommit = false, failRemove = false;
    let tail: Promise<unknown> = Promise.resolve();
    let sealing: (() => Promise<void>) | null = null;
    const store: JournalStore = { transaction(work) {
            const run = tail.then(async () => {
                let pending = clone(row);
                const result = await work({ read: async () => clone(pending), write: async (next) => {
                        if (failWrite) {
                            failWrite = false;
                            throw Error('synthetic_write');
                        }
                        pending = clone(next);
                    } });
                if (failCommit) {
                    failCommit = false;
                    throw Error('synthetic_commit');
                }
                row = pending;
                if (failAfterCommit) {
                    failAfterCommit = false;
                    throw Error('synthetic_commit_ack');
                }
                return result;
            });
            tail = run.catch(() => { });
            return run;
        } };
    const keys: JournalKeys = { read: async () => key && clone(key), create: async (installationId) => {
            key = { installationId, secret: randomBytes(32).toString('base64') };
            return clone(key);
        }, remove: async () => { if (failRemove)
            throw Error('synthetic_key_delete'); key = null; } };
    const cipher: JournalCipher = {
        async seal(text, k, aad) {
            if (sealing)
                await sealing();
            const nonce = randomBytes(12), c = createCipheriv('aes-256-gcm', Buffer.from(k.secret, 'base64'), nonce);
            c.setAAD(Buffer.from(aad));
            const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
            return { data: Buffer.concat([nonce, body, c.getAuthTag()]).toString('base64') };
        },
        async open(envelope, k, aad) {
            const raw = Buffer.from(envelope.data, 'base64'), c = createDecipheriv('aes-256-gcm', Buffer.from(k.secret, 'base64'), raw.subarray(0, 12));
            c.setAAD(Buffer.from(aad));
            c.setAuthTag(raw.subarray(-16));
            return Buffer.concat([c.update(raw.subarray(12, -16)), c.final()]).toString('utf8');
        },
    };
    return { store, keys, cipher, engine: () => createJournal({ store, keys, cipher, randomId: () => `install-${++sequence}` }),
        get row() { return clone(row); }, set row(value) { row = clone(value); }, get key() { return key && clone(key); }, set key(value) { key = value && clone(value); },
        failWrite() { failWrite = true; }, failCommit() { failCommit = true; }, failAfterCommit() { failAfterCommit = true; },
        failRemove(value = true) { failRemove = value; }, onSeal(fn: (() => Promise<void>) | null) { sealing = fn; } };
}
export const journalScope = { origin: 'https://pair.example.test', userId: 'user-1', coupleId: 'pair-1', membershipEpoch: 1 };
export function latch() { let release!: () => void, arrive!: () => void; const gate = new Promise<void>(r => { release = r; }); const reached = new Promise<void>(r => { arrive = r; }); return { gate, reached, release, arrive }; }
