import type { AuthorizedDatabase, Principal } from './contracts.ts';
import { canClose, lockPair, mutateClosedPair } from './pair-close.ts';
import { validPrincipal } from './session.ts';
import { isEpoch, isUuid } from './validation.ts';

export type LeaveCommand = Readonly<{ commandId: string; coupleId: string; membershipEpoch: number; confirm: true }>;
export type LeaveValue = Readonly<{ state: 'closed'; sessionId: string; userId: string;
  coupleId: string; membershipEpoch: number; commandId: string; replayed: boolean }>;
type Outcome = { ok: true; value: LeaveValue }
  | { ok: false; error: 'invalid_request' | 'unauthenticated' | 'pair_unavailable' };
const fail = (error: 'invalid_request' | 'unauthenticated' | 'pair_unavailable'): Outcome => ({ ok: false, error });
export function parseLeave(input: unknown): LeaveCommand | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (Object.keys(value).sort().join(',') !== 'commandId,confirm,coupleId,membershipEpoch'
    || value.confirm !== true || !isUuid(value.commandId) || !isUuid(value.coupleId)
    || !isEpoch(value.membershipEpoch) || !isEpoch(value.membershipEpoch + 1)) return null;
  return { commandId: value.commandId.toLowerCase(), coupleId: value.coupleId.toLowerCase(),
    membershipEpoch: value.membershipEpoch, confirm: true };
}

/** Caller identity is independently authenticated; pair/epoch are confirmation preconditions only. */
export async function leavePair(db: AuthorizedDatabase, principal: Principal, input: unknown): Promise<Outcome> {
  if (!validPrincipal(principal)) return fail('unauthenticated');
  const command = parseLeave(input);
  if (!command) return fail('invalid_request');
  return db.transaction(async tx => {
    const pair = await lockPair(tx, db, principal, command.coupleId);
    if (typeof pair === 'string') return fail(pair === 'unauthenticated' ? pair : 'pair_unavailable');
    // The actor UPDATE lock serializes command IDs across different historical pairs.
    const receipt = await tx.query<{ couple_id: string; membership_epoch: number }>(`
      SELECT couple_id,membership_epoch FROM pair_leave_commands
      WHERE actor_user_id=$1 AND command_id=$2`, [principal.userId, command.commandId]);
    const previous = receipt.rows[0];
    if (receipt.rows.length > 1) throw new Error('invalid_pair_receipt');
    if (previous && (previous.couple_id !== command.coupleId || previous.membership_epoch !== command.membershipEpoch)) return fail('pair_unavailable');
    const closed = pair.status === 'closed' && pair.epoch === command.membershipEpoch + 1
      && pair.members.every(member => member.status === 'revoked');
    if (previous && !closed) return fail('pair_unavailable');
    if (!previous) {
      if (closed) {
        // Concurrent partner leave or legacy closure: require a verified exact historical event.
        const event = await tx.query<{ couple_id: string }>(
          "SELECT couple_id FROM outbox_events WHERE couple_id=$1 AND type='couple.closed'", [command.coupleId]);
        if (event.rows.length !== 1 || event.rows[0].couple_id !== command.coupleId) return fail('pair_unavailable');
      } else {
        if (canClose(pair, principal.userId, command.membershipEpoch)) return fail('pair_unavailable');
        await mutateClosedPair(tx, command.coupleId);
      }
      // All receipts describe the SAME closure instant, not when this actor retried.
      const inserted = await tx.query<{ command_id: string }>(`
        INSERT INTO pair_leave_commands(actor_user_id,command_id,couple_id,membership_epoch,closed_at)
        SELECT $1,$2,$3,$4,created_at FROM outbox_events WHERE couple_id=$3 AND type='couple.closed'
        RETURNING command_id`, [principal.userId, command.commandId, command.coupleId, command.membershipEpoch]);
      if (inserted.rows.length !== 1 || inserted.rows[0].command_id !== command.commandId) throw new Error('invalid_pair_receipt');
    }
    return { ok: true, value: { state: 'closed', sessionId: principal.sessionId, userId: principal.userId,
      coupleId: command.coupleId, membershipEpoch: command.membershipEpoch, commandId: command.commandId, replayed: !!previous || closed } };
  });
}
