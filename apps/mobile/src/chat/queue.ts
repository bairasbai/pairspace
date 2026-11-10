import { normalizeMessageText } from './text';
import type { Ack, Outgoing, QueueError, QueueResult, QueueState, Scope } from './types';

export const MAX_OUTGOING_RECORDS = 500;
const validId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(id);
const positive = (value: number) => Number.isSafeInteger(value) && value > 0;
const sameScope = (a: Scope, b: Scope) => a.userId === b.userId && a.coupleId === b.coupleId
  && a.membershipEpoch === b.membershipEpoch && a.sessionId === b.sessionId;
const success = (state: QueueState): QueueResult => ({ ok: true, state });
const fail = (state: QueueState, error: QueueError): QueueResult => ({ ok: false, state, error });
const freeze = (state: QueueState): QueueState => Object.freeze({ ...state,
  scope: Object.freeze({ ...state.scope }), messages: Object.freeze(state.messages.map(item => Object.freeze({ ...item }))),
});

/** Trusted application boundary supplies the validated session context. This is NOT authentication. */
export function createQueue(scope: Scope): QueueState {
  if (!validId(scope.userId) || !validId(scope.coupleId) || !validId(scope.sessionId) || !positive(scope.membershipEpoch)) {
    throw new Error('invalid_scope');
  }
  return freeze({ scope, phase: 'active', messages: [] });
}

function guard(state: QueueState, scope: Scope, allowPaused = false): QueueError | null {
  if (!sameScope(state.scope, scope)) return 'scope_mismatch';
  if (state.phase !== 'active' && !(allowPaused && state.phase === 'paused')) return 'inactive';
  return null;
}
function replace(state: QueueState, message: Outgoing): QueueResult {
  return success(freeze({ ...state, messages: state.messages.map(item => item.clientId === message.clientId ? message : item) }));
}

export function enqueue(state: QueueState, scope: Scope, clientId: string, input: unknown): QueueResult {
  const denied = guard(state, scope, true);
  if (denied) return fail(state, denied);
  if (!validId(clientId)) return fail(state, 'invalid_id');
  const existing = state.messages.find(item => item.clientId === clientId);
  if (existing?.deleted) return fail(state, 'deleted');
  const normalized = normalizeMessageText(input);
  if (!normalized.ok) return fail(state, normalized.error);
  if (existing) return existing.body === normalized.text ? success(state) : fail(state, 'id_conflict');
  if (state.messages.length >= MAX_OUTGOING_RECORDS) return fail(state, 'queue_full');
  const message: Outgoing = { clientId, body: normalized.text, status: 'queued', attempt: 0,
    error: null, serverId: null, seq: null, version: 0, deleted: false };
  return success(freeze({ ...state, messages: [...state.messages, message] }));
}

export function beginSend(state: QueueState, scope: Scope, clientId: string): QueueResult {
  const denied = guard(state, scope);
  if (denied) return fail(state, denied);
  const message = state.messages.find(item => item.clientId === clientId);
  if (!message) return fail(state, 'unknown_message');
  if (message.deleted) return fail(state, 'deleted');
  if (message.status !== 'queued') return fail(state, 'invalid_transition');
  return replace(state, { ...message, status: 'sending', attempt: message.attempt + 1 });
}

/** Only the currently in-flight attempt may fail; late failures cannot roll back an ACK. */
export function failSend(state: QueueState, scope: Scope, clientId: string, attempt: number, retryable: boolean): QueueResult {
  const denied = guard(state, scope);
  if (denied) return fail(state, denied);
  const message = state.messages.find(item => item.clientId === clientId);
  if (!message) return fail(state, 'unknown_message');
  if (message.status !== 'sending' || message.attempt !== attempt || message.deleted) return success(state);
  return replace(state, { ...message, status: retryable ? 'queued' : 'failed', error: retryable ? null : 'rejected' });
}

export function retry(state: QueueState, scope: Scope, clientId: string): QueueResult {
  const denied = guard(state, scope);
  if (denied) return fail(state, denied);
  const message = state.messages.find(item => item.clientId === clientId);
  if (!message) return fail(state, 'unknown_message');
  if (message.deleted) return fail(state, 'deleted');
  if (message.status !== 'failed') return fail(state, 'invalid_transition');
  return replace(state, { ...message, status: 'queued', error: null });
}

/** Initial-send ACK only. Editing/history hydration use a later separate protocol. */
export function acknowledge(state: QueueState, scope: Scope, input: unknown): QueueResult {
  const denied = guard(state, scope);
  if (denied) return fail(state, denied);
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return fail(state, 'invalid_ack');
  const ack = input as Partial<Ack>;
  if (!validId(ack.clientId) || !validId(ack.serverId) || ack.senderId !== scope.userId
    || typeof ack.seq !== 'number' || typeof ack.version !== 'number'
    || !positive(ack.seq) || !positive(ack.version)) return fail(state, 'invalid_ack');
  const message = state.messages.find(item => item.clientId === ack.clientId);
  if (!message) return fail(state, 'unknown_message');
  // A tombstone is terminal even if a delayed response claims a higher version.
  if (message.deleted) return success(state);
  if (message.attempt === 0) return fail(state, 'invalid_transition');
  const normalized = normalizeMessageText(ack.body);
  if (!normalized.ok || normalized.text !== message.body) return fail(state, 'invalid_ack');
  if (message.serverId !== null && (message.serverId !== ack.serverId || message.seq !== ack.seq)) return fail(state, 'invalid_ack');
  if (state.messages.some(item => item.clientId !== ack.clientId && (item.serverId === ack.serverId || item.seq === ack.seq))) return fail(state, 'invalid_ack');
  if (ack.version < message.version) return success(state);
  return replace(state, { ...message, status: 'accepted', error: null, serverId: ack.serverId, seq: ack.seq, version: ack.version });
}

/** Call only for an authorized canonical deletion event, never for a local delete tap. */
export function deleteConfirmed(state: QueueState, scope: Scope, clientId: string, serverId: string, version: number): QueueResult {
  const denied = guard(state, scope);
  if (denied) return fail(state, denied);
  const message = state.messages.find(item => item.clientId === clientId);
  if (!message) return fail(state, 'unknown_message');
  if (!positive(version) || !validId(serverId) || message.attempt === 0
    || (message.serverId !== null && message.serverId !== serverId)
    || state.messages.some(item => item.clientId !== clientId && item.serverId === serverId)) return fail(state, 'invalid_ack');
  if (version <= message.version) return success(state);
  return replace(state, { ...message, body: null, deleted: true, status: 'accepted', error: null, serverId, version });
}

export function pause(state: QueueState, scope: Scope): QueueResult {
  const denied = guard(state, scope, true);
  if (denied) return fail(state, denied);
  return success(freeze({ ...state, phase: 'paused', messages: state.messages.map(message =>
    message.status === 'sending' ? { ...message, status: 'queued' } : message) }));
}
export function resume(state: QueueState, scope: Scope): QueueResult {
  const denied = guard(state, scope, true);
  if (denied) return fail(state, denied);
  return success(freeze({ ...state, phase: 'active' }));
}
export function revoke(state: QueueState, scope: Scope): QueueResult {
  if (!sameScope(state.scope, scope)) return fail(state, 'scope_mismatch');
  return success(freeze({ ...state, phase: 'revoked', messages: [] }));
}
export function logout(state: QueueState): QueueState {
  return freeze({ ...state, phase: 'logged_out', messages: [] });
}
/** Switching context always drops records. sessionId must be fresh even for the same account. */
export function login(state: QueueState, scope: Scope): QueueResult {
  if (state.scope.sessionId === scope.sessionId) return fail(state, 'stale_session');
  return success(createQueue(scope));
}
