import type { SqlExecutor } from './contracts.ts';
import { lockedBetterAuthSessionTime, type VerifiedBetterAuthSession } from './better-auth-session.ts';
import { invitationMetadata, optionalId } from './pair-invitation-state.ts';
import { providerIdentifier } from './session.ts';
import { isEpoch, isUuid } from './validation.ts';

export type AcceptanceInvite = {
  id: string; command_id: string; couple_id: string; issuer_user_id: string; token_hash: string;
  created_at: string; expires_at: string; revoked_at: string | null; consumed_at: string | null;
  consumed_by_user_id: string | null;
};
export const acceptanceColumns = `id, command_id, couple_id, issuer_user_id, token_hash,
  created_at::text, expires_at::text, revoked_at::text, consumed_at::text, consumed_by_user_id`;
export type AcceptanceFailure = { state: 'unauthenticated' | 'profile_unavailable' | 'invitation_unavailable' };
export type AcceptanceLock = {
  state: 'locked'; userId: string; invite: AcceptanceInvite; epoch: number; now: number; replayed: boolean;
};
const unavailable: AcceptanceFailure = { state: 'invitation_unavailable' };
const profile: AcceptanceFailure = { state: 'profile_unavailable' };
const unauthenticated: AcceptanceFailure = { state: 'unauthenticated' };
export const invalidAcceptance = (): never => { throw new Error('invalid_invitation_data'); };

function candidate(rows: AcceptanceInvite[]): AcceptanceInvite | null {
  if (!rows.length) return null;
  const row = rows[0];
  if (rows.length !== 1 || !isUuid(row.id) || !isUuid(row.couple_id) || !isUuid(row.issuer_user_id)
    || typeof row.token_hash !== 'string' || !/^[0-9a-f]{64}$/.test(row.token_hash)) invalidAcceptance();
  return row;
}
function ownerMapping(rows: { auth_user_id: string }[]): string | null {
  if (!rows.length) return null;
  if (rows.length !== 1 || !providerIdentifier(rows[0].auth_user_id)) invalidAcceptance();
  return rows[0].auth_user_id;
}
function membershipCount(row: Record<string, unknown>, field: string): number {
  const count = row[field];
  if (!Number.isSafeInteger(count) || Number(count) < 0) invalidAcceptance();
  return count as number;
}

/** Both domain users, sorted UUID order, precede EVERY provider/session/mapping/couple/invite lock. */
export async function lockInvitation(tx: SqlExecutor, session: VerifiedBetterAuthSession,
  hash: string, preview: boolean): Promise<AcceptanceLock | AcceptanceFailure> {
  const mapping = (lock: boolean) => tx.query<{ user_id: string }>(`
    SELECT user_id FROM better_auth_identities WHERE auth_user_id=$1${lock ? ' FOR SHARE' : ''}`, [session.authUserId]);
  const userId = optionalId((await mapping(false)).rows, 'user_id');
  if (!userId) return profile;
  const discover = candidate((await tx.query<AcceptanceInvite>(`
    SELECT ${acceptanceColumns} FROM pair_invites WHERE token_hash=$1`, [hash])).rows);
  if (!discover || discover.token_hash !== hash || discover.issuer_user_id === userId) return unavailable;
  const owner = (lock: boolean) => tx.query<{ auth_user_id: string }>(`
    SELECT auth_user_id FROM better_auth_identities WHERE user_id=$1${lock ? ' FOR SHARE' : ''}`, [discover.issuer_user_id]);
  const authOwner = ownerMapping((await owner(false)).rows);
  if (!authOwner) return unavailable;
  for (const id of [userId, discover.issuer_user_id].sort()) {
    const users = await tx.query<{ deleted_at: string | null }>('SELECT deleted_at FROM users WHERE id=$1 FOR UPDATE', [id]);
    if (users.rows.length !== 1 || users.rows[0].deleted_at !== null) return id === userId ? profile : unavailable;
  }
  // Issuer provider identity is required, but an issuer session/logout is irrelevant to an issued invite.
  const provider = await tx.query<{ id: string }>('SELECT id FROM "user" WHERE id=$1 FOR SHARE', [authOwner]);
  if (provider.rows.length !== 1 || provider.rows[0].id !== authOwner) return unavailable;
  if (await lockedBetterAuthSessionTime(tx, session) === null) return unauthenticated;
  if (optionalId((await mapping(true)).rows, 'user_id') !== userId) return profile;
  if (ownerMapping((await owner(true)).rows) !== authOwner) return unavailable;
  const couples = await tx.query<{ status: string; membership_epoch: number }>(`
    SELECT status, membership_epoch FROM couples WHERE id=$1 FOR UPDATE`, [discover.couple_id]);
  const invite = candidate((await tx.query<AcceptanceInvite>(`
    SELECT ${acceptanceColumns} FROM pair_invites WHERE token_hash=$1 FOR UPDATE`, [hash])).rows);
  // Never follow a changed target discovered while waiting for any preceding lock.
  if (!invite || invite.id !== discover.id || invite.couple_id !== discover.couple_id
    || invite.issuer_user_id !== discover.issuer_user_id || invite.token_hash !== hash) return unavailable;
  const now = await lockedBetterAuthSessionTime(tx, session);
  if (now === null) return unauthenticated;
  const metadata = invitationMetadata([{ ...invite, owned: true }], now)!;
  if ((invite.consumed_at === null) !== (invite.consumed_by_user_id === null)
    || (invite.consumed_by_user_id !== null && (!isUuid(invite.consumed_by_user_id)
      || invite.consumed_by_user_id === invite.issuer_user_id))) invalidAcceptance();
  if (metadata.status === 'revoked' || metadata.status === 'expired') return unavailable;
  const replayed = metadata.status === 'consumed';
  if (replayed && (preview || invite.consumed_by_user_id !== userId)) return unavailable;
  const couple = couples.rows[0];
  if (couples.rows.length !== 1 || !['active', 'closed', 'waiting_partner'].includes(couple.status)
    || !isEpoch(couple.membership_epoch)) invalidAcceptance();
  if (couple.status !== (replayed ? 'active' : 'waiting_partner')) return unavailable;
  const ownerMembership = await tx.query<{ couple_id: string }>(`
    SELECT couple_id FROM couple_members WHERE user_id=$1 AND status='active'`, [invite.issuer_user_id]);
  if (optionalId(ownerMembership.rows, 'couple_id') !== invite.couple_id) return unavailable;
  // A historical target tuple must never be resurrected. A live slot anywhere also prevents a new join.
  const recipient = await tx.query<{ couple_id: string; slot: number; status: string }>(`
    SELECT couple_id, slot, status FROM couple_members WHERE user_id=$1 AND (status='active' OR couple_id=$2)`,
  [userId, invite.couple_id]);
  for (const row of recipient.rows) {
    if (!isUuid(row.couple_id) || ![1, 2].includes(row.slot) || !['active', 'revoked'].includes(row.status)) invalidAcceptance();
  }
  if (replayed ? recipient.rows.length !== 1 || recipient.rows[0].couple_id !== invite.couple_id
    || recipient.rows[0].slot !== 2 || recipient.rows[0].status !== 'active' : recipient.rows.length !== 0) return unavailable;
  const counts = await tx.query<Record<string, unknown>>(`
    SELECT count(*)::int AS active_count,
      count(*) FILTER (WHERE user_id=$2 AND slot=1)::int AS issuer_count,
      count(*) FILTER (WHERE user_id=$3 AND slot=2)::int AS recipient_count
    FROM couple_members WHERE couple_id=$1 AND status='active'`, [invite.couple_id, invite.issuer_user_id, userId]);
  if (counts.rows.length !== 1) invalidAcceptance();
  const active = membershipCount(counts.rows[0], 'active_count');
  const issuer = membershipCount(counts.rows[0], 'issuer_count');
  const joined = membershipCount(counts.rows[0], 'recipient_count');
  if (issuer > active || joined > active || issuer + joined > active) invalidAcceptance();
  if (active !== (replayed ? 2 : 1) || issuer !== 1 || joined !== (replayed ? 1 : 0)) return unavailable;
  // Keep the resulting epoch inside the shared application's valid PostgreSQL-int range.
  if (!replayed && !isEpoch(couple.membership_epoch + 1)) return unavailable;
  return { state: 'locked', userId, invite, epoch: couple.membership_epoch, now, replayed };
}
