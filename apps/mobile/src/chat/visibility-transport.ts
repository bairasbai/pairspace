import { readBoundedJson, type TransportSession, type TransportError } from './transport';
import { keys, positive, record, uuid } from './reply-model';
import { nonnegative, parseHiddenWindow, parseMessageVisibility, type HiddenWindowOptions,
  type HiddenWindow, type MessageVisibility } from './visibility-model';
export type VisibilityError = TransportError | 'invalid_cursor' | 'message_unavailable' | 'version_conflict' | 'idempotency_conflict' | 'visibility_changed';
export type VisibilityResult<T> = Readonly<{ ok: true; value: T & { revision: number } } | { ok: false; error: VisibilityError }>;
type Reader = (request: Request) => Promise<Response>;
type ReadOptions = Readonly<{ messageId: string; readId: string; allowHttpLoopbackForTests?: boolean }>;
type SetOptions = Readonly<{ messageId: string; commandId: string; expectedVisibilityVersion: number; hidden: boolean; allowHttpLoopbackForTests?: boolean }>;
const fail = (error: VisibilityError): VisibilityResult<never> => ({ ok: false, error });
async function exchange(baseURL: string, session: TransportSession, path: string, request: Reader,
  options: { readId?: string; body?: Record<string, unknown>; params?: Record<string, string>; allowHttpLoopbackForTests?: boolean }): Promise<VisibilityResult<Record<string, unknown>>> {
  if (!uuid(session.scope.coupleId) || !uuid(session.scope.userId) || !positive(session.scope.membershipEpoch)
    || !positive(session.credentialGeneration)) return fail('invalid_request');
  let origin: URL;
  try {
    origin = new URL(baseURL);
    const loopback = options.allowHttpLoopbackForTests === true && origin.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(origin.hostname);
    if ((origin.protocol !== 'https:' && !loopback) || origin.username || origin.password) return fail('invalid_request');
  } catch { return fail('invalid_request'); }
  const token = session.token;
  if (typeof token !== 'string' || (session.credentialKind === 'cookie'
    ? !token || token.length > 16384 || /[\x00-\x1f\x7f]/.test(token)
    : token.length > 2048 || !/^[A-Za-z0-9._~-]+$/.test(token))) return fail('invalid_token');
  const headers: Record<string,string> = session.credentialKind === 'cookie' ? { Cookie: token, Origin: origin.origin } : { Authorization: `Bearer ${token}` };
  headers['X-Chat-Visibility'] = '1';
  const url = new URL(`/v1/couples/${session.scope.coupleId}/chat/${path}`, origin);
  if (options.body) { headers['Content-Type'] = 'application/json'; headers['Idempotency-Key'] = String(options.body.command_id); }
  else {
    url.searchParams.set('membership_epoch', String(session.scope.membershipEpoch)); url.searchParams.set('read_id', options.readId!);
    for (const [key, value] of Object.entries(options.params ?? {})) url.searchParams.set(key, value);
  }
  let response: Response;
  try { response = await request(new Request(url, { method: options.body ? 'PUT' : 'GET', headers,
    body: options.body ? JSON.stringify(options.body) : undefined, redirect: 'error', credentials: 'omit', cache: 'no-store' })); }
  catch { return fail('transport_error'); }
  let json: unknown;
  try { json = await readBoundedJson(response, 65536); } catch { return fail('invalid_response'); }
  if (!record(json)) return fail('invalid_response');
  if (json.ok === false && (!keys(json, options.body ? 'ok,error' : 'ok,error,readId') || typeof json.error !== 'string'
    || (!options.body && json.readId !== options.readId))) return fail('invalid_response');
  if (json.ok === false && response.status === 401) return fail('auth_required');
  if (json.ok === false && response.status === 403) return fail('access_required');
  if (json.ok === false && response.status === 409 && json.error === 'stale_membership') return fail('access_required');
  const header = response.headers.get('X-Chat-Visibility-Revision');
  if (header === null || !/^(0|[1-9]\d*)$/.test(header) || !nonnegative(Number(header))) return fail('invalid_response');
  const revision = Number(header);
  if (json.ok === false) {
    if ((response.status === 409 || response.status === 400) && (json.error === 'invalid_cursor' || json.error === 'message_unavailable'
      || json.error === 'version_conflict' || json.error === 'idempotency_conflict' || json.error === 'visibility_changed')) return fail(json.error);
    if (response.status === 429) return fail('rate_limited');
    if (response.status >= 500 && response.status <= 599) return fail('transport_error');
    return fail('rejected');
  }
  if (!response.ok || json.ok !== true || !keys(json, 'ok,value') || !record(json.value) || 'revision' in json.value) return fail('invalid_response');
  return { ok: true, value: { ...json.value, revision } };
}
const capture = (session: TransportSession) => ({ ...session, scope: { ...session.scope } });
export async function readMessageVisibility(baseURL: string, session: TransportSession, options: ReadOptions, request: Reader): Promise<VisibilityResult<{ visibility: MessageVisibility; readId: string }>> {
  const current = capture(session), query = { ...options };
  if (!uuid(query.messageId) || !uuid(query.readId)) return fail('invalid_request');
  const result = await exchange(baseURL, current, `messages/${query.messageId}/visibility`, request, query);
  if (!result.ok) return result;
  if (!keys(result.value, 'visibility,readId,revision') || result.value.readId !== query.readId) return fail('invalid_response');
  const visibility = parseMessageVisibility(result.value.visibility, query.messageId);
  return visibility ? { ok: true, value: { visibility, readId: query.readId, revision: result.value.revision } } : fail('invalid_response');
}
export async function setMessageHidden(baseURL: string, session: TransportSession, options: SetOptions, request: Reader): Promise<VisibilityResult<{ visibility: MessageVisibility; commandId: string; replay: boolean }>> {
  const current = capture(session), command = { ...options };
  if (!uuid(command.messageId) || !uuid(command.commandId) || !nonnegative(command.expectedVisibilityVersion)
    || command.expectedVisibilityVersion >= 2147483647 || typeof command.hidden !== 'boolean') return fail('invalid_request');
  const result = await exchange(baseURL, current, `messages/${command.messageId}/hidden`, request, {
    allowHttpLoopbackForTests: command.allowHttpLoopbackForTests, body: { membership_epoch: current.scope.membershipEpoch,
      command_id: command.commandId, expected_visibility_version: command.expectedVisibilityVersion, hidden: command.hidden } });
  if (!result.ok) return result;
  if (!keys(result.value, 'visibility,commandId,replay,revision') || result.value.commandId !== command.commandId || typeof result.value.replay !== 'boolean') return fail('invalid_response');
  const visibility = parseMessageVisibility(result.value.visibility, command.messageId);
  if (!visibility || visibility.version < command.expectedVisibilityVersion || (!result.value.replay &&
    (visibility.hidden !== command.hidden || visibility.version > command.expectedVisibilityVersion + 1))) return fail('invalid_response');
  return { ok: true, value: { visibility, commandId: command.commandId, replay: result.value.replay, revision: result.value.revision } };
}
export async function readHiddenWindow(baseURL: string, session: TransportSession, options: HiddenWindowOptions, request: Reader): Promise<VisibilityResult<HiddenWindow>> {
  const current = capture(session), query = { ...options }, anchored = query.direction === 'before' || query.direction === 'after';
  if (!uuid(query.readId) || !['latest','oldest','before','after'].includes(query.direction)
    || (anchored ? !uuid(query.anchorId) || !positive(query.anchorSeq) || !nonnegative(query.visibilityRevision)
      : query.anchorId !== undefined || query.anchorSeq !== undefined || query.visibilityRevision !== undefined)) return fail('invalid_request');
  const params: Record<string,string> = { direction: query.direction };
  if (anchored) { params.anchor_id = query.anchorId!; params.anchor_seq = String(query.anchorSeq); params.visibility_revision = String(query.visibilityRevision); }
  const result = await exchange(baseURL, current, 'hidden-window', request, { ...query, params });
  if (!result.ok) return result;
  const { revision, ...wire } = result.value;
  const window = parseHiddenWindow(wire, query, current.scope.coupleId);
  return window && (!anchored || revision === query.visibilityRevision) ? { ok: true, value: { ...window, revision } } : fail('invalid_response');
}
