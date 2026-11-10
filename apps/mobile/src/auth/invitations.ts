import { readBoundedJson } from '../chat/transport';
import { validateSyntheticConfig, type SyntheticConfig } from './config';

export type InvitationMetadata = Readonly<{
  id: string; commandId: string; status: 'pending' | 'expired' | 'revoked' | 'consumed';
  createdAt: string; expiresAt: string; revokedAt: string | null; consumedAt: string | null;
}>;
export type InvitationError = 'auth_required' | 'access_required' | 'invitation_unavailable' | 'invitation_retry_required';
export type InvitationResult<T> = { ok: true; value: T } | { ok: false; error: InvitationError };
export type InvitationIssue = Readonly<{ invitation: InvitationMetadata; token: string | null }>;
export type InvitationAcceptance = Readonly<{
  sessionId: string; userId: string; coupleId: string; membershipEpoch: number; replayed: boolean;
}>;
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).length === keys.length
  && keys.every(key => Object.hasOwn(v, key));
export const invitationUuid = (v: unknown): v is string => typeof v === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
/** 32-byte canonical, unpadded base64url. This validates syntax, not authority or cryptography. */
export const validInvitationToken = (v: unknown): v is string => typeof v === 'string'
  && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(v);
const date = (v: unknown): v is string => typeof v === 'string'
  && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)
  && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
function metadata(v: unknown): InvitationMetadata | null {
  if (!record(v) || !exact(v, ['id', 'commandId', 'status', 'createdAt', 'expiresAt', 'revokedAt', 'consumedAt'])
    || !invitationUuid(v.id) || !invitationUuid(v.commandId) || !date(v.createdAt) || !date(v.expiresAt)
    || v.expiresAt <= v.createdAt || (v.revokedAt !== null && (!date(v.revokedAt) || v.revokedAt < v.createdAt))
    || (v.consumedAt !== null && (!date(v.consumedAt) || v.consumedAt < v.createdAt || v.consumedAt >= v.expiresAt))) return null;
  if ((v.status === 'pending' || v.status === 'expired') ? v.revokedAt !== null || v.consumedAt !== null
    : v.status === 'revoked' ? v.revokedAt === null || v.consumedAt !== null
      : v.status === 'consumed' ? v.consumedAt === null || v.revokedAt !== null : true) return null;
  return Object.freeze({ id: v.id, commandId: v.commandId, status: v.status as InvitationMetadata['status'],
    createdAt: v.createdAt, expiresAt: v.expiresAt, revokedAt: v.revokedAt as string | null, consumedAt: v.consumedAt as string | null });
}
const retry = (): InvitationResult<never> => ({ ok: false, error: 'invitation_retry_required' });
const unavailable = (): InvitationResult<never> => ({ ok: false, error: 'invitation_unavailable' });
/** Explicit synthetic harness only; no credentials or tokens are persisted, logged or sent in URLs. */
export function createInvitationTransport(config: SyntheticConfig, request: (input: Request) => Promise<Response>) {
  const snapshot = Object.freeze({ mode: config.mode, baseURL: config.baseURL });
  validateSyntheticConfig(snapshot);
  async function send<T>(cookie: string, path: string, method: string, body: object | undefined,
    parse: (value: Record<string, unknown>, status: number) => T | null, signal?: AbortSignal): Promise<InvitationResult<T>> {
    try {
      if (!cookie || cookie.length > 8192 || /[\x00-\x1f\x7f]/.test(cookie)) return { ok: false, error: 'auth_required' };
      const response = await request(new Request(snapshot.baseURL + path, {
        method, headers: { Cookie: cookie, Origin: snapshot.baseURL, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal, credentials: 'omit', redirect: 'error', cache: 'no-store',
      }));
      if (response.status === 401) return { ok: false, error: 'auth_required' };
      if (response.status === 403) return { ok: false, error: 'access_required' };
      const json = await readBoundedJson(response, 4096);
      if (!record(json)) return retry();
      if ([400, 404, 409].includes(response.status) && exact(json, ['ok', 'error']) && json.ok === false
        && ['invalid_request', 'not_found', 'profile_unavailable', 'space_unavailable', 'invitation_exists', 'invitation_unavailable'].includes(String(json.error))) return unavailable();
      if ((response.status !== 200 && response.status !== 201) || !exact(json, ['ok', 'value'])
        || json.ok !== true || !record(json.value)) return retry();
      const value = parse(json.value, response.status);
      return value === null ? retry() : { ok: true, value };
    } catch { return retry(); }
  }
  const owner = '/v1/spaces/waiting/invite';
  return {
    read(cookie: string, signal?: AbortSignal) {
      return send<{ invitation: InvitationMetadata | null }>(cookie, owner, 'GET', undefined, (v, status) => {
        if (status !== 200 || !exact(v, ['state', 'invitation']) || v.state !== 'current') return null;
        if (v.invitation === null) return { invitation: null };
        const invitation = metadata(v.invitation);
        return invitation && ['pending', 'expired'].includes(invitation.status) ? { invitation } : null;
      }, signal);
    },
    issue(cookie: string, commandId: string, signal?: AbortSignal) {
      if (!invitationUuid(commandId)) return Promise.resolve(unavailable());
      return send<InvitationIssue>(cookie, owner, 'POST', { commandId }, (v, status) => {
        if (!exact(v, ['state', 'invitation', 'token'])) return null;
        const invitation = metadata(v.invitation);
        if (!invitation || invitation.commandId.toLowerCase() !== commandId.toLowerCase()) return null;
        if (status === 201 && v.state === 'issued' && invitation.status === 'pending' && validInvitationToken(v.token)) return { invitation, token: v.token };
        return status === 200 && v.state === 'replayed' && v.token === null ? { invitation, token: null } : null;
      }, signal);
    },
    revoke(cookie: string, inviteId: string, signal?: AbortSignal) {
      if (!invitationUuid(inviteId)) return Promise.resolve(unavailable());
      return send<{ revoked: boolean }>(cookie, owner, 'DELETE', { inviteId }, (v, status) =>
        status === 200 && exact(v, ['state', 'revoked']) && v.state === 'revoked' && typeof v.revoked === 'boolean'
          ? { revoked: v.revoked } : null, signal);
    },
    preview(cookie: string, token: string, signal?: AbortSignal) {
      if (!validInvitationToken(token)) return Promise.resolve(unavailable());
      return send<{ expiresAt: string }>(cookie, '/v1/pair-invitations/preview', 'POST', { token }, (v, status) =>
        status === 200 && exact(v, ['state', 'expiresAt']) && v.state === 'available' && date(v.expiresAt)
          ? { expiresAt: v.expiresAt } : null, signal);
    },
    accept(cookie: string, token: string, signal?: AbortSignal) {
      if (!validInvitationToken(token)) return Promise.resolve(unavailable());
      return send<InvitationAcceptance>(cookie, '/v1/pair-invitations/accept', 'POST', { token, accept: true }, (v, status) => {
        if (status !== 200 || !exact(v, ['state', 'sessionId', 'userId', 'coupleId', 'membershipEpoch', 'replayed'])
          || v.state !== 'accepted' || typeof v.sessionId !== 'string' || !v.sessionId || v.sessionId.length > 512
          || /[\x00-\x1f\x7f]/.test(v.sessionId) || !invitationUuid(v.userId) || !invitationUuid(v.coupleId)
          || !Number.isSafeInteger(v.membershipEpoch) || Number(v.membershipEpoch) < 1 || typeof v.replayed !== 'boolean') return null;
        return { sessionId: v.sessionId, userId: v.userId, coupleId: v.coupleId,
          membershipEpoch: Number(v.membershipEpoch), replayed: v.replayed };
      }, signal);
    },
  };
}
