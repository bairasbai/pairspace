import type { SqlExecutor } from './contracts.ts';
import { recheckBetterAuthSession, type VerifiedBetterAuthSession } from './better-auth-session.ts';
import { isOwnWaitingSpace } from './waiting-space-state.ts';
import { isEpoch, isUuid } from './validation.ts';

export type InvitationMetadata = Readonly<{
  id: string; commandId: string; status: 'pending' | 'expired' | 'revoked' | 'consumed';
  createdAt: string; expiresAt: string; revokedAt: string | null; consumedAt: string | null;
}>;
export type InvitationRow = { id: string; command_id: string; owned: boolean;
  created_at: string; expires_at: string; revoked_at: string | null; consumed_at: string | null };
export const invitationColumns = `id, command_id, issuer_user_id=$2 AS owned,
  created_at::text, expires_at::text, revoked_at::text, consumed_at::text`;
export function optionalId(rows: { [field: string]: unknown }[], field: string): string | null {
  if (rows.length === 0) return null;
  if (rows.length !== 1 || !isUuid(rows[0][field])) throw new Error('invalid_invitation_data');
  return rows[0][field];
}
export function invitationMetadata(rows: InvitationRow[], now: number): InvitationMetadata | null {
  if (!rows.length) return null;
  const row = rows[0];
  const created = Date.parse(row.created_at), expires = Date.parse(row.expires_at);
  const revoked = row.revoked_at === null ? null : Date.parse(row.revoked_at);
  const consumed = row.consumed_at === null ? null : Date.parse(row.consumed_at);
  if (rows.length !== 1 || !isUuid(row.id) || !isUuid(row.command_id) || row.owned !== true
    || !Number.isFinite(created) || !Number.isFinite(expires) || expires <= created || created > now
    || (revoked !== null && (!Number.isFinite(revoked) || revoked < created || revoked > now))
    || (consumed !== null && (!Number.isFinite(consumed) || consumed < created || consumed >= expires || consumed > now))
    || (revoked !== null && consumed !== null)) throw new Error('invalid_invitation_data');
  return { id: row.id, commandId: row.command_id,
    status: revoked !== null ? 'revoked' : consumed !== null ? 'consumed' : expires <= now ? 'expired' : 'pending',
    createdAt: new Date(created).toISOString(), expiresAt: new Date(expires).toISOString(),
    revokedAt: revoked === null ? null : new Date(revoked).toISOString(),
    consumedAt: consumed === null ? null : new Date(consumed).toISOString() };
}
export type SpaceLock = { state: 'locked'; userId: string; coupleId: string }
  | { state: 'unauthenticated' | 'profile_unavailable' | 'space_unavailable' };

/** Never follow a changed mapping/membership; all writes use this same lock order. */
export async function lockOwnWaitingSpace(tx: SqlExecutor, session: VerifiedBetterAuthSession): Promise<SpaceLock> {
  const mapping = (lock: boolean) => tx.query<{ user_id: string }>(`
    SELECT user_id FROM better_auth_identities WHERE auth_user_id=$1${lock ? ' FOR SHARE' : ''}`, [session.authUserId]);
  const userId = optionalId((await mapping(false)).rows, 'user_id');
  if (!userId) return { state: 'profile_unavailable' };
  const users = await tx.query<{ deleted_at: string | null }>('SELECT deleted_at FROM users WHERE id=$1 FOR UPDATE', [userId]);
  if (users.rows.length !== 1 || users.rows[0].deleted_at !== null) return { state: 'profile_unavailable' };
  if (!await recheckBetterAuthSession(tx, session)) return { state: 'unauthenticated' };
  if (optionalId((await mapping(true)).rows, 'user_id') !== userId) return { state: 'profile_unavailable' };
  if (!await recheckBetterAuthSession(tx, session)) return { state: 'unauthenticated' };
  const memberships = () => tx.query<{ couple_id: string }>(`
    SELECT couple_id FROM couple_members WHERE user_id=$1 AND status='active'`, [userId]);
  const coupleId = optionalId((await memberships()).rows, 'couple_id');
  if (!coupleId) return { state: 'space_unavailable' };
  const couples = await tx.query<{ status: string; membership_epoch: number }>(`
    SELECT status, membership_epoch FROM couples WHERE id=$1 FOR UPDATE`, [coupleId]);
  if (optionalId((await memberships()).rows, 'couple_id') !== coupleId) return { state: 'space_unavailable' };
  if (!await recheckBetterAuthSession(tx, session)) return { state: 'unauthenticated' };
  const couple = couples.rows[0];
  if (couples.rows.length !== 1 || !['active', 'closed', 'waiting_partner'].includes(couple.status)
    || !isEpoch(couple.membership_epoch)) throw new Error('invalid_invitation_data');
  if (couple.status !== 'waiting_partner' || !await isOwnWaitingSpace(tx, coupleId, userId)) return { state: 'space_unavailable' };
  return { state: 'locked', userId, coupleId };
}
