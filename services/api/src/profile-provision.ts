import type { Database, SqlExecutor } from './contracts.ts';
import { createBetterAuthSessionVerifier, recheckBetterAuthSession,
  type BetterAuthAuthorityOptions, type VerifiedBetterAuthSession } from './better-auth-session.ts';
import { isUuid } from './validation.ts';

export type ProvisionedProfile = Readonly<{ sessionId: string; userId: string; created: boolean }>;
type Outcome = { state: 'complete'; value: ProvisionedProfile }
  | { state: 'retry'; userId: string } | { state: 'unauthenticated' | 'profile_unavailable' };
const response = (status: number, body: unknown) => Response.json(body, { status,
  headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    ...(status === 405 ? { allow: 'POST' } : {}) } });
const failure = (status: number, error: string) => response(status, { ok: false, error });

function optionalId(rows: { [field: string]: unknown }[], field: string): string | null {
  if (rows.length === 0) return null;
  if (rows.length !== 1 || !isUuid(rows[0][field])) throw new Error('invalid_profile_data');
  return rows[0][field];
}

async function provision(tx: SqlExecutor, session: VerifiedBetterAuthSession, expected?: string): Promise<Outcome> {
  const unavailable = { state: 'profile_unavailable' } as const;
  const unauthenticated = { state: 'unauthenticated' } as const;
  const mapping = (lock: boolean) => tx.query<{ user_id: string }>(`
    SELECT user_id FROM better_auth_identities WHERE auth_user_id=$1${lock ? ' FOR SHARE' : ''}`, [session.authUserId]);
  // Unlocked discovery must precede domain user → provider user/session → mapping locks.
  const candidate = optionalId((await mapping(false)).rows, 'user_id');
  if (expected !== undefined && candidate !== expected) return unavailable;
  if (candidate) {
    const user = await tx.query<{ deleted_at: string | null }>('SELECT deleted_at FROM users WHERE id=$1 FOR SHARE', [candidate]);
    if (user.rows.length !== 1 || user.rows[0].deleted_at !== null) return unavailable;
  }
  // Exclusive provider-user lock serializes even DIFFERENT sessions of the same account.
  if (!await recheckBetterAuthSession(tx, session, 'exclusive')) return unauthenticated;
  const current = optionalId((await mapping(true)).rows, 'user_id');
  if (candidate !== current) {
    // This transaction has not written. Never take a new domain-user lock out of order.
    if (!candidate && current) return { state: 'retry', userId: current };
    return unavailable;
  }
  // Mapping-lock waits can cross expiry. Recheck after every potentially contended read lock.
  if (!await recheckBetterAuthSession(tx, session)) return unauthenticated;
  if (current) return { state: 'complete', value: { sessionId: session.sessionId, userId: current, created: false } };
  const userId = optionalId((await tx.query<{ id: string }>('INSERT INTO users(id) VALUES(gen_random_uuid()) RETURNING id')).rows, 'id');
  if (!userId) throw new Error('invalid_profile_data');
  const inserted = await tx.query<{ user_id: string }>(`
    INSERT INTO better_auth_identities(auth_user_id,user_id) VALUES($1,$2) RETURNING user_id`, [session.authUserId, userId]);
  // No UPSERT or reassignment. Any failure throws, rolling back BOTH new rows.
  if (optionalId(inserted.rows, 'user_id') !== userId) throw new Error('invalid_profile_data');
  return { state: 'complete', value: { sessionId: session.sessionId, userId, created: true } };
}

/** Internal synthetic-only composition entry. Caller bounds request bytes/time before dispatch. */
export function createProfileProvisionHandler(db: Database, options: BetterAuthAuthorityOptions): (request: Request) => Promise<Response> {
  const verify = createBetterAuthSessionVerifier(db, options);
  return async request => {
    try {
      const url = new URL(request.url);
      if (url.pathname !== '/v1/profile') return failure(404, 'not_found');
      if (request.method !== 'POST') return failure(405, 'method_not_allowed');
      if (url.search) return failure(400, 'invalid_request');
      if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        return failure(415, 'unsupported_media_type');
      }
      let body: unknown;
      try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await request.arrayBuffer())); }
      catch { return failure(400, 'invalid_request'); }
      if (typeof body !== 'object' || body === null || Array.isArray(body) || Object.keys(body).length !== 0) {
        return failure(400, 'invalid_request');
      }
      const session = await verify(request);
      if (!session) return failure(401, 'unauthenticated');
      let result = await db.transaction(tx => provision(tx, session));
      if (result.state === 'retry') {
        const expected = result.userId;
        result = await db.transaction(tx => provision(tx, session, expected));
      }
      if (result.state === 'retry') throw new Error('profile_changed');
      if (result.state !== 'complete') return failure(result.state === 'unauthenticated' ? 401 : 409, result.state);
      return response(result.value.created ? 201 : 200, { ok: true, value: result.value });
    } catch { return failure(503, 'temporarily_unavailable'); }
  };
}
