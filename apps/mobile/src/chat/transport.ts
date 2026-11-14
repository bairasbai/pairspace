import { visibilityMetadata } from './visibility-revision';
import { parseHiddenMessage, type HiddenMessage } from './visibility-model';
import { acknowledge, acknowledgeHidden, beginSend, failSend, pause } from './queue';
import { normalizeMessageText } from './text';
import type { QueueError, QueueState, Scope } from './types';

export type ChatMessage = Readonly<{
  id: string; coupleId: string; senderId: string; clientId: string; seq: number;
  body: string; version: number; createdAt: string;
}>;
export type TransportSession = Readonly<{ scope: Scope; token: string; credentialGeneration: number; credentialKind?: 'cookie' }>;
export type HistoryOptions = Readonly<{ limit: number; beforeSeq?: number }>;
export type HistoryPage = Readonly<{
  /** Check this scope again before any later asynchronous history hydration. */
  scope: Scope; credentialGeneration: number; messages: readonly ChatMessage[]; nextBeforeSeq: number | null;
}>;
export type TransportError = QueueError | 'invalid_token' | 'invalid_request'
  | 'transport_error' | 'rejected' | 'invalid_response' | 'stale_credentials'
  | 'auth_required' | 'access_required' | 'rate_limited' | 'visibility_changed' | 'message_hidden';
export type TransportResult<T> = Readonly<{ ok: true; value: T; visibilityRevision?: number }
  | { ok: false; error: TransportError }>;
export type QueueStore = Readonly<{ get(): QueueState; set(state: QueueState): void }>;
export type ChatTransportOptions = Readonly<{
  baseUrl: string;
  /** Required for cookie-auth composition; exact trusted origin. */
  cookieOrigin?: string;
  /** Never enable outside isolated tests. Only exact loopback hosts can use HTTP. */
  allowHttpLoopbackForTests?: boolean;
  /**
   * Trusted synchronous auth controller; generation is a positive safe integer, never reused
   * within the same scope. On token refresh: pause/requeue, increment, then trusted resume.
   * This getter and each session's token/generation must refer to the same credential snapshot.
   */
  getCredentialGeneration(): number;
  /** Explicit injection only. This module never opens a network connection by itself. */
  request(request: Request, valid?: () => boolean): Promise<Response>;
  /** A synchronous, trusted store. There must be no async gap between get and set. */
  store: QueueStore;
  acceptHiddenReceipt?(token: string, revision: number | undefined, message?: HiddenMessage, valid?: () => boolean): Promise<boolean>;
  acceptCanonicalMessage?(message: ChatMessage, token: string, visibilityRevision?: number, valid?: () => boolean): Promise<boolean>;
}>;

type JsonRecord = Record<string, unknown>;
const record = (value: unknown): value is JsonRecord => typeof value === 'object'
  && value !== null && !Array.isArray(value);
const validId = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const positive = (value: unknown): value is number => typeof value === 'number'
  && Number.isSafeInteger(value) && value > 0;
const sameScope = (a: Scope, b: Scope) => a.userId === b.userId && a.coupleId === b.coupleId
  && a.membershipEpoch === b.membershipEpoch && a.sessionId === b.sessionId;
const failure = (error: TransportError): TransportResult<never> => ({ ok: false, error });

function parseMessage(input: unknown, scope: Scope): ChatMessage | null {
  if (!record(input) || !validId(input.id) || !validId(input.coupleId) || input.coupleId !== scope.coupleId
    || !validId(input.senderId) || !validId(input.clientId) || !positive(input.seq)
    || !positive(input.version) || typeof input.body !== 'string' || input.body.length > 16000
    || typeof input.createdAt !== 'string' || input.createdAt.length > 64
    || !Number.isFinite(Date.parse(input.createdAt))) return null;
  const normalized = normalizeMessageText(input.body);
  if (!normalized.ok || normalized.text !== input.body) return null;
  return Object.freeze({ id: input.id, coupleId: scope.coupleId, senderId: input.senderId,
    clientId: input.clientId, seq: input.seq, body: input.body, version: input.version,
    createdAt: input.createdAt });
}

function parsePage(input: JsonRecord, session: TransportSession, options: HistoryOptions): HistoryPage | null {
  const { scope, credentialGeneration } = session;
  if (!Array.isArray(input.messages) || input.messages.length > options.limit) return null;
  const messages: ChatMessage[] = [];
  const ids = new Set<string>();
  const commands = new Set<string>();
  let previousSeq = 0;
  for (const item of input.messages) {
    const message = parseMessage(item, scope);
    if (!message || message.seq <= previousSeq
      || (options.beforeSeq !== undefined && message.seq >= options.beforeSeq)
      || ids.has(message.id) || commands.has(`${message.senderId}\u0000${message.clientId}`)) return null;
    previousSeq = message.seq;
    ids.add(message.id);
    commands.add(`${message.senderId}\u0000${message.clientId}`);
    messages.push(message);
  }
  const cursor = input.nextBeforeSeq;
  if (cursor !== null && (!positive(cursor) || messages.length !== options.limit
    || cursor !== messages[0].seq)) return null;
  return Object.freeze({ scope, credentialGeneration, messages: Object.freeze(messages), nextBeforeSeq: cursor });
}

// A message can expand to six JSON bytes per codepoint; history permits 100 messages.
const SEND_RESPONSE_BYTES = 65536;
const HISTORY_RESPONSE_BYTES = 8 * 1024 * 1024;
class InvalidResponseError extends Error {}
export async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.body || typeof response.body.getReader !== 'function') throw new InvalidResponseError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new InvalidResponseError()), 10000);
  });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        throw new InvalidResponseError();
      }
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally { clearTimeout(timer!); reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new InvalidResponseError(); }
}

/** Test-only client boundary. The trusted caller supplies authentication; this does not implement it. */
export function createChatTransport({ baseUrl, request, store, getCredentialGeneration, allowHttpLoopbackForTests = false, cookieOrigin, acceptCanonicalMessage, acceptHiddenReceipt }: ChatTransportOptions) {
  const origin = new URL(baseUrl);
  const testLoopback = allowHttpLoopbackForTests && origin.protocol === 'http:'
    && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if ((origin.protocol !== 'https:' && !testLoopback) || origin.username || origin.password) {
    throw new Error('invalid_base_url');
  }
  if (cookieOrigin !== undefined && (!cookieOrigin || /[\r\n]/.test(cookieOrigin))) throw new Error('invalid_cookie_origin');
  function currentError(session: TransportSession, allowPaused = false): TransportError | null {
    const { scope, credentialGeneration } = session;
    const state = store.get();
    if (!sameScope(state.scope, scope) || state.phase === 'logged_out' || state.phase === 'revoked') return 'stale_session';
    if (!positive(credentialGeneration) || credentialGeneration !== getCredentialGeneration()) return 'stale_credentials';
    if (state.phase !== 'active' && !allowPaused) return 'inactive';
    return null;
  }
  function capture(session: TransportSession): TransportResult<TransportSession> {
    const scope = Object.freeze({ ...session.scope });
    const token = session.token;
    const credentialGeneration = session.credentialGeneration;
    const captured = Object.freeze({ scope, token, credentialGeneration, credentialKind: session.credentialKind });
    const denied = currentError(captured);
    if (denied) return failure(denied);
    if (typeof token !== 'string' || (session.credentialKind === 'cookie'
      ? !cookieOrigin || !token || token.length > 16384 || /[\x00-\x1f\x7f]/.test(token)
      : token.length > 2048 || !/^[A-Za-z0-9._~-]+$/.test(token))) {
      return failure('invalid_token');
    }
    return { ok: true, value: captured };
  }
  async function exchange(session: TransportSession, body?: JsonRecord, options?: HistoryOptions, valid: () => boolean = () => true): Promise<TransportResult<JsonRecord>> {
    const { scope, token } = session;
    let response: Response;
    try {
      const url = new URL(`/v1/couples/${encodeURIComponent(scope.coupleId)}/chat/messages`, origin);
      const headers: Record<string, string> = session.credentialKind === 'cookie'
        ? { Cookie: token, Origin: cookieOrigin! } : { Authorization: `Bearer ${token}` };
      if (body) {
        headers['Content-Type'] = 'application/json';
        headers['Idempotency-Key'] = body.client_message_id as string;
      } else {
        url.searchParams.set('membership_epoch', String(scope.membershipEpoch));
        url.searchParams.set('limit', String(options!.limit));
        if (options!.beforeSeq !== undefined) url.searchParams.set('beforeSeq', String(options!.beforeSeq));
      }
      response = await request(new Request(url.toString(), {
        method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined,
        redirect: 'error', credentials: 'omit', cache: 'no-store',
      }), valid);
    } catch {
      return failure(currentError(session) ?? 'transport_error');
    }
    const stale = currentError(session, true);
    if (stale) return failure(stale);
    if (response.status === 401 || response.status === 403) {
      // Opaque denial is not evidence of revoked membership. Preserve every draft/command.
      const paused = pause(store.get(), scope);
      if (paused.ok) store.set(paused.state);
      return failure(response.status === 401 ? 'auth_required' : 'access_required');
    }
    const inactive = currentError(session);
    if (inactive) return failure(inactive);
    if (response.status >= 500 && response.status <= 599) return failure('transport_error');
    if (response.status === 429) return failure('rate_limited');
    if (!response.ok && response.status !== 409) return failure('rejected');
    let json: unknown;
    try { json = await readBoundedJson(response, body ? SEND_RESPONSE_BYTES : HISTORY_RESPONSE_BYTES); }
    catch (error) {
      return failure(currentError(session) ?? (error instanceof InvalidResponseError ? 'invalid_response' : 'transport_error'));
    }
    const changed = currentError(session);
    if (changed) return failure(changed);
    if (!record(json)) return failure('invalid_response');
    if (response.status === 409 && json.ok === false && json.error === 'stale_membership'
      && Object.keys(json).sort().join(',') === 'error,ok') return failure('access_required');
    if (json.ok === false && typeof json.error === 'string') return failure(json.error === 'visibility_changed' || json.error === 'message_hidden' ? json.error : 'rejected');
    if (response.status === 409) return failure('rejected');
    if (json.ok !== true || !record(json.value)) return failure('invalid_response');
    return { ok: true, value: json.value, ...visibilityMetadata(response) };
  }
  async function send(clientId: string, session: TransportSession, valid: () => boolean = () => true): Promise<TransportResult<Readonly<{ replay: boolean; hidden?: true }>>> {
    if (!valid()) return failure('stale_session');
    const captured = capture(session);
    if (!captured.ok) return captured;
    const { scope } = captured.value;
    const started = beginSend(store.get(), scope, clientId);
    if (!started.ok) return failure(started.error);
    store.set(started.state);
    const outgoing = started.state.messages.find(item => item.clientId === clientId)!;
    const result = await exchange(captured.value, { membership_epoch: scope.membershipEpoch,
      client_message_id: clientId, body: outgoing.body }, undefined, valid);
    const allowPaused = !result.ok && (result.error === 'auth_required' || result.error === 'access_required');
    const stale = currentError(captured.value, allowPaused);
    if (stale) return failure(stale);
    if (allowPaused) return result;
    if (!valid()) return failure('stale_session');
    const reject = (error: TransportError) => {
      const failed = failSend(store.get(), scope, clientId, outgoing.attempt, error === 'transport_error' || error === 'rate_limited');
      if (failed.ok) store.set(failed.state);
      return failure(error);
    };
    if (!result.ok) return reject(result.error);
    if (Object.hasOwn(result.value, 'hiddenMessage')) {
      if (Object.keys(result.value).sort().join(',') !== 'hiddenMessage,replay' || result.value.replay !== true) return reject('invalid_response');
      const hidden = parseHiddenMessage(result.value.hiddenMessage, scope.coupleId);
      if (!hidden || hidden.senderId !== scope.userId || hidden.clientId !== clientId || hidden.replyToId !== null) return reject('invalid_response');
      const permitted = acceptHiddenReceipt ? await acceptHiddenReceipt(captured.value.token, result.visibilityRevision, hidden, valid) : true;
      const afterHidden = currentError(captured.value);
      if (afterHidden) return failure(afterHidden);
      if (!valid()) return failure('stale_session');
      if (!permitted) return reject('visibility_changed');
      const accepted = acknowledgeHidden(store.get(), scope, hidden);
      if (!accepted.ok) return reject('invalid_response');
      store.set(accepted.state);
      return { ok: true, value: { replay: true, hidden: true } };
    }
    const message = parseMessage(result.value.message, scope);
    if (!message || message.senderId !== scope.userId || message.clientId !== clientId
      || (message.version === 1 && message.body !== outgoing.body) || typeof result.value.replay !== 'boolean') return reject('invalid_response');
    const accepted = acceptCanonicalMessage ? await acceptCanonicalMessage(message, captured.value.token, result.visibilityRevision, valid) : true;
    const afterCanonical = currentError(captured.value);
    if (afterCanonical) return failure(afterCanonical);
    if (!valid()) return failure('stale_session');
    if (!accepted) return reject('invalid_response');
    const acknowledged = acknowledge(store.get(), scope, { clientId, serverId: message.id,
      senderId: message.senderId, seq: message.seq, version: message.version, body: message.body });
    if (!acknowledged.ok) return reject('invalid_response');
    store.set(acknowledged.state);
    return { ok: true, value: { replay: result.value.replay } };
  }
  async function history(session: TransportSession, options: HistoryOptions): Promise<TransportResult<HistoryPage>> {
    const captured = capture(session);
    if (!captured.ok) return captured;
    const pageOptions = { ...options };
    if (!positive(pageOptions.limit) || pageOptions.limit > 100
      || (pageOptions.beforeSeq !== undefined && !positive(pageOptions.beforeSeq))) return failure('invalid_request');
    const result = await exchange(captured.value, undefined, pageOptions);
    const allowPaused = !result.ok && (result.error === 'auth_required' || result.error === 'access_required');
    const stale = currentError(captured.value, allowPaused);
    if (stale) return failure(stale);
    if (!result.ok) return result;
    const page = parsePage(result.value, captured.value, pageOptions);
    return page ? { ok: true, value: page } : failure('invalid_response');
  }
  return Object.freeze({ send, history });
}
