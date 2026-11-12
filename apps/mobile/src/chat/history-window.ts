import { readBoundedJson, type ChatMessage, type TransportError, type TransportSession } from './transport';
import { normalizeMessageText } from './text';

export type HistoryWindowOptions = Readonly<{
  direction: 'latest' | 'oldest' | 'before' | 'after'; anchorSeq?: number; anchorId?: string; readId: string;
  allowHttpLoopbackForTests?: boolean;
}>;
export type ChatHistoryWindow = Readonly<{
  messages: readonly ChatMessage[]; readId: string; hasOlder: boolean; hasNewer: boolean;
  olderCursor: Readonly<{ id: string; seq: number }> | null; newerCursor: Readonly<{ id: string; seq: number }> | null;
}>;
export type HistoryWindowResult = Readonly<{ ok: true; value: ChatHistoryWindow }
  | { ok: false; error: TransportError | 'invalid_cursor' }>;
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const keys = (v: Record<string, unknown>, names: string) => Object.keys(v).sort().join(',') === names.split(',').sort().join(',');
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const fail = (error: TransportError | 'invalid_cursor'): HistoryWindowResult => ({ ok: false, error });
function message(value: unknown, coupleId: string): ChatMessage | null {
  if (!record(value) || !keys(value, 'id,coupleId,senderId,clientId,seq,body,version,createdAt')
    || !uuid(value.id) || value.coupleId !== coupleId || !uuid(value.senderId) || !uuid(value.clientId)
    || !positive(value.seq) || !positive(value.version) || typeof value.body !== 'string'
    || typeof value.createdAt !== 'string' || value.createdAt.length > 64 || !Number.isFinite(Date.parse(value.createdAt))) return null;
  const body = normalizeMessageText(value.body);
  if (!body.ok || body.text !== value.body) return null;
  return Object.freeze({ ...value }) as ChatMessage;
}
function page(value: unknown, coupleId: string, options: HistoryWindowOptions): ChatHistoryWindow | null {
  if (!record(value) || !keys(value, 'messages,readId,hasOlder,hasNewer,olderCursor,newerCursor')
    || value.readId !== options.readId || !Array.isArray(value.messages) || value.messages.length > 50
    || typeof value.hasOlder !== 'boolean' || typeof value.hasNewer !== 'boolean'
    || (options.direction === 'latest' && value.hasNewer) || (options.direction === 'oldest' && value.hasOlder)
    || (!value.messages.length && (value.hasOlder || value.hasNewer))) return null;
  const messages: ChatMessage[] = [], ids = new Set<string>(), commands = new Set<string>();
  let previousSeq = 0;
  for (const raw of value.messages) {
    const item = message(raw, coupleId);
    if (!item || item.seq <= previousSeq || ids.has(item.id.toLowerCase())
      || commands.has(`${item.senderId.toLowerCase()}/${item.clientId.toLowerCase()}`)
      || (options.direction === 'before' && item.seq >= options.anchorSeq!)
      || (options.direction === 'after' && item.seq <= options.anchorSeq!)) return null;
    previousSeq = item.seq; ids.add(item.id.toLowerCase());
    commands.add(`${item.senderId.toLowerCase()}/${item.clientId.toLowerCase()}`); messages.push(item);
  }
  const cursor = (v: unknown, expected: ChatMessage | undefined, enabled: boolean) => enabled
    ? record(v) && keys(v, 'id,seq') && v.id === expected?.id && v.seq === expected?.seq : v === null;
  if (!cursor(value.olderCursor, messages[0], value.hasOlder)
    || !cursor(value.newerCursor, messages.at(-1), value.hasNewer)) return null;
  return Object.freeze({ messages: Object.freeze(messages), readId: options.readId,
    hasOlder: value.hasOlder, hasNewer: value.hasNewer,
    olderCursor: value.hasOlder ? Object.freeze({ id: messages[0].id, seq: messages[0].seq }) : null,
    newerCursor: value.hasNewer ? Object.freeze({ id: messages[messages.length - 1].id, seq: messages[messages.length - 1].seq }) : null });
}
/** Read-only transport. The caller must check session/generation before and after awaiting. */
export async function readChatHistoryWindow(baseURL: string, session: TransportSession,
  options: HistoryWindowOptions, request: (request: Request) => Promise<Response>): Promise<HistoryWindowResult> {
  const captured = { ...session, scope: { ...session.scope } }, query = { ...options };
  const anchored = query.direction === 'before' || query.direction === 'after';
  if (!uuid(captured.scope.coupleId) || !uuid(captured.scope.userId) || !positive(captured.scope.membershipEpoch)
    || !positive(captured.credentialGeneration) || !uuid(query.readId)
    || !['latest', 'oldest', 'before', 'after'].includes(query.direction)
    || (anchored ? !positive(query.anchorSeq) || !uuid(query.anchorId) : query.anchorSeq !== undefined || query.anchorId !== undefined)) return fail('invalid_request');
  let origin: URL;
  try {
    origin = new URL(baseURL);
    const loopback = query.allowHttpLoopbackForTests === true && origin.protocol === 'http:'
      && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
    if ((origin.protocol !== 'https:' && !loopback) || origin.username || origin.password) return fail('invalid_request');
  } catch { return fail('invalid_request'); }
  const token = captured.token;
  if (typeof token !== 'string' || (captured.credentialKind === 'cookie'
    ? !token || token.length > 16384 || /[\x00-\x1f\x7f]/.test(token)
    : token.length > 2048 || !/^[A-Za-z0-9._~-]+$/.test(token))) return fail('invalid_token');
  const url = new URL(`/v1/couples/${captured.scope.coupleId}/chat/history-window`, origin);
  url.searchParams.set('membership_epoch', String(captured.scope.membershipEpoch));
  url.searchParams.set('read_id', query.readId); url.searchParams.set('direction', query.direction);
  if (anchored) {
    url.searchParams.set('anchor_seq', String(query.anchorSeq));
    url.searchParams.set('anchor_id', query.anchorId!);
  }
  const headers: Record<string, string> = captured.credentialKind === 'cookie'
    ? { Cookie: token, Origin: origin.origin } : { Authorization: `Bearer ${token}` };
  let response: Response;
  try { response = await request(new Request(url, { method: 'GET', headers, redirect: 'error', credentials: 'omit', cache: 'no-store' })); }
  catch { return fail('transport_error'); }
  let json: unknown;
  try { json = await readBoundedJson(response, 4 * 1024 * 1024); }
  catch { return fail('invalid_response'); }
  if (!record(json)) return fail('invalid_response');
  if (json.ok === false) {
    // A mismatched error nonce must never pause a different request/session.
    if (!keys(json, 'ok,error,readId') || json.readId !== query.readId || typeof json.error !== 'string') return fail('invalid_response');
    if (response.status === 401) return fail('auth_required');
    if (response.status === 403 || (response.status === 409 && json.error === 'stale_membership')) return fail('access_required');
    if (response.status === 400 && json.error === 'invalid_cursor') return fail('invalid_cursor');
    if (response.status === 429) return fail('rate_limited');
    if (response.status >= 500 && response.status <= 599) return fail('transport_error');
    return fail('rejected');
  }
  if (!response.ok || !keys(json, 'ok,value') || json.ok !== true) return fail('invalid_response');
  const parsed = page(json.value, captured.scope.coupleId, query);
  return parsed ? { ok: true, value: parsed } : fail('invalid_response');
}
