import type { Database, Principal, SqlExecutor } from './contracts.ts';
import type { SessionAuthority } from './auth-authority.ts';
import { createBetterAuthSessionVerifier, recheckBetterAuthSession, type BetterAuthAuthorityOptions } from './better-auth-session.ts';
import { isUuid } from './validation.ts';

export type { BetterAuthSessionReader, BetterAuthAuthorityOptions } from './better-auth-session.ts';

export function createBetterAuthAuthority(db: Database, options: BetterAuthAuthorityOptions): SessionAuthority {
  const verify = createBetterAuthSessionVerifier(db, options);
  return {
    source: 'better-auth',
    async authenticate(request) {
      const session = await verify(request);
      if (!session) return null;
      const mapped = await db.transaction(tx => tx.query<{ user_id: string }>(`
        SELECT i.user_id FROM better_auth_identities i JOIN users u ON u.id=i.user_id
        WHERE i.auth_user_id=$1 AND u.deleted_at IS NULL`, [session.authUserId]));
      if (mapped.rows.length !== 1 || !isUuid(mapped.rows[0].user_id)) return null;
      return { source: 'better-auth', userId: mapped.rows[0].user_id, ...session };
    },
    recheck: (tx, _db, principal) => recheck(tx, principal),
  };
}

async function recheck(tx: SqlExecutor, principal: Principal): Promise<boolean> {
  if (principal.source !== 'better-auth') return false;
  const user = await tx.query<{ deleted_at: string | null }>('SELECT deleted_at FROM users WHERE id=$1 FOR SHARE', [principal.userId]);
  if (user.rows.length !== 1 || user.rows[0].deleted_at !== null) return false;
  if (!await recheckBetterAuthSession(tx, principal)) return false;
  const identity = await tx.query<{ user_id: string }>(`
    SELECT user_id FROM better_auth_identities WHERE auth_user_id=$1 AND user_id=$2 FOR SHARE`,
  [principal.authUserId, principal.userId]);
  return identity.rows.length === 1 && identity.rows[0].user_id === principal.userId;
}
