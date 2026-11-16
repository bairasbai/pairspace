import { validDailySlot, type DailySlot, type DailyScope } from './slot.ts';
import { count, exact, instant, localDay, record, uuid } from './validation.ts';
export type DailyAnswerMetadata = Readonly<{
  id: string; slotId: string; coupleId: string; membershipEpoch: number; authorId: string;
  version: number; createdAt: string; editedAt: string; contentState: 'active' | 'removed'; removedAt: string | null;
}>;
const keys = 'id,slotId,coupleId,membershipEpoch,authorId,version,createdAt,editedAt,contentState,removedAt';
export function validDailyAnswerMetadata(value: unknown, slot: DailySlot, scope: DailyScope): value is DailyAnswerMetadata {
  if (!validDailySlot(slot, scope) || !record(value) || !exact(value, keys)
    || !uuid(value.id) || value.slotId !== slot.id || value.coupleId !== slot.coupleId
    || value.membershipEpoch !== slot.membershipEpoch || !slot.participantIds.includes(value.authorId as string)
    || !count(value.version) || !instant(value.createdAt) || !instant(value.editedAt)
    || value.createdAt < slot.createdAt || value.editedAt < value.createdAt
    || localDay(value.createdAt, slot.timezone) !== slot.day || localDay(value.editedAt, slot.timezone) !== slot.day) return false;
  if (value.contentState === 'active') return value.removedAt === null && value.version < 2147483646
    && (value.version !== 1 || value.editedAt === value.createdAt);
  return value.contentState === 'removed' && instant(value.removedAt) && value.removedAt >= value.editedAt
    && localDay(value.removedAt, slot.timezone) >= slot.day
    && value.version >= 2 && (value.version !== 2 || value.editedAt === value.createdAt);
}
export function createDailyAnswerMetadata(input: unknown, slot: DailySlot, scope: DailyScope,
  trustedNow: string, confirm: boolean): DailyAnswerMetadata | null {
  if (confirm !== true || !validDailySlot(slot, scope) || !record(input) || !exact(input, 'id') || !uuid(input.id)
    || !instant(trustedNow) || trustedNow < slot.createdAt || localDay(trustedNow, slot.timezone) !== slot.day) return null;
  return { id: input.id, slotId: slot.id, coupleId: slot.coupleId, membershipEpoch: slot.membershipEpoch,
    authorId: scope.userId, version: 1, createdAt: trustedNow, editedAt: trustedNow, contentState: 'active', removedAt: null };
}
function canChange(value: unknown, slot: DailySlot, scope: DailyScope, now: string, version: number, confirm: boolean): value is DailyAnswerMetadata {
  return confirm === true && validDailyAnswerMetadata(value, slot, scope) && value.authorId === scope.userId
    && value.contentState === 'active' && value.version === version && instant(now) && now >= value.editedAt;
}
export function rewriteDailyAnswerMetadata(value: unknown, slot: DailySlot, scope: DailyScope,
  trustedNow: string, expectedVersion: number, confirm: boolean): DailyAnswerMetadata | null {
  if (!canChange(value, slot, scope, trustedNow, expectedVersion, confirm) || value.version >= 2147483645
    || localDay(trustedNow, slot.timezone) !== slot.day) return null;
  return { ...value, editedAt: trustedNow, version: value.version + 1 };
}
export function removeDailyAnswerMetadata(value: unknown, slot: DailySlot, scope: DailyScope,
  trustedNow: string, expectedVersion: number, confirm: boolean): DailyAnswerMetadata | null {
  if (!canChange(value, slot, scope, trustedNow, expectedVersion, confirm)
    || localDay(trustedNow, slot.timezone) < slot.day) return null;
  return { ...value, removedAt: trustedNow, contentState: 'removed', version: value.version + 1 };
}
export function projectDailyAnswerMetadata(value: DailyAnswerMetadata): DailyAnswerMetadata {
  return { id: value.id, slotId: value.slotId, coupleId: value.coupleId, membershipEpoch: value.membershipEpoch,
    authorId: value.authorId, version: value.version, createdAt: value.createdAt, editedAt: value.editedAt,
    contentState: value.contentState, removedAt: value.removedAt };
}
/** Version gaps must represent rewrites during the pinned day, optionally one final removal. */
export function followsDailyAnswerMetadata(old: unknown, next: unknown, slot: DailySlot, scope: DailyScope): boolean {
  if (!validDailyAnswerMetadata(old, slot, scope) || !validDailyAnswerMetadata(next, slot, scope)
    || !['id', 'slotId', 'coupleId', 'membershipEpoch', 'authorId', 'createdAt'].every(key =>
      old[key as keyof DailyAnswerMetadata] === next[key as keyof DailyAnswerMetadata])
    || next.version < old.version || next.editedAt < old.editedAt) return false;
  if (old.contentState === 'removed' || next.version === old.version) {
    return Object.keys(old).every(key => old[key as keyof DailyAnswerMetadata] === next[key as keyof DailyAnswerMetadata]);
  }
  return next.contentState !== 'removed' || next.version > old.version + 1 || next.editedAt === old.editedAt;
}
