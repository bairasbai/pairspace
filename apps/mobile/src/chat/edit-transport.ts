import { visibilityMetadata } from './visibility-revision';
import { parseHiddenMessage, type HiddenMessage } from './visibility-model';
import { readBoundedJson, type TransportError, type TransportSession } from './transport';
import { keys, positive, record, uuid, parseReplyMessage, type ReplyMessage } from './reply-model';
import type { DeleteTarget } from './delete-transport';
import { normalizeMessageText } from './text';
export type EditChatError = TransportError | 'message_unavailable' | 'version_conflict' | 'message_deleted' | 'idempotency_conflict';
export type EditChatResult = Readonly<
    { ok: true; visibilityRevision?: number; value: Readonly<
        { message: ReplyMessage; replay: boolean; commandId: string }
        | { hiddenMessage: HiddenMessage; replay: true; commandId: string }> }
    | { ok: false; error: Exclude<EditChatError, 'message_deleted'> }
    | { ok: false; error: 'message_deleted'; message: ReplyMessage; visibilityRevision?: number }
>;
export type EditChatOptions = Readonly<{
    message: DeleteTarget;
    commandId: string;
    body: string;
    allowHttpLoopbackForTests?: boolean;
}>;
const fail = (error: Exclude<EditChatError, 'message_deleted'>): EditChatResult => ({ ok: false, error });
function deletedMessage(value: unknown, target: DeleteTarget, exactVersion: boolean): ReplyMessage | null {
    const parsed = parseReplyMessage(value, target.coupleId);
    if (!parsed || parsed.body !== null || parsed.deletedAt === null
        || (exactVersion ? parsed.version !== target.version + 1 : parsed.version <= target.version))
        return null;
    const fixed = ['id', 'coupleId', 'senderId', 'clientId', 'seq', 'createdAt', 'replyToId'] as const;
    return fixed.some(key => parsed[key] !== target[key]) ? null : parsed;
}
/** Pure transport: callers retain pending commands and enforce session/generation guards. */
export async function editChatMessage(baseURL: string, session: TransportSession, options: EditChatOptions, request: (request: Request) => Promise<Response>): Promise<EditChatResult> {
    const current = { ...session, scope: { ...session.scope } };
    const source = options.message;
    if (!record(source) || !keys(source, 'id,coupleId,senderId,clientId,seq,version,createdAt,replyToId'))
        return fail('invalid_request');
    const target: DeleteTarget = { id: source.id, coupleId: source.coupleId, senderId: source.senderId,
        clientId: source.clientId, seq: source.seq, version: source.version, createdAt: source.createdAt, replyToId: source.replyToId };
    const normalized = normalizeMessageText(options.body);
    if (!normalized.ok)
        return fail(normalized.error);
    const command = { body: normalized.text, commandId: options.commandId, allowHttpLoopbackForTests: options.allowHttpLoopbackForTests };
    if (!uuid(current.scope.userId) || !uuid(current.scope.coupleId) || !positive(current.scope.membershipEpoch)
        || !positive(current.credentialGeneration) || !uuid(command.commandId) || target.senderId !== current.scope.userId
        || !positive(target.version)
        || !Number.isSafeInteger(target.version + 1))
        return fail('invalid_request');
    if (!keys(target, 'id,coupleId,senderId,clientId,seq,version,createdAt,replyToId')
        || !uuid(target.id) || !uuid(target.coupleId) || target.coupleId !== current.scope.coupleId
        || !uuid(target.senderId) || !uuid(target.clientId) || !positive(target.seq)
        || (target.replyToId !== null && (!uuid(target.replyToId) || target.replyToId === target.id))
        || typeof target.createdAt !== 'string' || target.createdAt.length > 64
        || !Number.isFinite(Date.parse(target.createdAt)))
        return fail('invalid_request');
    const pinned = target;
    let origin: URL;
    try {
        origin = new URL(baseURL);
        const loopback = command.allowHttpLoopbackForTests === true && origin.protocol === 'http:'
            && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
        if ((origin.protocol !== 'https:' && !loopback) || origin.username || origin.password)
            return fail('invalid_request');
    }
    catch {
        return fail('invalid_request');
    }
    const token = current.token;
    if (typeof token !== 'string' || (current.credentialKind === 'cookie'
        ? !token || token.length > 16384 || /[\x00-\x1f\x7f]/.test(token)
        : token.length > 2048 || !/^[A-Za-z0-9._~-]+$/.test(token)))
        return fail('invalid_token');
    const headers: Record<string, string> = current.credentialKind === 'cookie'
        ? { Cookie: token, Origin: origin.origin } : { Authorization: `Bearer ${token}` };
    headers['Content-Type'] = 'application/json';
    headers['Idempotency-Key'] = command.commandId;
    const url = new URL(`/v1/couples/${current.scope.coupleId}/chat/messages/${pinned.id}`, origin);
    const body = { membership_epoch: current.scope.membershipEpoch, command_id: command.commandId,
        expected_version: pinned.version, body: command.body };
    let response: Response;
    try {
        response = await request(new Request(url, { method: 'PATCH', headers, body: JSON.stringify(body),
            redirect: 'error', credentials: 'omit', cache: 'no-store' }));
    }
    catch {
        return fail('transport_error');
    }
    let json: unknown;
    try {
        json = await readBoundedJson(response, 65536);
    }
    catch {
        return fail('invalid_response');
    }
    if (!record(json))
        return fail('invalid_response');
    if (json.ok === false) {
        if (json.error === 'message_deleted') {
            if (response.status !== 409 || !keys(json, 'ok,error,value') || !record(json.value)
                || !keys(json.value, 'commandId,message') || json.value.commandId !== command.commandId)
                return fail('invalid_response');
            const message = deletedMessage(json.value.message, pinned, false);
            return message ? { ok: false, error: 'message_deleted', message, ...visibilityMetadata(response) } : fail('invalid_response');
        }
        if (!keys(json, 'ok,error') || typeof json.error !== 'string')
            return fail('invalid_response');
        if (response.status === 401)
            return fail('auth_required');
        if (response.status === 403 || (response.status === 409 && json.error === 'stale_membership'))
            return fail('access_required');
        if (response.status === 409 && (json.error === 'message_unavailable' || json.error === 'version_conflict'
            || json.error === 'idempotency_conflict'))
            return fail(json.error);
        if (json.error === 'visibility_changed' || json.error === 'message_hidden') return fail(json.error);
    if (response.status === 429)
            return fail('rate_limited');
        if (response.status >= 500 && response.status <= 599)
            return fail('transport_error');
        return fail('rejected');
    }
    if (response.ok && keys(json, 'ok,value') && json.ok === true && record(json.value) && Object.hasOwn(json.value, 'hiddenMessage')) {
      const hidden = parseHiddenMessage(json.value.hiddenMessage, pinned.coupleId);
      const fixed = ['id','coupleId','senderId','clientId','seq','createdAt','replyToId'] as const;
      if (!keys(json.value, 'commandId,replay,hiddenMessage') || json.value.commandId !== command.commandId || json.value.replay !== true
        || !hidden || fixed.some(key => hidden[key] !== pinned[key]) || hidden.version < pinned.version) return fail('invalid_response');
      return { ok: true, value: { commandId: command.commandId, replay: true, hiddenMessage: hidden }, ...visibilityMetadata(response) };
    }
    if (!response.ok || !keys(json, 'ok,value') || json.ok !== true || !record(json.value)
        || !keys(json.value, 'message,replay,commandId') || json.value.commandId !== command.commandId
        || typeof json.value.replay !== 'boolean')
        return fail('invalid_response');
    const message = parseReplyMessage(json.value.message, pinned.coupleId);
    const fixed = ['id', 'coupleId', 'senderId', 'clientId', 'seq', 'createdAt', 'replyToId'] as const;
    if (!message || fixed.some(key => message[key] !== pinned[key])
        || (json.value.replay
            ? message.version < pinned.version || (message.version === pinned.version
                && (message.body !== command.body || message.deletedAt !== null))
            : (message.version !== pinned.version && message.version !== pinned.version + 1)
                || message.body !== command.body || message.deletedAt !== null))
        return fail('invalid_response');
    return { ok: true, value: Object.freeze({ message, replay: json.value.replay, commandId: command.commandId }), ...visibilityMetadata(response) };
}
