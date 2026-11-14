import { normalizeMessageText } from '../text';
import type { JournalDraft, JournalPending, JournalRow, JournalScope, JournalSnapshot } from './types';
export class JournalFault extends Error {
    constructor(readonly code: 'locked' | 'corrupt' | 'stale' | 'conflict' | 'invalid') { super(code); }
}
export const integer = (x: unknown): x is number => Number.isSafeInteger(x) && Number(x) >= 0 && Number(x) < Number.MAX_SAFE_INTEGER;
export const identifier = (x: unknown): x is string => typeof x === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(x);
export const record = (x: unknown): x is Record<string, unknown> => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const exact = (x: Record<string, unknown>, keys: string[]) => Object.keys(x).sort().join(',') === keys.sort().join(',');
export function scopeKey(scope: JournalScope): string {
    if (!record(scope) || !exact(scope, ['origin', 'userId', 'coupleId', 'membershipEpoch']) || !identifier(scope.userId) || !identifier(scope.coupleId)
        || !integer(scope.membershipEpoch) || scope.membershipEpoch === 0)
        throw new JournalFault('invalid');
    let url: URL;
    try {
        url = new URL(scope.origin);
    }
    catch {
        throw new JournalFault('invalid');
    }
    if (url.origin !== scope.origin || !['https:', 'http:'].includes(url.protocol) || url.username || url.password
        || (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
        throw new JournalFault('invalid');
    return JSON.stringify([scope.origin, scope.userId, scope.coupleId, scope.membershipEpoch]);
}
export function draftValue(input: unknown): JournalDraft {
    if (!record(input) || !exact(input, ['revision', 'text', ...(input.replyToId === undefined ? [] : ['replyToId'])])
        || !integer(input.revision) || typeof input.text !== 'string' || (input.replyToId !== undefined && !identifier(input.replyToId)))
        throw new JournalFault('invalid');
    // Empty draft means explicitly clear, but retains a revision fence.
    const normal = normalizeMessageText(input.text);
    if (!normal.ok && normal.error !== 'empty_text')
        throw new JournalFault('invalid');
    const text = normal.ok ? normal.text : input.text.replace(/\r\n?/g, '\n').normalize('NFC');
    if (Array.from(text).length > 8000)
        throw new JournalFault('invalid');
    return { revision: input.revision, text, ...(input.replyToId === undefined ? {} : { replyToId: input.replyToId }) };
}
export function pendingValue(input: unknown): JournalPending {
    if (!record(input) || !exact(input, ['clientId', 'body', 'draftRevision', ...(input.replyToId === undefined ? [] : ['replyToId'])])
        || !identifier(input.clientId) || !integer(input.draftRevision) || (input.replyToId !== undefined && !identifier(input.replyToId)))
        throw new JournalFault('invalid');
    const normal = normalizeMessageText(input.body);
    if (!normal.ok)
        throw new JournalFault('invalid');
    return { clientId: input.clientId, body: normal.text, draftRevision: input.draftRevision, ...(input.replyToId === undefined ? {} : { replyToId: input.replyToId }) };
}
export function snapshotValue(value: unknown): JournalSnapshot {
    if (!record(value) || !exact(value, ['draft', 'pending']))
        throw new JournalFault('corrupt');
    try {
        const draft = value.draft === null ? null : draftValue(value.draft);
        const pending = value.pending === null ? null : pendingValue(value.pending);
        if (JSON.stringify({ draft, pending }) !== JSON.stringify(value))
            throw new JournalFault('corrupt');
        return { draft, pending };
    }
    catch {
        throw new JournalFault('corrupt');
    }
}
export function rowValue(value: unknown): JournalRow | null {
    if (value === null)
        return null;
    if (!record(value) || !exact(value, ['installationId', 'generation', 'lease', 'scope', 'revision', 'draftRevision', 'pendingFloor', 'hasDraft', 'hasPending', 'sealed'])
        || !identifier(value.installationId) || !integer(value.generation) || !integer(value.lease) || !integer(value.revision) || !(value.draftRevision === -1 || integer(value.draftRevision)) || !(value.pendingFloor === -1 || integer(value.pendingFloor))
        || !(value.scope === null || (typeof value.scope === 'string' && value.scope.length <= 2048))
        || typeof value.hasDraft !== 'boolean' || typeof value.hasPending !== 'boolean'
        || !(value.sealed === null || (record(value.sealed) && exact(value.sealed, ['data']) && typeof value.sealed.data === 'string' && value.sealed.data.length <= 200000 && /^[A-Za-z0-9+/]+={0,2}$/.test(value.sealed.data))))
        throw new JournalFault('corrupt');
    if (value.scope === null && (value.sealed !== null || value.hasDraft || value.hasPending))
        throw new JournalFault('corrupt');
    if (value.sealed === null && (value.hasDraft || value.hasPending))
        throw new JournalFault('corrupt');
    return value as JournalRow;
}
export const utf8Bytes = (text: string) => Array.from(text).reduce((total, char) => { const code = char.codePointAt(0)!; return total + (code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4); }, 0);
export const associatedData = (row: JournalRow) => JSON.stringify(['pairspace-chat-journal', 1, row.installationId, row.generation, row.scope,
    row.revision, row.draftRevision, row.pendingFloor, row.hasDraft, row.hasPending]);
