import type { AuthorizedDatabase, Principal, SqlExecutor } from './contracts.ts';
import { activeSession } from './session.ts';
import { isEpoch, isUuid } from './validation.ts';

type Member = { user_id: string; status: string };
export type LockedPair = { status: string; epoch: number; members: Member[] };
export type CloseFailure = 'unavailable' | 'stale_membership' | 'unauthenticated';

/** Discover without authority; lock ALL historical domain users in UUID order before auth/couple.
 * Never upgrade an actor SHARE lock after taking provider or pair locks. */
export async function lockPair(tx: SqlExecutor, db: AuthorizedDatabase, principal: Principal,
  coupleId: string): Promise<LockedPair | CloseFailure> {
  const members = () => tx.query<Member>('SELECT user_id, status FROM couple_members WHERE couple_id=$1 ORDER BY user_id', [coupleId]);
  const discovered = (await members()).rows;
  if (!discovered.some(row => row.user_id === principal.userId)) return 'unavailable';
  if (discovered.some(row => !isUuid(row.user_id) || !['active', 'revoked'].includes(row.status))) throw new Error('invalid_pair_data');
  for (const row of discovered) {
    const locked = await tx.query<{ id: string }>('SELECT id FROM users WHERE id=$1 FOR UPDATE', [row.user_id]);
    if (locked.rows.length !== 1 || locked.rows[0].id !== row.user_id) return 'unavailable';
  }
  if (!await activeSession(tx, db, principal)) return 'unauthenticated';
  const pairs = await tx.query<{ status: string; membership_epoch: number }>(
    'SELECT status, membership_epoch FROM couples WHERE id=$1 FOR UPDATE', [coupleId]);
  const current = (await members()).rows;
  // A newly discovered member would require a different lock order. Do not follow it.
  if (current.map(row => row.user_id).join() !== discovered.map(row => row.user_id).join()) return 'unavailable';
  if (!await activeSession(tx, db, principal)) return 'unauthenticated';
  const pair = pairs.rows[0];
  if (pairs.rows.length !== 1 || !['active', 'closed', 'waiting_partner'].includes(pair.status)
    || !isEpoch(pair.membership_epoch) || current.some(row => !['active', 'revoked'].includes(row.status))) throw new Error('invalid_pair_data');
  return { status: pair.status, epoch: pair.membership_epoch, members: current };
}

export function canClose(pair: LockedPair, userId: string, epoch: number): Exclude<CloseFailure, 'unauthenticated'> | null {
  const active = pair.members.filter(row => row.status === 'active');
  if (pair.status !== 'active' || active.length !== 2 || !active.some(row => row.user_id === userId)) return 'unavailable';
  if (pair.epoch !== epoch) return 'stale_membership';
  return isEpoch(epoch + 1) ? null : 'unavailable';
}

/** Shared by the HTTP command and legacy internal entry. Records are retained, never archived/deleted. */
export async function mutateClosedPair(tx: SqlExecutor, coupleId: string): Promise<void> {
  await tx.query("UPDATE couples SET status = 'closed', membership_epoch = membership_epoch + 1 WHERE id = $1", [coupleId]);
  await tx.query("UPDATE couple_members SET status = 'revoked' WHERE couple_id = $1", [coupleId]);
  await tx.query(`UPDATE pair_invites SET revoked_at=GREATEST(clock_timestamp(),created_at)
    WHERE couple_id=$1 AND revoked_at IS NULL AND consumed_at IS NULL`, [coupleId]);
  await tx.query("INSERT INTO outbox_events(couple_id, type, created_at) VALUES ($1, 'couple.closed', clock_timestamp())", [coupleId]);
}
