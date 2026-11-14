import type { JournalCipher, JournalDraft, JournalKeys, JournalPending, JournalPort, JournalResult, JournalRow, JournalScope, JournalSnapshot, JournalStore, JournalToken, JournalTransaction } from './types';
import { associatedData, draftValue, identifier, JournalFault, pendingValue, rowValue, scopeKey, snapshotValue, utf8Bytes } from './validation';
export type JournalDependencies = {
    store: JournalStore;
    keys: JournalKeys;
    cipher: JournalCipher;
    randomId: () => string;
};
/** Serialized engine; durable lease checks remain necessary across multiple engines/connections. */
export function createJournal({ store, keys, cipher, randomId }: JournalDependencies): JournalPort {
    let tail: Promise<unknown> = Promise.resolve();
    let runtime = 0;
    let activeToken: string | null = null;
    const tag = (token: JournalToken) => JSON.stringify([token.installationId, token.generation, token.lease, token.scope]);
    const fence = (epoch: number, token?: JournalToken) => { if (epoch !== runtime || (token && activeToken !== tag(token)))
        throw new JournalFault('stale'); };
    const enqueue = <T>(work: () => Promise<T>): Promise<JournalResult<T>> => {
        const run = tail.then(work);
        tail = run.catch(() => { });
        return run.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error: error instanceof JournalFault ? error.code : 'storage_error' }));
    };
    const verify = (row: JournalRow | null, token: JournalToken): JournalRow => {
        if (!row || row.scope === null || row.installationId !== token.installationId || row.generation !== token.generation
            || row.lease !== token.lease || row.scope !== token.scope)
            throw new JournalFault('stale');
        return row;
    };
    async function keyFor(row: JournalRow) {
        const key = await keys.read();
        if (!key || key.installationId !== row.installationId)
            throw new JournalFault('locked');
        return key;
    }
    async function decode(row: JournalRow): Promise<JournalSnapshot> {
        const key = await keyFor(row);
        if (!row.sealed)
            return { draft: null, pending: null };
        try {
            const plaintext = await cipher.open(row.sealed, key, associatedData(row));
            if (utf8Bytes(plaintext) > 110000)
                throw new JournalFault('corrupt');
            const value = snapshotValue(JSON.parse(plaintext));
            if (Boolean(value.draft?.text) !== row.hasDraft || Boolean(value.pending) !== row.hasPending
                || (value.draft && value.draft.revision > row.draftRevision))
                throw new JournalFault('corrupt');
            return value;
        }
        catch (error) {
            if (error instanceof JournalFault)
                throw error;
            throw new JournalFault('corrupt');
        }
    }
    async function encode(tx: JournalTransaction, row: JournalRow, value: JournalSnapshot, epoch: number, token: JournalToken) {
        const next = { ...row, revision: row.revision + 1, hasDraft: Boolean(value.draft?.text), hasPending: Boolean(value.pending) };
        rowValue({ ...next, sealed: null, hasDraft: false, hasPending: false });
        const plaintext = JSON.stringify(value);
        if (utf8Bytes(plaintext) > 110000)
            throw new JournalFault('invalid');
        next.sealed = await cipher.seal(plaintext, await keyFor(row), associatedData(next));
        rowValue(next);
        fence(epoch, token);
        await tx.write(next);
        fence(epoch, token);
    }
    function operation<T>(token: JournalToken, work: (tx: JournalTransaction, row: JournalRow, epoch: number) => Promise<T>): Promise<JournalResult<T>> {
        const epoch = runtime;
        return enqueue(async () => {
            fence(epoch, token);
            const result = await store.transaction(async (tx) => {
                const row = verify(rowValue(await tx.read()), token);
                fence(epoch, token);
                const value = await work(tx, row, epoch);
                fence(epoch, token);
                return value;
            });
            fence(epoch, token);
            return result;
        });
    }
    async function clear(expected?: JournalToken): Promise<JournalRow> {
        return store.transaction(async (tx) => {
            let old: JournalRow | null;
            try { old = rowValue(await tx.read()); }
            catch (error) {
                if (expected || !(error instanceof JournalFault) || error.code !== 'corrupt') throw error;
                old = null; // Explicit reset may replace unreadable local metadata, never ordinary bind.
            }
            if (expected)
                verify(old, expected);
            const row: JournalRow = { installationId: old?.installationId ?? randomId(), generation: (old?.generation ?? 0) + 1,
                lease: (old?.lease ?? 0) + 1, scope: null, revision: (old?.revision ?? 0) + 1, draftRevision: -1, pendingFloor: -1, hasDraft: false, hasPending: false, sealed: null };
            rowValue(row);
            await tx.write(row);
            return row;
        });
    }
    async function removeRetiredKey(marker: JournalRow) {
        // Separate durable retirement first. Never delete a key belonging to a newer bound journal.
        await store.transaction(async (tx) => {
            const row = rowValue(await tx.read());
            if (!row || row.scope !== null || row.installationId !== marker.installationId || row.lease !== marker.lease)
                throw new JournalFault('stale');
            await keys.remove();
        });
    }
    function removePending(token: JournalToken, clientId: string, draftRevision: number) {
        return operation(token, async (tx, row, epoch) => {
            if (!identifier(clientId) || !Number.isSafeInteger(draftRevision) || draftRevision<0)
                throw new JournalFault('invalid');
            const value = await decode(row);
            if (!value.pending)
                return null;
            if (value.pending.clientId !== clientId || value.pending.draftRevision!==draftRevision)
                throw new JournalFault('conflict');
            await encode(tx, row, { ...value, pending: null }, epoch, token);
            return null;
        });
    }
    return {
        bindVerifiedScope(scope: JournalScope) {
            const epoch = runtime;
            return enqueue(async () => {
                const wanted = scopeKey(scope);
                fence(epoch);
                const previous = await store.transaction(async (tx) => rowValue(await tx.read()));
                if (previous?.scope !== null && previous?.scope !== undefined && previous.scope !== wanted) {
                    const marker = await clear({ installationId: previous.installationId, generation: previous.generation, lease: previous.lease, scope: previous.scope });
                    await removeRetiredKey(marker);
                }
                fence(epoch);
                const token = await store.transaction(async (tx) => {
                    const old = rowValue(await tx.read());
                    let key = await keys.read();
                    let row: JournalRow;
                    if (old?.scope !== null && old?.scope !== undefined) {
                        if (old.scope !== wanted)
                            throw new JournalFault('stale');
                        if (!key || key.installationId !== old.installationId)
                            throw new JournalFault('locked');
                        row = { ...old, lease: old.lease + 1 };
                    }
                    else {
                        // Orphan key is an explicit repair condition, never silently adopted or overwritten.
                        if (key)
                            throw new JournalFault('locked');
                        const installationId = randomId();
                        if (!identifier(installationId))
                            throw new JournalFault('invalid');
                        key = await keys.create(installationId);
                        if (key.installationId !== installationId)
                            throw new JournalFault('locked');
                        row = { installationId, generation: (old?.generation ?? 0) + 1, lease: (old?.lease ?? 0) + 1, scope: wanted,
                            revision: 0, draftRevision: -1, pendingFloor: -1, hasDraft: false, hasPending: false, sealed: null };
                    }
                    rowValue(row);
                    fence(epoch);
                    await tx.write(row);
                    return Object.freeze({ installationId: row.installationId, generation: row.generation, lease: row.lease, scope: wanted });
                });
                fence(epoch);
                activeToken = tag(token);
                return token;
            });
        },
        inspect: token => operation(token, async (_tx, row) => {
            await keyFor(row);
            return { hasDraft: row.hasDraft, hasPending: row.hasPending, draftRevision: row.draftRevision };
        }),
        restore: token => operation(token, async (_tx, row) => decode(row)),
        saveDraft(token: JournalToken, input: JournalDraft) {
            return operation(token, async (tx, row, epoch) => {
                const draft = draftValue(input), value = await decode(row);
                if (draft.revision < row.draftRevision)
                    throw new JournalFault('stale');
                if (draft.revision === row.draftRevision) {
                    if (JSON.stringify(value.draft) !== JSON.stringify(draft))
                        throw new JournalFault('conflict');
                    return null;
                }
                await encode(tx, { ...row, draftRevision: draft.revision }, { ...value, draft }, epoch, token);
                return null;
            });
        },
        prepareSend(token: JournalToken, input: JournalPending) {
            return operation(token, async (tx, row, epoch) => {
                const pending = pendingValue(input), value = await decode(row);
                if (value.pending) {
                    if (JSON.stringify(value.pending) !== JSON.stringify(pending))
                        throw new JournalFault('conflict');
                    return null;
                }
                if (pending.draftRevision <= row.pendingFloor)
                    throw new JournalFault('stale');
                if (value.draft?.revision === pending.draftRevision
                    && (value.draft.text !== pending.body || value.draft.replyToId !== pending.replyToId))
                    throw new JournalFault('conflict');
                const draft = value.draft && value.draft.revision > pending.draftRevision ? value.draft : null;
                await encode(tx, { ...row, draftRevision: Math.max(row.draftRevision, pending.draftRevision), pendingFloor: pending.draftRevision }, { draft, pending }, epoch, token);
                return null;
            });
        },
        settlePending: removePending,
        discardPending(token, clientId, draftRevision) {
            return operation(token, async (tx, row, epoch) => {
                if ((clientId !== null && !identifier(clientId))
                    || !Number.isSafeInteger(draftRevision) || draftRevision < 0)
                    throw new JournalFault('invalid');
                const value = await decode(row);
                if (value.pending && (value.pending.clientId !== clientId
                    || value.pending.draftRevision !== draftRevision))
                    throw new JournalFault('conflict');
                const draft = value.draft?.revision === draftRevision ? null : value.draft;
                const next = {
                    ...row,
                    draftRevision: Math.max(row.draftRevision, draftRevision),
                    pendingFloor: Math.max(row.pendingFloor, draftRevision),
                };
                if (!value.pending && draft === value.draft
                    && next.draftRevision === row.draftRevision && next.pendingFloor === row.pendingFloor)
                    return null;
                await encode(tx, next, { draft, pending: null }, epoch, token);
                return null;
            });
        },
        suspend(token) { if (activeToken === tag(token)) {
            activeToken = null;
            runtime++;
        } },
        retire(token) { if (activeToken === tag(token) || activeToken === null) {
            activeToken = null;
            runtime++;
        } return enqueue(async () => { const marker = await clear(token); await removeRetiredKey(marker); return null; }); },
        reset() { activeToken = null; runtime++; return enqueue(async () => { const marker = await clear(); await removeRetiredKey(marker); return null; }); },
    };
}
