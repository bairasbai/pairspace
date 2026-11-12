import { readBoundedJson, type TransportError, type TransportSession } from './transport';
import type { HistoryWindowOptions } from './history-window';
import { keys, positive, record, uuid, parseReplyMessage, parseReplyWindow, type ReplyMessage, type ReplyWindow } from './reply-model';
import { normalizeMessageText } from './text';
export type { ReplyMessage, ReplyWindow } from './reply-model';
export type ReplyTransportResult<T> = Readonly<{ ok: true; value: T }
  | { ok: false; error: TransportError | 'invalid_cursor' | 'reply_unavailable' }>;
type Requester = (request: Request) => Promise<Response>;
type DetailOptions = Readonly<{ messageId: string; readId: string; allowHttpLoopbackForTests?: boolean }>;
type SendOptions = Readonly<{ clientId: string; body: string; replyToId: string; allowHttpLoopbackForTests?: boolean }>;
const fail = (error: TransportError | 'invalid_cursor' | 'reply_unavailable'): ReplyTransportResult<never> => ({ ok: false, error });
async function exchange(baseURL: string, session: TransportSession, path: string, request: Requester,
  options: { allowHttpLoopbackForTests?: boolean; readId?: string; params?: Record<string, string>; body?: Record<string, unknown> }): Promise<ReplyTransportResult<Record<string, unknown>>> {
  if (!uuid(session.scope.coupleId) || !uuid(session.scope.userId) || !positive(session.scope.membershipEpoch)
    || !positive(session.credentialGeneration)) return fail('invalid_request');
  let origin: URL;
  try {
    origin = new URL(baseURL);
    const loopback = options.allowHttpLoopbackForTests === true && origin.protocol === 'http:'
      && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
    if ((origin.protocol !== 'https:' && !loopback) || origin.username || origin.password) return fail('invalid_request');
  } catch { return fail('invalid_request'); }
  const token = session.token;
  if (typeof token !== 'string' || (session.credentialKind === 'cookie'
    ? !token || token.length > 16384 || /[\x00-\x1f\x7f]/.test(token)
    : token.length > 2048 || !/^[A-Za-z0-9._~-]+$/.test(token))) return fail('invalid_token');
  const url = new URL(`/v1/couples/${session.scope.coupleId}/chat/${path}`, origin);
  const headers: Record<string, string> = session.credentialKind === 'cookie'
    ? { Cookie: token, Origin: origin.origin } : { Authorization: `Bearer ${token}` };
  if (options.body) {
    headers['Content-Type'] = 'application/json'; headers['Idempotency-Key'] = String(options.body.client_message_id);
  } else {
    url.searchParams.set('membership_epoch', String(session.scope.membershipEpoch));
    url.searchParams.set('read_id', options.readId!);
    for (const [key, value] of Object.entries(options.params ?? {})) url.searchParams.set(key, value);
  }
  let response: Response;
  try { response = await request(new Request(url, { method: options.body ? 'POST' : 'GET', headers,
    body: options.body ? JSON.stringify(options.body) : undefined, redirect: 'error', credentials: 'omit', cache: 'no-store' })); }
  catch { return fail('transport_error'); }
  let json: unknown;
  try { json = await readBoundedJson(response, path === 'reply-window' ? 4 * 1024 * 1024 : 65536); }
  catch { return fail('invalid_response'); }
  if (!record(json)) return fail('invalid_response');
  if (json.ok === false) {
    if (!keys(json, options.body ? 'ok,error' : 'ok,error,readId') || typeof json.error !== 'string'
      || (!options.body && json.readId !== options.readId)) return fail('invalid_response');
    if (response.status === 401) return fail('auth_required');
    if (response.status === 403 || (response.status === 409 && json.error === 'stale_membership')) return fail('access_required');
    if (json.error === 'reply_unavailable') return fail('reply_unavailable');
    if (response.status === 400 && json.error === 'invalid_cursor') return fail('invalid_cursor');
    if (response.status === 429) return fail('rate_limited');
    if (response.status >= 500 && response.status <= 599) return fail('transport_error');
    return fail('rejected');
  }
  if (!response.ok || !keys(json, 'ok,value') || json.ok !== true || !record(json.value)) return fail('invalid_response');
  return { ok: true, value: json.value };
}
const capture = (session: TransportSession) => ({ ...session, scope: { ...session.scope } });
/** Caller owns pre/post session-generation checks; these helpers never change queue state. */
export async function readReplyWindow(baseURL: string, session: TransportSession, options: HistoryWindowOptions,
  request: Requester): Promise<ReplyTransportResult<ReplyWindow>> {
  const current = capture(session), query = { ...options };
  const anchored = query.direction === 'before' || query.direction === 'after';
  if (!uuid(query.readId) || !['latest', 'oldest', 'before', 'after'].includes(query.direction)
    || (anchored ? !positive(query.anchorSeq) || !uuid(query.anchorId) : query.anchorSeq !== undefined || query.anchorId !== undefined)) return fail('invalid_request');
  const params: Record<string, string> = { direction: query.direction };
  if (anchored) { params.anchor_seq = String(query.anchorSeq); params.anchor_id = query.anchorId!; }
  const result = await exchange(baseURL, current, 'reply-window', request, { ...query, params });
  if (!result.ok) return result;
  const parsed = parseReplyWindow(result.value, current.scope.coupleId, query);
  return parsed ? { ok: true, value: parsed } : fail('invalid_response');
}
export async function readReplyDetail(baseURL: string, session: TransportSession, options: DetailOptions,
  request: Requester): Promise<ReplyTransportResult<ReplyMessage>> {
  const current = capture(session), query = { ...options };
  if (!uuid(query.messageId) || !uuid(query.readId)) return fail('invalid_request');
  const result = await exchange(baseURL, current, 'message-detail', request, { ...query, params: { message_id: query.messageId } });
  if (!result.ok) return result;
  if (!keys(result.value, 'message,readId') || result.value.readId !== query.readId) return fail('invalid_response');
  const parsed = parseReplyMessage(result.value.message, current.scope.coupleId);
  return parsed?.id === query.messageId ? { ok: true, value: parsed } : fail('invalid_response');
}
export async function sendChatReply(baseURL: string, session: TransportSession, options: SendOptions,
  request: Requester): Promise<ReplyTransportResult<Readonly<{ message: ReplyMessage; replay: boolean }>>> {
  const current = capture(session), command = { ...options }, body = normalizeMessageText(command.body);
  if (!uuid(command.clientId) || !uuid(command.replyToId)) return fail('invalid_request');
  if (!body.ok) return fail(body.error);
  const result = await exchange(baseURL, current, 'replies', request, {
    allowHttpLoopbackForTests: command.allowHttpLoopbackForTests,
    body: { membership_epoch: current.scope.membershipEpoch, client_message_id: command.clientId, body: body.text, reply_to_id: command.replyToId },
  });
  if (!result.ok) return result;
  if (!keys(result.value, 'message,replay') || typeof result.value.replay !== 'boolean') return fail('invalid_response');
  const parsed = parseReplyMessage(result.value.message, current.scope.coupleId);
  if (!parsed || parsed.senderId !== current.scope.userId || parsed.clientId !== command.clientId
    || parsed.body === null || (parsed.version === 1 && parsed.body !== body.text) || parsed.replyToId !== command.replyToId) return fail('invalid_response');
  return { ok: true, value: Object.freeze({ message: parsed, replay: result.value.replay }) };
}
