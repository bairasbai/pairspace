import { createDailyAnswerMetadata, followsDailyAnswerMetadata, rewriteDailyAnswerMetadata,
  removeDailyAnswerMetadata, validDailyAnswerMetadata, type DailyAnswerMetadata } from '../../../../packages/domain/daily-question/metadata';
import { validDailySlot, type DailySlot, type DailyScope } from '../../../../packages/domain/daily-question/slot';
import { instant } from '../../../../packages/domain/daily-question/validation';
import { sameDailySlot, type DailyAck } from './daily-questions-state';
export type DailyProofCommand = Readonly<{ kind: 'create' | 'rewrite' | 'remove'; base: DailyAnswerMetadata | null;
  slot: DailySlot | null; expectedDay: string; floor: string | null; knownIds: readonly string[] }>;
/** Reconstruct a possible original metadata result. Further edits may replace editedAt;
 * current replay remains valid if an intermediate confirmed rewrite was reachable.
 */
export function provesDailyCommand(command: DailyProofCommand, ack: DailyAck, scope: DailyScope): boolean {
  const { slot, answer: current, replay } = ack;
  if (!validDailySlot(slot, scope) || !validDailyAnswerMetadata(current, slot, scope)
    || (command.floor !== null && !instant(command.floor))
    || (command.slot !== null && (!validDailySlot(command.slot, scope) || !sameDailySlot(command.slot, slot)))) return false;
  let applied: DailyAnswerMetadata | null;
  if (command.kind === 'create') {
    if (slot.day !== command.expectedDay || command.knownIds.includes(current.id)
      || (command.floor !== null && current.createdAt < command.floor)) return false;
    applied = createDailyAnswerMetadata({ id: current.id }, slot, scope, current.createdAt, true);
  } else {
    if (!command.base || !command.slot || command.floor === null) return false;
    if (command.kind === 'remove') {
      if (current.removedAt === null || current.removedAt < command.floor) return false;
      applied = removeDailyAnswerMetadata(command.base, slot, scope, current.removedAt, command.base.version, true);
    } else {
      const exactEdit = current.version === command.base.version + 1
        || (current.contentState === 'removed' && current.version === command.base.version + 2);
      const at = exactEdit ? current.editedAt : command.floor;
      if (at < command.floor) return false;
      applied = rewriteDailyAnswerMetadata(command.base, slot, scope, at, command.base.version, true);
    }
  }
  return applied !== null && followsDailyAnswerMetadata(applied, current, slot, scope)
    && (replay || followsDailyAnswerMetadata(current, applied, slot, scope));
}
