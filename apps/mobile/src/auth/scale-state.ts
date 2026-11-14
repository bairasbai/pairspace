import { validScaleDate, validScaleValue, validScaleZone } from '../../../../packages/domain/scale/value';
import type { SessionContext } from './context';
import { record, uuid, sameDateContext } from './dates-state';
import { instant } from './partings-state';
export { record, uuid, sameDateContext, instant, validScaleDate, validScaleZone };
type Identity = Readonly<{
    id: string;
    coupleId: string;
    authorId: string;
    membershipEpoch: number;
    localDate: string;
    timezone: string;
    version: number;
    createdAt: string;
}>;
export type ScaleSlot = Identity & (Readonly<{
    state: 'active';
    value: number;
}> | Readonly<{
    state: 'removed';
}>);
export type ScaleCreate = Readonly<{
    expectedDate: string;
    timezone: string;
    value: string;
}>;
export type ScaleView = Readonly<{
    userId: string | null;
    available: boolean;
    busy: boolean;
    checked: boolean;
    checkedAt: string | null;
    slots: readonly ScaleSlot[];
    ownUsed: number;
    capacityPerAuthor: 100;
    create: ScaleCreate;
    editor: Readonly<{
        id: string;
        version: number;
        value: string;
        mode: 'edit' | 'reshare';
        stale?: true;
    }> | null;
    pending: boolean;
    requiresRefresh: boolean;
    error: boolean;
    status: 'idle' | 'saving' | 'retry' | 'saved' | 'invalid' | 'conflict' | 'unavailable' | 'limit' | 'dateMismatch';
}>;
export const blankScale: ScaleCreate = Object.freeze({ expectedDate: '', timezone: '', value: '' });
export const emptyScale: ScaleView = Object.freeze({ userId: null, available: false, busy: false, checked: false, checkedAt: null, slots: [], ownUsed: 0, capacityPerAuthor: 100,
    create: blankScale, editor: null, pending: false, requiresRefresh: false, error: false, status: 'idle' });
export const exact = (v: Record<string, unknown>, keys: string) => Object.keys(v).sort().join(',') === keys.split(',').sort().join(',');
/** An empty field is missing, never implicit zero or a default rating. */
export function parseScaleInput(v: string): number | null { return /^(0|[1-9][0-9]{0,2})$/.test(v) && validScaleValue(Number(v)) ? Number(v) : null; }
export function validSlot(v: unknown, c: SessionContext): v is ScaleSlot {
    if (!record(v) || c.state !== 'ready' || !['active', 'removed'].includes(String(v.state)))
        return false;
    return exact(v, 'id,coupleId,authorId,membershipEpoch,localDate,timezone,version,createdAt,state' + (v.state === 'active' ? ',value' : ''))
        && uuid(v.id) && uuid(v.authorId) && v.coupleId === c.coupleId && v.membershipEpoch === c.membershipEpoch && instant(v.createdAt)
        && validScaleDate(v.localDate) && validScaleZone(v.timezone) && Number.isSafeInteger(v.version) && Number(v.version) > 0 && Number(v.version) <= 2147483647
        && (v.state === 'active' ? validScaleValue(v.value) : Number(v.version) >= 2);
}
export function followsSlot(old: ScaleSlot, next: ScaleSlot): boolean {
    return ['id', 'coupleId', 'authorId', 'membershipEpoch', 'localDate', 'timezone', 'createdAt'].every(k => old[k as keyof Identity] === next[k as keyof Identity])
        && next.version >= old.version
        && (next.version - old.version !== 1 || old.state !== next.state || (old.state === 'active' && next.state === 'active' && old.value !== next.value))
        && (next.version !== old.version || Object.keys(old).every(k => old[k as keyof ScaleSlot] === next[k as keyof ScaleSlot]));
}
export function orderScale(a: ScaleSlot, b: ScaleSlot) { return b.localDate.localeCompare(a.localDate) || a.authorId.localeCompare(b.authorId); }
