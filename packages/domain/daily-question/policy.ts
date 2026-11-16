import { validDailySlot, type DailySlot, type DailyScope } from './slot.ts';
import { createDailyAnswerMetadata, followsDailyAnswerMetadata, projectDailyAnswerMetadata,
  removeDailyAnswerMetadata, rewriteDailyAnswerMetadata, validDailyAnswerMetadata, type DailyAnswerMetadata } from './metadata.ts';
import { exact, instant, localDay, normalizeDailyAnswerText, record } from './validation.ts';
export { normalizeDailyAnswerText };
export type DailyAnswer = DailyAnswerMetadata & (
  Readonly<{ contentState: 'active'; text: string }> | Readonly<{ contentState: 'removed' }>
);
const keys = 'id,slotId,coupleId,membershipEpoch,authorId,version,createdAt,editedAt,contentState,removedAt';
export function validDailyAnswer(value: unknown, slot: DailySlot, scope: DailyScope): value is DailyAnswer {
  return record(value) && exact(value, keys + (value.contentState === 'active' ? ',text' : ''))
    && (value.contentState !== 'active' || (typeof value.text === 'string' && normalizeDailyAnswerText(value.text) === value.text))
    && validDailyAnswerMetadata(projectDailyAnswerMetadata(value as DailyAnswerMetadata), slot, scope);
}
export function createDailyAnswer(input: unknown, slot: DailySlot, scope: DailyScope,
  trustedNow: string, confirm: boolean): DailyAnswer | null {
  if (!record(input) || !exact(input, 'id,text')) return null;
  const metadata = createDailyAnswerMetadata({ id: input.id }, slot, scope, trustedNow, confirm);
  const text = normalizeDailyAnswerText(input.text);
  return metadata && text !== null ? { ...metadata, contentState: 'active', text } : null;
}
export function rewriteDailyAnswer(value: unknown, slot: DailySlot, scope: DailyScope,
  trustedNow: string, expectedVersion: number, text: unknown, confirm: boolean): DailyAnswer | null {
  if (!validDailyAnswer(value, slot, scope)) return null;
  const metadata = rewriteDailyAnswerMetadata(projectDailyAnswerMetadata(value), slot, scope, trustedNow, expectedVersion, confirm);
  const normalized = normalizeDailyAnswerText(text);
  return metadata && normalized !== null ? { ...metadata, contentState: 'active', text: normalized } : null;
}
export function removeDailyAnswer(value: unknown, slot: DailySlot, scope: DailyScope,
  trustedNow: string, expectedVersion: number, confirm: boolean): DailyAnswer | null {
  if (!validDailyAnswer(value, slot, scope)) return null;
  const metadata = removeDailyAnswerMetadata(projectDailyAnswerMetadata(value), slot, scope, trustedNow, expectedVersion, confirm);
  return metadata ? { ...metadata, contentState: 'removed' } : null;
}
export function followsDailyAnswer(old: unknown, next: unknown, slot: DailySlot, scope: DailyScope): boolean {
  return validDailyAnswer(old, slot, scope) && validDailyAnswer(next, slot, scope)
    && followsDailyAnswerMetadata(projectDailyAnswerMetadata(old), projectDailyAnswerMetadata(next), slot, scope)
    && (old.version !== next.version || old.contentState !== 'active' || next.contentState !== 'active' || old.text === next.text);
}
/** Only a validated full own answer unlocks today's partner answer. Metadata is not read authority. */
export function canReadDailyAnswer(target: unknown, own: unknown, slot: DailySlot, scope: DailyScope, trustedNow: string): boolean {
  if (!validDailySlot(slot, scope) || !instant(trustedNow) || !validDailyAnswer(target, slot, scope)
    || target.contentState !== 'active' || trustedNow < target.editedAt) return false;
  if (own !== null && (!validDailyAnswer(own, slot, scope) || own.authorId !== scope.userId
    || trustedNow < (own.removedAt ?? own.editedAt))) return false;
  const today = localDay(trustedNow, slot.timezone);
  if (today < slot.day) return false;
  if (target.authorId === scope.userId || today > slot.day) return true;
  return own !== null && validDailyAnswer(own, slot, scope) && own.contentState === 'active';
}
