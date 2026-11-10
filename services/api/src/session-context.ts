import type { Database, SqlExecutor } from './contracts.ts';
import { createBetterAuthSessionVerifier, recheckBetterAuthSession,
  type BetterAuthAuthorityOptions, type VerifiedBetterAuthSession } from './better-auth-session.ts';
import { isEpoch, isUuid } from './validation.ts';

/** Discovery snapshots only. Chat independently rechecks identity, pair and epoch. */
export type SessionContext = Readonly<
  { state: 'unmapped'; sessionId: string }
  | { state: 'no_active_pair'; sessionId: string; userId: string }
  | { state: 'ready'; sessionId: string; userId: string; coupleId: string; membershipEpoch: number }
>;
const response = (status: number, body: unknown) => Response.json(body, { status,
  headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    ...(status === 405 ? { allow: 'GET' } : {}) } });
const failure = (status: number, error: string) => response(status, { ok: false, error });

function optionalId(rows: { [field: string]: unknown }[], field: string): string | null {
  if (rows.length === 0) return null;
  if (rows.length !== 1 || !isUuid(rows[0][field])) throw new Error('invalid_context_data');
  return rows[0][field];
}

async function activePair(tx: SqlExecutor, userId: string, sessionId: string): Promise<SessionContext> {
  const absent = { state: 'no_active_pair', sessionId, userId } as const;
  const memberships = () => tx.query<{ couple_id: string }>(`
    SELECT couple_id FROM couple_members WHERE user_id=$1 AND status='active'`, [userId]);
  const candidate = optionalId((await memberships()).rows, 'couple_id');
  if (!candidate) return absent;
  const couples = await tx.query<{ status: string; membership_epoch: number }>(`
    SELECT status, membership_epoch FROM couples WHERE id=$1 FOR SHARE`, [candidate]);
  // After acquiring the couple lock, use a fresh READ COMMITTED membership snapshot.
  const current = optionalId((await memberships()).rows, 'couple_id');
  if (current !== candidate) {
    if (current === null) return absent;
    throw new Error('context_changed');
  }
  const couple = couples.rows[0];
  if (couples.rows.length !== 1 || !['active', 'closed', 'waiting_partner'].includes(couple.status)
    || !isEpoch(couple.membership_epoch)) throw new Error('invalid_context_data');
  if (couple.status !== 'active') return absent;
  return { state: 'ready', sessionId, userId, coupleId: candidate, membershipEpoch: couple.membership_epoch };
}

async function discover(tx: SqlExecutor, session: VerifiedBetterAuthSession): Promise<SessionContext | null> {
  const mapping = (lock: boolean) => tx.query<{ user_id: string }>(`
    SELECT user_id FROM better_auth_identities WHERE auth_user_id=$1${lock ? ' FOR SHARE' : ''}`, [session.authUserId]);
  // Discovery is not a lock. The order matches chat: domain user → provider user/session → mapping → couple.
  const candidate = optionalId((await mapping(false)).rows, 'user_id');
  if (candidate) {
    const user = await tx.query<{ deleted_at: string | null }>('SELECT deleted_at FROM users WHERE id=$1 FOR SHARE', [candidate]);
    if (user.rows.length !== 1 || user.rows[0].deleted_at !== null) return null;
  }
  if (!await recheckBetterAuthSession(tx, session)) return null;
  const current = optionalId((await mapping(true)).rows, 'user_id');
  // Mapping mutations are unsupported. Never silently switch domain users after taking locks.
  if (current !== candidate) return null;
  if (!current) return { state: 'unmapped', sessionId: session.sessionId };
  return activePair(tx, current, session.sessionId);
}

/** Strict read-only route: identities and pairs are selected solely by verified provider identity. */
export function createSessionContextHandler(db: Database, options: BetterAuthAuthorityOptions): (request: Request) => Promise<Response> {
  const verify = createBetterAuthSessionVerifier(db, options);
  return async request => {
    try {
      const url = new URL(request.url);
      if (url.pathname !== '/v1/session/context') return failure(404, 'not_found');
      if (request.method !== 'GET') return failure(405, 'method_not_allowed');
      const length = request.headers.get('content-length');
      if (url.search || request.body || (length !== null && length !== '0') || request.headers.has('transfer-encoding')) {
        return failure(400, 'invalid_request');
      }
      const session = await verify(request);
      if (!session) return failure(401, 'unauthenticated');
      const value = await db.transaction(tx => discover(tx, session));
      return value ? response(200, { ok: true, value }) : failure(401, 'unauthenticated');
    } catch { return failure(503, 'temporarily_unavailable'); }
  };
}
