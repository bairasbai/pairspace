import { createDisputeMetadata, declineDisputeMetadata, followsDisputeMetadata, joinDisputeMetadata,
  removeDisputeMetadata, resolveDisputeMetadata, validDisputeMetadata, type DisputeMetadata,
  type DisputeScope } from '../../../../packages/domain/disputes/metadata';
import { instant } from '../../../../packages/domain/disputes/validation';
export type DisputeProofCommand = Readonly<{
  kind: 'create' | 'join' | 'decline' | 'resolve' | 'remove'; base: DisputeMetadata | null;
  judgeDate: string; timezone: string; winnerId: string | null; floor: string | null; knownIds: readonly string[];
}>;
/** Each operation leaves an immutable event timestamp in CURRENT metadata, even after
 * later transitions or removal. Reconstruct only its metadata result, never its body.
 */
export function provesDisputeCommand(command: DisputeProofCommand, current: DisputeMetadata,
  replay: boolean, scope: DisputeScope): boolean {
  if (!validDisputeMetadata(current, scope) || (command.floor !== null && !instant(command.floor))) return false;
  let applied: DisputeMetadata | null;
  if (command.kind === 'create') {
    if (command.knownIds.includes(current.id) || (command.floor !== null && current.createdAt < command.floor)) return false;
    applied = createDisputeMetadata({ id: current.id, recipientId: current.recipientId,
      judgeDate: command.judgeDate, timezone: command.timezone }, scope, current.createdAt, true);
  } else {
    const base = command.base;
    if (!base || command.floor === null) return false;
    const at = command.kind === 'join' ? current.joinedAt : command.kind === 'decline' ? current.declinedAt
      : command.kind === 'resolve' ? current.resolvedAt : current.removedAt;
    if (at === null || at < command.floor) return false;
    applied = command.kind === 'join' ? joinDisputeMetadata(base, scope, at, base.version, true)
      : command.kind === 'decline' ? declineDisputeMetadata(base, scope, at, base.version, true)
        : command.kind === 'resolve' ? resolveDisputeMetadata(base, scope, at, base.version, command.winnerId, true)
          : removeDisputeMetadata(base, scope, at, base.version, true);
  }
  return applied !== null && followsDisputeMetadata(applied, current, scope)
    && (replay || followsDisputeMetadata(current, applied, scope));
}
