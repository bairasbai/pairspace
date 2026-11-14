import { normalizeWordText } from '../../../../packages/domain/words/text';
import type { SessionContext } from './context';
import { record, uuid, sameDateContext } from './dates-state';
import { instant } from './partings-state';
export { record, uuid, sameDateContext, instant };
export type WordFields = Readonly<{
    word: string;
    meaning: string;
    saidWhen: string;
}>;
type Identity = Readonly<{
    id: string;
    coupleId: string;
    authorId: string;
    membershipEpoch: number;
    sequence: number;
    version: number;
    createdAt: string;
}>;
export type LoveWord = Identity & (Readonly<{
    state: 'active';
    edited: boolean;
}> & WordFields | Readonly<{
    state: 'deleted';
}>);
export type LoveWordsView = Readonly<{
    userId: string | null;
    available: boolean;
    busy: boolean;
    checked: boolean;
    checkedAt: string | null;
    words: readonly LoveWord[];
    used: number;
    capacity: 100;
    create: WordFields;
    editor: Readonly<{
        id: string;
        version: number;
        fields: WordFields;
        stale?: 'changed' | 'deleted';
    }> | null;
    pending: boolean;
    requiresRefresh: boolean;
    error: boolean;
    status: 'idle' | 'saving' | 'retry' | 'saved' | 'invalid' | 'conflict' | 'unavailable' | 'limit';
}>;
export const blankWords: WordFields = Object.freeze({ word: '', meaning: '', saidWhen: '' });
export const emptyLoveWords: LoveWordsView = Object.freeze({ userId: null, available: false, busy: false, checked: false, checkedAt: null, words: [], used: 0, capacity: 100,
    create: blankWords, editor: null, pending: false, requiresRefresh: false, error: false, status: 'idle' });
export function parseWordFields(fields: WordFields): WordFields | null {
    const word = normalizeWordText(fields.word, 'word'), meaning = normalizeWordText(fields.meaning, 'optional'), saidWhen = normalizeWordText(fields.saidWhen, 'optional');
    return word === null || meaning === null || saidWhen === null ? null : { word, meaning, saidWhen };
}
export const exact = (v: Record<string, unknown>, keys: string) => Object.keys(v).sort().join(',') === keys.split(',').sort().join(',');
export function validWord(v: unknown, context: SessionContext): v is LoveWord {
    if (!record(v) || context.state !== 'ready' || !['active', 'deleted'].includes(String(v.state)))
        return false;
    const keys = 'id,coupleId,authorId,membershipEpoch,sequence,version,createdAt,state';
    if (!exact(v, keys + (v.state === 'active' ? ',word,meaning,saidWhen,edited' : '')) || !uuid(v.id) || !uuid(v.authorId)
        || v.coupleId !== context.coupleId || v.membershipEpoch !== context.membershipEpoch || !instant(v.createdAt)
        || !Number.isSafeInteger(v.version) || Number(v.version) < 1 || Number(v.version) > 2147483647
        || !Number.isSafeInteger(v.sequence) || Number(v.sequence) < 1 || Number(v.sequence) > 100)
        return false;
    if (v.state === 'deleted')
        return Number(v.version) >= 2;
    if (typeof v.word !== 'string' || typeof v.meaning !== 'string' || typeof v.saidWhen !== 'string' || typeof v.edited !== 'boolean')
        return false;
    const fields = parseWordFields(v as WordFields);
    return !!fields && fields.word === v.word && fields.meaning === v.meaning && fields.saidWhen === v.saidWhen && v.edited === (Number(v.version) > 1);
}
export function follows(old: LoveWord, next: LoveWord): boolean {
    return ['id', 'coupleId', 'authorId', 'membershipEpoch', 'sequence', 'createdAt'].every(k => old[k as keyof Identity] === next[k as keyof Identity])
        && next.version >= old.version && (old.state !== 'deleted' || next.state === 'deleted')
        && (next.version !== old.version || Object.keys(old).every(k => old[k as keyof LoveWord] === next[k as keyof LoveWord]));
}
