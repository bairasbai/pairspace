import { followsCapsule, parseCapsuleSchedule, removeCapsule, resealCapsule, type Capsule, type CapsuleScope } from '../../../../packages/domain/capsules/policy';
import type { CapsuleScheduleInput } from './capsules-state';
type ProofCommand = Readonly<{ kind: 'create' | 'reseal' | 'remove'; base: Capsule | null;
  schedule: CapsuleScheduleInput | null; floor: string | null; knownIds: readonly string[] }>;
/** Reconstruct a possible original metadata-only result, not an old text or current schedule.
 * For multi-step replay, the receipt may predate later reseals. The server independently
 * proves its stored receipt; this client additionally rejects impossible transitions.
 */
export function provesCapsuleCommand(command: ProofCommand, current: Capsule, replay: boolean, scope: CapsuleScope): boolean {
  let applied: Capsule | null;
  if (command.kind === 'create') {
    const schedule = parseCapsuleSchedule(command.schedule, current.createdAt);
    if (!schedule || command.knownIds.includes(current.id) || (command.floor !== null && current.createdAt < command.floor)) return false;
    applied = { ...current, ...schedule, sealedAt: current.createdAt, version: 1, contentState: 'active' };
  } else {
    const base = command.base!;
    if (command.floor === null) return false;
    if (command.kind === 'remove') applied = removeCapsule(base, scope, command.floor, base.version, true);
    else {
      // One reseal, optionally followed by removal, retains the operation's sealing time.
      // With further reseals only existence of a compatible intermediate can be checked.
      const exactSeal = current.version === base.version + 1
        || (current.contentState === 'removed' && current.version === base.version + 2);
      const sealedAt = exactSeal ? current.sealedAt : command.floor;
      if (sealedAt < command.floor) return false;
      applied = resealCapsule(base, scope, sealedAt, base.version, command.schedule, true);
    }
  }
  return applied !== null && followsCapsule(applied, current, scope) && (replay || followsCapsule(current, applied, scope));
}
