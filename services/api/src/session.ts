import type { Database, Principal, SqlExecutor } from './contracts.ts';
import { isUuid } from './validation.ts';

export const validPrincipal = (principal: Principal) => isUuid(principal.userId)
  && isUuid(principal.sessionId) && Number.isSafeInteger(principal.tokenExpiresAt) && principal.tokenExpiresAt > 0;

/** Authoritative transaction check. All account/session revokers must use user → session lock order. */
export async function activeSession(tx: SqlExecutor, db: Database, principal: Principal): Promise<boolean> {
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
