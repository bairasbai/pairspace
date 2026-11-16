import { followsCapsule, mayReadCapsule, normalizeCapsuleBody,
  parseCapsuleSchedule, resealCapsule, nextCapsuleYear, removeCapsule, validCapsule, type Capsule } from '../../../../packages/domain/capsules/policy';
import { exact, instant, record, uuid } from '../../../../packages/domain/hard/metadata';
export { followsCapsule, normalizeCapsuleBody, parseCapsuleSchedule, resealCapsule, nextCapsuleYear, removeCapsule, validCapsule, exact, instant, record, uuid };
export type { Capsule };
export type { CapsulesActions } from './capsules';
export type CapsuleScheduleInput = Readonly<{ localDate: string; localTime: string; timezone: string; offset: string }>;
export type CapsuleView = Readonly<{
  generation: number; revision: number; available: boolean; userId: string | null; busy: boolean;
  checked: boolean; checkedAt: string | null; capsules: readonly Capsule[]; used: number; capacity: 1;
  draft: string; schedule: CapsuleScheduleInput;
  reader: Readonly<{ capsule: Capsule; text: string; checkedAt: string }> | null;
  readerStatus: 'closed' | 'loading' | 'opened' | 'changed' | 'error';
  pending: boolean; requiresRefresh: boolean; error: boolean;
  status: 'idle' | 'saving' | 'retry' | 'saved' | 'invalid' | 'conflict' | 'unavailable' | 'limit' | 'not_due';
}>;
export const emptyCapsuleSchedule: CapsuleScheduleInput = Object.freeze({ localDate: '', localTime: '', timezone: '', offset: '' });
export const emptyCapsules: CapsuleView = Object.freeze({ generation: 0, revision: 0, available: false, userId: null, busy: false,
  checked: false, checkedAt: null, capsules: Object.freeze([]), used: 0, capacity: 1, draft: '', schedule: emptyCapsuleSchedule,
  reader: null, readerStatus: 'closed', pending: false, requiresRefresh: false, error: false, status: 'idle' });
export function canReadCapsule(capsule: Capsule, userId: string | null, checkedAt: string | null): boolean {
  return userId !== null && checkedAt !== null && mayReadCapsule(capsule,
    { coupleId: capsule.coupleId, membershipEpoch: capsule.membershipEpoch, userId }, checkedAt);
}
export const capsuleOrder = (a: Capsule, b: Capsule) => a.createdAt === b.createdAt
  ? (a.id === b.id ? 0 : a.id > b.id ? -1 : 1) : a.createdAt > b.createdAt ? -1 : 1;
/** No SQL sequence is exposed. A single ACK/detail cannot certify complete history. */
export function mergeCapsule(view: CapsuleView, next: Capsule, checkedAt: string): Pick<CapsuleView, 'capsules' | 'used' | 'reader'> {
  const scope = { coupleId: next.coupleId, membershipEpoch: next.membershipEpoch, userId: view.userId! };
  const old = view.capsules.find(q => q.id === next.id);
  if (!validCapsule(next, scope) || (old && !followsCapsule(old, next, scope)) || (!old && view.capsules.length >= 1)) throw Error('invalid_capsule_revision');
  const capsules = [...view.capsules.filter(q => q.id !== next.id), next].sort(capsuleOrder);
  const reader = view.reader && (!canReadCapsule(view.reader.capsule, view.userId, checkedAt)
    || (view.reader.capsule.id === next.id && (view.reader.capsule.version !== next.version || !canReadCapsule(next, view.userId, checkedAt)))) ? null : view.reader;
  return { capsules, used: Math.max(view.used, capsules.length), reader };
}
