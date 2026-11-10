import { createHash, randomBytes } from 'node:crypto';
import type { Database, SqlExecutor } from './contracts.ts';
import { createBetterAuthSessionVerifier, lockedBetterAuthSessionTime,
  type BetterAuthAuthorityOptions, type VerifiedBetterAuthSession } from './better-auth-session.ts';
import { invitationColumns, invitationMetadata, lockOwnWaitingSpace, optionalId,
  type InvitationMetadata, type InvitationRow } from './pair-invitation-state.ts';
import { isUuid } from './validation.ts';

type Command = { method: 'GET' } | { method: 'POST'; commandId: string } | { method: 'DELETE'; inviteId: string };
export type PairInvitationValue = { state: 'current'; invitation: InvitationMetadata | null }
  | { state: 'issued'; invitation: InvitationMetadata; token: string }
  | { state: 'replayed'; invitation: InvitationMetadata; token: null }
  | { state: 'revoked'; revoked: boolean };
type Outcome = { state: 'complete'; value: PairInvitationValue }
  | { state: 'unauthenticated' | 'profile_unavailable' | 'space_unavailable' | 'invitation_exists' | 'invitation_unavailable' };
const response = (status: number, body: unknown) => Response.json(body, { status,
  headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    ...(status === 405 ? { allow: 'GET, POST, DELETE' } : {}) } });
const failure = (status: number, error: string) => response(status, { ok: false, error });
const complete = (value: PairInvitationValue): Outcome => ({ state: 'complete', value });

async function execute(tx: SqlExecutor, session: VerifiedBetterAuthSession, command: Command): Promise<Outcome> {
  const space = await lockOwnWaitingSpace(tx, session);
  if (space.state !== 'locked') return space;
  const { coupleId, userId } = space;
  const params = [coupleId, userId];
  // Couple lock serializes compliant writers. Explicit invite locks also protect historical replay/revoke.
  const current = await tx.query<InvitationRow>(`SELECT ${invitationColumns} FROM pair_invites
    WHERE couple_id=$1 AND revoked_at IS NULL AND consumed_at IS NULL FOR UPDATE`, params);
  const target = command.method === 'GET' ? current : await tx.query<InvitationRow>(`
    SELECT ${invitationColumns} FROM pair_invites WHERE couple_id=$1
    AND ${command.method === 'POST' ? 'command_id' : 'id'}=$3 FOR UPDATE`,
  [...params, command.method === 'POST' ? command.commandId : command.inviteId]);
  // Exactly this authoritative fresh clock governs both session validity and invitation expiry/TTL.
  const now = await lockedBetterAuthSessionTime(tx, session);
  if (now === null) return { state: 'unauthenticated' };
  const active = invitationMetadata(current.rows, now);
  const selected = invitationMetadata(target.rows, now);
  if (active && !['pending', 'expired'].includes(active.status)) throw new Error('invalid_invitation_data');
  if (command.method === 'GET') return complete({ state: 'current', invitation: active });
  const revoke = async (invitation: InvitationMetadata) => {
    const result = await tx.query<{ id: string }>(`UPDATE pair_invites SET revoked_at=$3
      WHERE couple_id=$1 AND id=$2 AND revoked_at IS NULL AND consumed_at IS NULL RETURNING id`,
    [coupleId, invitation.id, new Date(now).toISOString()]);
    if (optionalId(result.rows, 'id') !== invitation.id) throw new Error('invalid_invitation_data');
  };
  if (command.method === 'DELETE') {
    if (!selected || selected.status === 'consumed') return { state: 'invitation_unavailable' };
    if (selected.id !== command.inviteId) throw new Error('invalid_invitation_data');
    if (selected.status === 'revoked') return complete({ state: 'revoked', revoked: false });
    if (active?.id !== selected.id) throw new Error('invalid_invitation_data');
    await revoke(selected);
    return complete({ state: 'revoked', revoked: true });
  }
  if (selected) {
    if (selected.commandId !== command.commandId) throw new Error('invalid_invitation_data');
    return complete({ state: 'replayed', invitation: selected, token: null });
  }
  if (active?.status === 'pending') return { state: 'invitation_exists' };
  if (active) await revoke(active);
  const token = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(token).digest('hex');
  const issued = await tx.query<InvitationRow>(`INSERT INTO pair_invites
    (couple_id,issuer_user_id,command_id,token_hash,created_at,expires_at)
    VALUES($1,$2,$3,$4,$5,$6) RETURNING ${invitationColumns}`,
  [coupleId, userId, command.commandId, hash, new Date(now).toISOString(), new Date(now + 600000).toISOString()]);
  const invitation = invitationMetadata(issued.rows, now);
  if (!invitation || invitation.commandId !== command.commandId || invitation.status !== 'pending'
    || invitation.createdAt !== new Date(now).toISOString() || invitation.expiresAt !== new Date(now + 600000).toISOString()) {
    throw new Error('invalid_invitation_data');
  }
  return complete({ state: 'issued', invitation, token });
}

/** Internal synthetic-only entry; composition bounds bytes/read time for every accepted method. */
export function createPairInvitationHandler(db: Database, options: BetterAuthAuthorityOptions): (request: Request) => Promise<Response> {
  const verify = createBetterAuthSessionVerifier(db, options);
  return async request => {
    try {
      const url = new URL(request.url);
      if (url.pathname !== '/v1/spaces/waiting/invite') return failure(404, 'not_found');
      if (!['GET', 'POST', 'DELETE'].includes(request.method)) return failure(405, 'method_not_allowed');
      if (url.search) return failure(400, 'invalid_request');
      let command: Command;
      if (request.method === 'GET') {
        if (request.body !== null || request.headers.has('transfer-encoding') || (request.headers.has('content-length') && request.headers.get('content-length') !== '0')) {
          return failure(400, 'invalid_request');
        }
        command = { method: 'GET' };
      } else {
        if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
          return failure(415, 'unsupported_media_type');
        }
        let body: unknown;
        try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await request.arrayBuffer())); }
        catch { return failure(400, 'invalid_request'); }
        if (typeof body !== 'object' || body === null || Array.isArray(body) || Object.keys(body).length !== 1) {
          return failure(400, 'invalid_request');
        }
        const value = body as Record<string, unknown>;
        if (request.method === 'POST' && isUuid(value.commandId)) command = { method: 'POST', commandId: value.commandId.toLowerCase() };
        else if (request.method === 'DELETE' && isUuid(value.inviteId)) command = { method: 'DELETE', inviteId: value.inviteId.toLowerCase() };
        else return failure(400, 'invalid_request');
      }
      const session = await verify(request);
      if (!session) return failure(401, 'unauthenticated');
      const result = await db.transaction(tx => execute(tx, session, command));
      if (result.state !== 'complete') return failure(result.state === 'unauthenticated' ? 401 : 409, result.state);
      return response(result.value.state === 'issued' ? 201 : 200, { ok: true, value: result.value });
    } catch { return failure(503, 'temporarily_unavailable'); }
  };
}
