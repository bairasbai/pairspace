import type { Database, Principal, SqlExecutor } from './contracts.ts';
import type { SessionAuthority } from './auth-authority.ts';
import type { SessionVerifier } from './http.ts';

/** Explicit prototype/test selection only. Not a production auth fallback. */
export function createSyntheticAuthority(verify: SessionVerifier): SessionAuthority {
  return {
    source: 'synthetic-jwt',
    async authenticate(request) {
      const match = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9._~-]{1,2048})$/);
      if (!match) return null;
      const principal = await verify(match[1]);
      return principal?.source === 'synthetic-jwt' ? principal : null;
    },
    async recheck(tx, db, principal) {
      return principal.source === 'synthetic-jwt' && syntheticRecheck(tx, db, principal);
    },
  };
}
/** Authoritative transaction check. All account/session revokers must use user → session lock order. */
async function syntheticRecheck(tx: SqlExecutor, db: Database, principal: Principal): Promise<boolean> {
  const user = await tx.query<{ deleted_at: string | null }>(
    'SELECT deleted_at FROM users WHERE id=$1 FOR SHARE', [principal.userId]);
  if (!user.rows[0] || user.rows[0].deleted_at !== null) return false;
  const session = await tx.query<{ revoked_at: string | null; created_at: string; expires_at: string }>(
    `SELECT revoked_at::text, created_at::text, expires_at::text FROM auth_sessions
     WHERE id=$1 AND user_id=$2 FOR SHARE`, [principal.sessionId, principal.userId]);
  const row = session.rows[0];
  if (!row || row.revoked_at !== null) return false;
  const now = db.now().getTime();
  if (!Number.isFinite(now)) throw new Error('invalid_server_clock');
  return now < principal.tokenExpiresAt * 1000 && now >= Date.parse(row.created_at) && now < Date.parse(row.expires_at);
}
