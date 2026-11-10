import type { Database, SqlExecutor } from './contracts.ts';
import { createBetterAuthSessionVerifier, recheckBetterAuthSession,
  type BetterAuthAuthorityOptions, type VerifiedBetterAuthSession } from './better-auth-session.ts';
import { isOwnWaitingSpace } from './waiting-space-state.ts';
import { isEpoch, isUuid } from './validation.ts';

export type WaitingSpace = Readonly<{
  sessionId: string; userId: string; coupleId: string; membershipEpoch: number; created: boolean;
}>;
type Outcome = { state: 'complete'; value: WaitingSpace }
  | { state: 'unauthenticated' | 'profile_unavailable' | 'space_unavailable' };
const response = (status: number, body: unknown) => Response.json(body, { status,
  headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    ...(status === 405 ? { allow: 'POST' } : {}) } });
const failure = (status: number, error: string) => response(status, { ok: false, error });
function optionalId(rows: { [field: string]: unknown }[], field: string): string | null {
  if (rows.length === 0) return null;
  if (rows.length !== 1 || !isUuid(rows[0][field])) throw new Error('invalid_waiting_space_data');
  return rows[0][field];
}

async function createWaiting(tx: SqlExecutor, session: VerifiedBetterAuthSession): Promise<Outcome> {
  const unavailable = { state: 'space_unavailable' } as const;
  const unauthenticated = { state: 'unauthenticated' } as const;
  const profileUnavailable = { state: 'profile_unavailable' } as const;
  const mapping = (lock: boolean) => tx.query<{ user_id: string }>(`
    SELECT user_id FROM better_auth_identities WHERE auth_user_id=$1${lock ? ' FOR SHARE' : ''}`, [session.authUserId]);
  const userId = optionalId((await mapping(false)).rows, 'user_id');
  if (!userId) return profileUnavailable;
  // Serialize even DISTINCT provider sessions before any provider/mapping/couple locks.
  const user = await tx.query<{ deleted_at: string | null }>('SELECT deleted_at FROM users WHERE id=$1 FOR UPDATE', [userId]);
  if (user.rows.length !== 1 || user.rows[0].deleted_at !== null) return profileUnavailable;
  if (!await recheckBetterAuthSession(tx, session)) return unauthenticated;
  if (optionalId((await mapping(true)).rows, 'user_id') !== userId) return profileUnavailable;
  if (!await recheckBetterAuthSession(tx, session)) return unauthenticated;
  const memberships = () => tx.query<{ couple_id: string }>(`
    SELECT couple_id FROM couple_members WHERE user_id=$1 AND status='active'`, [userId]);
  const candidate = optionalId((await memberships()).rows, 'couple_id');
  if (candidate) {
    const couples = await tx.query<{ status: string; membership_epoch: number }>(`
      SELECT status, membership_epoch FROM couples WHERE id=$1 FOR UPDATE`, [candidate]);
    // Fresh snapshot after a contended couple lock: never follow a replacement membership.
    if (optionalId((await memberships()).rows, 'couple_id') !== candidate) return unavailable;
    if (!await recheckBetterAuthSession(tx, session)) return unauthenticated;
    const couple = couples.rows[0];
    if (couples.rows.length !== 1 || !['active', 'closed', 'waiting_partner'].includes(couple.status)
      || !isEpoch(couple.membership_epoch)) throw new Error('invalid_waiting_space_data');
    if (couple.status !== 'waiting_partner' || !await isOwnWaitingSpace(tx, candidate, userId)) return unavailable;
    return { state: 'complete', value: { sessionId: session.sessionId, userId,
      coupleId: candidate, membershipEpoch: couple.membership_epoch, created: false } };
  }
  // Session time is checked immediately before mutation, after all contended read locks.
  if (!await recheckBetterAuthSession(tx, session)) return unauthenticated;
  const coupleId = optionalId((await tx.query<{ id: string }>(`
    INSERT INTO couples(id,status,membership_epoch) VALUES(gen_random_uuid(),'waiting_partner',1) RETURNING id`)).rows, 'id');
  if (!coupleId) throw new Error('invalid_waiting_space_data');
  const inserted = await tx.query<{ couple_id: string }>(`
    INSERT INTO couple_members(couple_id,user_id,slot,status) VALUES($1,$2,1,'active') RETURNING couple_id`, [coupleId, userId]);
  // Any failed/malformed insert throws, rolling back both rows; never clean up or bypass a live slot.
  if (optionalId(inserted.rows, 'couple_id') !== coupleId) throw new Error('invalid_waiting_space_data');
  return { state: 'complete', value: { sessionId: session.sessionId, userId, coupleId, membershipEpoch: 1, created: true } };
}

/** Internal synthetic-only composition entry. Caller bounds request bytes/time before dispatch. */
export function createWaitingSpaceHandler(db: Database, options: BetterAuthAuthorityOptions): (request: Request) => Promise<Response> {
  const verify = createBetterAuthSessionVerifier(db, options);
  return async request => {
    try {
      const url = new URL(request.url);
      if (url.pathname !== '/v1/spaces/waiting') return failure(404, 'not_found');
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
      const result = await db.transaction(tx => createWaiting(tx, session));
      if (result.state !== 'complete') return failure(result.state === 'unauthenticated' ? 401 : 409, result.state);
      return response(result.value.created ? 201 : 200, { ok: true, value: result.value });
    } catch { return failure(503, 'temporarily_unavailable'); }
  };
}
