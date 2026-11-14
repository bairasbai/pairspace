import { normalizeStemText } from '../../../../packages/domain/stems/text';
import type { SessionContext } from './context';
import { record, uuid, sameDateContext } from './dates-state';
import { instant } from './partings-state';
export { record, uuid, sameDateContext, instant };
export type StemRound = Readonly<{
    id: string;
    coupleId: string;
    authorId: string;
    recipientId: string;
    membershipEpoch: number;
    sequence: number;
    version: number;
    createdAt: string;
    phase: 'waiting' | 'completed' | 'skipped' | 'withdrawn';
    authorTextState: 'active' | 'removed';
    recipientTextState: 'absent' | 'active' | 'removed';
    beginning?: string;
    authorContinuation?: string;
    recipientContinuation?: string;
    completedAt?: string;
}>;
export type CompletionDraft = Readonly<{
    id: string;
    version: number;
    text: string;
    stale?: 'changed' | 'terminal';
}>;
export type StemView = Readonly<{
    userId: string | null;
    available: boolean;
    busy: boolean;
    checked: boolean;
    checkedAt: string | null;
    rounds: readonly StemRound[];
    used: number;
    capacity: 100;
    create: Readonly<{
        beginning: string;
        ownContinuation: string;
    }>;
    completionDraft: CompletionDraft | null;
    pending: boolean;
    requiresRefresh: boolean;
    error: boolean;
    status: 'idle' | 'saving' | 'retry' | 'saved' | 'invalid' | 'conflict' | 'unavailable' | 'limit';
}>;
export const emptyStems: StemView = Object.freeze({ userId: null, available: false, busy: false, checked: false, checkedAt: null, rounds: [], used: 0, capacity: 100,
    create: { beginning: '', ownContinuation: '' }, completionDraft: null, pending: false, requiresRefresh: false, error: false, status: 'idle' });
export const exact = (v: Record<string, unknown>, keys: string) => Object.keys(v).sort().join(',') === keys.split(',').sort().join(',');
export const parseStemText = normalizeStemText;
export function validStem(v: unknown, c: SessionContext): v is StemRound {
    if (!record(v) || c.state !== 'ready' || !['waiting', 'completed', 'skipped', 'withdrawn'].includes(String(v.phase)) || !['active', 'removed'].includes(String(v.authorTextState)) || !['absent', 'active', 'removed'].includes(String(v.recipientTextState)))
        return false;
    const author = v.authorTextState === 'active', completed = v.phase === 'completed', recipient = v.recipientTextState === 'active', revealed = author && (v.authorId === c.userId || completed);
    if (!exact(v, 'id,coupleId,authorId,recipientId,membershipEpoch,sequence,version,createdAt,phase,authorTextState,recipientTextState' + (author ? ',beginning' : '') + (revealed ? ',authorContinuation' : '') + (recipient ? ',recipientContinuation' : '') + (completed ? ',completedAt' : '')) || !uuid(v.id) || !uuid(v.authorId) || !uuid(v.recipientId) || v.authorId === v.recipientId || ![v.authorId, v.recipientId].includes(c.userId) || v.coupleId !== c.coupleId || v.membershipEpoch !== c.membershipEpoch || !instant(v.createdAt) || !Number.isSafeInteger(v.sequence) || Number(v.sequence) < 1 || Number(v.sequence) > 100)
        return false;
    if (completed ? v.recipientTextState === 'absent' : v.recipientTextState !== 'absent')
        return false;
    if ((v.phase === 'waiting' && !author) || (v.phase === 'withdrawn' && author))
        return false;
    const version = v.phase === 'waiting' ? 1 : v.phase === 'withdrawn' ? 2 : v.phase === 'skipped' ? (author ? 2 : 3) : 2 + (author ? 0 : 1) + (recipient ? 0 : 1);
    if (v.version !== version)
        return false;
    if (author && (typeof v.beginning !== 'string' || parseStemText(v.beginning, 'beginning') !== v.beginning))
        return false;
    if (revealed && (typeof v.authorContinuation !== 'string' || parseStemText(v.authorContinuation, 'continuation') !== v.authorContinuation))
        return false;
    if (recipient && (typeof v.recipientContinuation !== 'string' || parseStemText(v.recipientContinuation, 'continuation') !== v.recipientContinuation))
        return false;
    return !completed || (instant(v.completedAt) && v.completedAt >= v.createdAt);
}
export function followsStem(old: StemRound, next: StemRound): boolean {
    if (!['id', 'coupleId', 'authorId', 'recipientId', 'membershipEpoch', 'sequence', 'createdAt'].every(k => old[k as keyof StemRound] === next[k as keyof StemRound]) || next.version < old.version)
        return false;
    if (old.phase !== 'waiting' && old.phase !== next.phase)
        return false;
    if (old.authorTextState === 'removed' && next.authorTextState !== 'removed')
        return false;
    if (old.recipientTextState === 'removed' && next.recipientTextState !== 'removed')
        return false;
    for (const key of ['beginning', 'authorContinuation', 'recipientContinuation', 'completedAt'] as const)
        if (old[key] !== undefined && next[key] !== undefined && old[key] !== next[key])
            return false;
    if (old.completedAt && old.completedAt !== next.completedAt)
        return false;
    return next.version > old.version || Object.keys(old).every(k => old[k as keyof StemRound] === next[k as keyof StemRound]);
}
export function orderStems(a: StemRound, b: StemRound) { return Number(b.phase === 'waiting') - Number(a.phase === 'waiting') || b.sequence - a.sequence; }
