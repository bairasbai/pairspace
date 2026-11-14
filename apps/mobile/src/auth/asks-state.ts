import { normalizeAskText } from '../../../../packages/domain/asks/text';
import type { SessionContext } from './context';
import { record, uuid, sameDateContext } from './dates-state';
import { instant } from './partings-state';
export { record, uuid, sameDateContext, instant };
export type AskQuestion = Readonly<{
    id: string;
    coupleId: string;
    authorId: string;
    recipientId: string;
    membershipEpoch: number;
    sequence: number;
    version: number;
    createdAt: string;
    questionState: 'active' | 'removed';
    responseState: 'waiting' | 'answered' | 'skipped' | 'withdrawn' | 'answer_removed';
    question?: string;
    answer?: string;
    answeredAt?: string;
}>;
export type AnswerDraft = Readonly<{
    id: string;
    version: number;
    text: string;
    stale?: 'changed' | 'terminal';
}>;
export type AskView = Readonly<{
    userId: string | null;
    available: boolean;
    busy: boolean;
    checked: boolean;
    checkedAt: string | null;
    questions: readonly AskQuestion[];
    used: number;
    capacity: 100;
    create: string;
    answerDraft: AnswerDraft | null;
    pending: boolean;
    requiresRefresh: boolean;
    error: boolean;
    status: 'idle' | 'saving' | 'retry' | 'saved' | 'invalid' | 'conflict' | 'unavailable' | 'limit';
}>;
export const emptyAsks: AskView = Object.freeze({ userId: null, available: false, busy: false, checked: false, checkedAt: null, questions: [], used: 0, capacity: 100,
    create: '', answerDraft: null, pending: false, requiresRefresh: false, error: false, status: 'idle' });
export const exact = (v: Record<string, unknown>, keys: string) => Object.keys(v).sort().join(',') === keys.split(',').sort().join(',');
export const parseAskText = normalizeAskText;
export function validAsk(v: unknown, c: SessionContext): v is AskQuestion {
    if (!record(v) || c.state !== 'ready' || !['active', 'removed'].includes(String(v.questionState)) || !['waiting', 'answered', 'skipped', 'withdrawn', 'answer_removed'].includes(String(v.responseState)))
        return false;
    const active = v.questionState === 'active', answered = v.responseState === 'answered', hasTime = answered || v.responseState === 'answer_removed';
    if (!exact(v, 'id,coupleId,authorId,recipientId,membershipEpoch,sequence,version,createdAt,questionState,responseState' + (active ? ',question' : '') + (answered ? ',answer' : '') + (hasTime ? ',answeredAt' : ''))
        || !uuid(v.id) || !uuid(v.authorId) || !uuid(v.recipientId) || v.authorId === v.recipientId || ![v.authorId, v.recipientId].includes(c.userId)
        || v.coupleId !== c.coupleId || v.membershipEpoch !== c.membershipEpoch || !instant(v.createdAt)
        || !Number.isSafeInteger(v.sequence) || Number(v.sequence) < 1 || Number(v.sequence) > 100
        || !Number.isSafeInteger(v.version) || Number(v.version) < 1 || Number(v.version) > 2147483647)
        return false;
    if ((active && v.responseState === 'withdrawn') || (!active && v.responseState === 'waiting'))
        return false;
    const legalVersion = v.responseState === 'waiting' ? 1 : v.responseState === 'withdrawn' ? 2 : (v.responseState === 'answer_removed' ? 3 : 2) + (active ? 0 : 1);
    if (v.version !== legalVersion)
        return false;
    if (active && (parseAskText(v.question) !== v.question || typeof v.question !== 'string'))
        return false;
    if (answered && (parseAskText(v.answer) !== v.answer || typeof v.answer !== 'string'))
        return false;
    return !hasTime || (instant(v.answeredAt) && v.answeredAt >= v.createdAt);
}
export function followsAsk(old: AskQuestion, next: AskQuestion): boolean {
    if (!['id', 'coupleId', 'authorId', 'recipientId', 'membershipEpoch', 'sequence', 'createdAt'].every(k => old[k as keyof AskQuestion] === next[k as keyof AskQuestion]) || next.version < old.version)
        return false;
    if (old.questionState === 'removed' && next.questionState !== 'removed')
        return false;
    if (old.questionState === 'active' && next.questionState === 'active' && old.question !== next.question)
        return false;
    if (old.responseState !== 'waiting' && next.responseState !== old.responseState && !(old.responseState === 'answered' && next.responseState === 'answer_removed'))
        return false;
    if (old.answeredAt && next.answeredAt !== old.answeredAt)
        return false;
    if (old.responseState === 'answered' && next.responseState === 'answered' && old.answer !== next.answer)
        return false;
    const questionChanged = old.questionState !== next.questionState;
    const responseSteps = old.responseState === next.responseState ? 0 : old.responseState === 'waiting' && next.responseState === 'answer_removed' ? 2 : 1;
    const steps = responseSteps + (questionChanged && next.responseState !== 'withdrawn' ? 1 : 0);
    return next.version === old.version + steps && (steps > 0 || Object.keys(old).every(k => old[k as keyof AskQuestion] === next[k as keyof AskQuestion]));
}
export function orderAsks(a: AskQuestion, b: AskQuestion) { return Number(b.responseState === 'waiting') - Number(a.responseState === 'waiting') || b.sequence - a.sequence; }
