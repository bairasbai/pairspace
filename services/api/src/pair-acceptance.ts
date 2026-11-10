import { createHash } from 'node:crypto';
import type { Database, SqlExecutor } from './contracts.ts';
import { createBetterAuthSessionVerifier, type BetterAuthAuthorityOptions,
  type VerifiedBetterAuthSession } from './better-auth-session.ts';
import { acceptanceColumns, invalidAcceptance, lockInvitation,
  type AcceptanceFailure, type AcceptanceInvite, type AcceptanceLock } from './pair-acceptance-state.ts';

export type PairAcceptanceValue = { state: 'available'; expiresAt: string }
  | { state: 'accepted'; sessionId: string; userId: string; coupleId: string; membershipEpoch: number; replayed: boolean };
type Outcome = { state: 'complete'; value: PairAcceptanceValue } | AcceptanceFailure;
const response = (status: number, body: unknown) => Response.json(body, { status,
  headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...(status === 405 ? { allow: 'POST' } : {}) } });
const failure = (status: number, error: string) => response(status, { ok: false, error });
const isToken = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
  && Buffer.from(value, 'base64url').length === 32 && Buffer.from(value, 'base64url').toString('base64url') === value;

async function accept(tx: SqlExecutor, locked: AcceptanceLock): Promise<void> {
  const { invite, userId, epoch, now } = locked;
  const members = await tx.query<{ couple_id: string; user_id: string; slot: number; status: string }>(`
    INSERT INTO couple_members(couple_id,user_id,slot,status) VALUES($1,$2,2,'active')
    RETURNING couple_id, user_id, slot, status`, [invite.couple_id, userId]);
  const member = members.rows[0];
  if (members.rows.length !== 1 || member.couple_id !== invite.couple_id || member.user_id !== userId
    || member.slot !== 2 || member.status !== 'active') invalidAcceptance();
  const activated = await tx.query<{ id: string; status: string; membership_epoch: number }>(`
    UPDATE couples SET status='active', membership_epoch=membership_epoch+1
    WHERE id=$1 AND status='waiting_partner' AND membership_epoch=$2 RETURNING id, status, membership_epoch`, [invite.couple_id, epoch]);
  const couple = activated.rows[0];
  if (activated.rows.length !== 1 || couple.id !== invite.couple_id || couple.status !== 'active'
    || couple.membership_epoch !== epoch + 1) invalidAcceptance();
  const timestamp = new Date(now).toISOString();
  const consumed = await tx.query<AcceptanceInvite>(`
    UPDATE pair_invites SET consumed_at=$2, consumed_by_user_id=$3
    WHERE id=$1 AND token_hash=$4 AND couple_id=$5 AND issuer_user_id=$6
      AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>$2
    RETURNING ${acceptanceColumns}`, [invite.id, timestamp, userId, invite.token_hash, invite.couple_id, invite.issuer_user_id]);
  const row = consumed.rows[0];
  if (consumed.rows.length !== 1 || row.id !== invite.id || row.command_id !== invite.command_id
    || row.couple_id !== invite.couple_id || row.issuer_user_id !== invite.issuer_user_id || row.token_hash !== invite.token_hash
    || row.created_at !== invite.created_at || row.expires_at !== invite.expires_at || row.revoked_at !== null
    || Date.parse(row.consumed_at ?? '') !== now || row.consumed_by_user_id !== userId) invalidAcceptance();
}

async function execute(tx: SqlExecutor, session: VerifiedBetterAuthSession, hash: string, preview: boolean): Promise<Outcome> {
  const locked = await lockInvitation(tx, session, hash, preview);
  if (locked.state !== 'locked') return locked;
  if (preview) return { state: 'complete', value: { state: 'available', expiresAt: new Date(locked.invite.expires_at).toISOString() } };
  if (!locked.replayed) await accept(tx, locked);
  return { state: 'complete', value: { state: 'accepted', sessionId: session.sessionId, userId: locked.userId,
    coupleId: locked.invite.couple_id, membershipEpoch: locked.epoch + (locked.replayed ? 0 : 1), replayed: locked.replayed } };
}

/** Internal synthetic-only entry. Composition bounds bytes/read time; never log request/response bodies. */
export function createPairAcceptanceHandler(db: Database, options: BetterAuthAuthorityOptions): (request: Request) => Promise<Response> {
  const verify = createBetterAuthSessionVerifier(db, options);
  return async request => {
    try {
      const url = new URL(request.url);
      if (!['/v1/pair-invitations/preview', '/v1/pair-invitations/accept'].includes(url.pathname)) return failure(404, 'not_found');
      if (request.method !== 'POST') return failure(405, 'method_not_allowed');
      if (url.search) return failure(400, 'invalid_request');
      if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        return failure(415, 'unsupported_media_type');
      }
      let body: unknown;
      try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await request.arrayBuffer())); }
      catch { return failure(400, 'invalid_request'); }
      const preview = url.pathname.endsWith('/preview');
      if (typeof body !== 'object' || body === null || Array.isArray(body)
        || Object.keys(body).length !== (preview ? 1 : 2)) return failure(400, 'invalid_request');
      const value = body as Record<string, unknown>;
      if (!isToken(value.token) || (!preview && value.accept !== true)) return failure(400, 'invalid_request');
      const hash = createHash('sha256').update(value.token).digest('hex');
      const session = await verify(request);
      if (!session) return failure(401, 'unauthenticated');
      const result = await db.transaction(tx => execute(tx, session, hash, preview));
      if (result.state !== 'complete') return failure(result.state === 'unauthenticated' ? 401 : 409, result.state);
      return response(200, { ok: true, value: result.value });
    } catch { return failure(503, 'temporarily_unavailable'); }
  };
}
