import { readBoundedJson } from '../chat/transport';
import { record, keys } from '../chat/reply-model';
import { readSessionContext, type SessionContext } from './context';
import type { InvitationHost, InvitationHostSnapshot } from './invitations-controller';
import type { SyntheticConfig } from './config';
export const sameMorningContext = (a: SessionContext, b: SessionContext) => a.state === 'ready' && b.state === 'ready'
    && a.sessionId === b.sessionId && a.userId === b.userId && a.coupleId === b.coupleId && a.membershipEpoch === b.membershipEpoch;
export type MorningResult = {
    ok: true;
    value: Record<string, unknown>;
    cookie: string;
} | {
    ok: false;
    error: string;
    canonical?: Record<string, unknown>;
    cookie?: string;
};
export async function requestMorning(config: SyntheticConfig, host: InvitationHost, expected: InvitationHostSnapshot, current: () => boolean, request: (input: Request) => Promise<Response>, options: {
    path: string;
    method?: string;
    commandId?: string;
    readId?: string;
    query?: Record<string, string>;
    body?: Record<string, unknown>;
    canonicalDeleted?: boolean;
    canonicalDraftDeleted?: boolean;
}): Promise<MorningResult> {
    try {
        const cookie = await host.getCookie();
        if (!current())
            return { ok: false, error: 'stale' };
        const binding = await readSessionContext(config, expected.identity.sessionId, cookie, request);
        if (!current())
            return { ok: false, error: 'stale' };
        if (!binding.ok)
            return { ok: false, error: binding.error === 'transport_error' ? 'transport_error' : 'auth_required' };
        if (!sameMorningContext(expected.context, binding.value))
            return { ok: false, error: 'scope_changed' };
        if (await host.getCookie() !== cookie)
            return { ok: false, error: 'auth_required' };
        if (!current() || binding.value.state !== 'ready')
            return { ok: false, error: 'stale' };
        const url = new URL(`/v1/couples/${binding.value.coupleId}/mornings${options.path}`, config.baseURL);
        if (!options.body) {
            url.searchParams.set('membership_epoch', String(binding.value.membershipEpoch));
            url.searchParams.set('read_id', options.readId!);
            for (const [key, value] of Object.entries(options.query ?? {}))
                url.searchParams.set(key, value);
        }
        const response = await request(new Request(url, { method: options.method ?? 'GET',
            headers: { Cookie: cookie, Origin: config.baseURL, ...(options.body ? { 'Content-Type': 'application/json', 'Idempotency-Key': options.commandId! } : {}) },
            ...(options.body ? { body: JSON.stringify({ membership_epoch: binding.value.membershipEpoch, command_id: options.commandId, ...options.body }) } : {}),
            redirect: 'error', credentials: 'omit', cache: 'no-store' }));
        const body: unknown = await readBoundedJson(response, 1024 * 1024);
        if (!current())
            return { ok: false, error: 'stale' };
        if (await host.getCookie() !== cookie)
            return { ok: false, error: 'auth_required' };
        if (!current())
            return { ok: false, error: 'stale' };
        if (!record(body))
            return { ok: false, error: 'invalid_response' };
        if (body.ok === false) {
            if (options.canonicalDraftDeleted && response.status === 409 && body.error === 'draft_deleted'
                && keys(body, 'ok,error,value') && record(body.value))
                return { ok: false, error: 'draft_deleted', canonical: body.value, cookie };
            if (options.canonicalDeleted && response.status === 409 && body.error === 'message_deleted'
                && keys(body, 'ok,error,value') && record(body.value))
                return { ok: false, error: 'message_deleted', canonical: body.value, cookie };
            if (!keys(body, options.body ? 'ok,error' : 'ok,error,readId') || typeof body.error !== 'string'
                || (!options.body && body.readId !== options.readId))
                return { ok: false, error: 'invalid_response' };
            if (response.status === 401)
                return { ok: false, error: 'auth_required' };
            if (response.status === 403 || (response.status === 409 && body.error === 'stale_membership'))
                return { ok: false, error: 'access_required' };
            return { ok: false, error: response.status >= 500 ? 'transport_error' : body.error };
        }
        return response.ok && body.ok === true && keys(body, 'ok,value') && record(body.value)
            ? { ok: true, value: body.value, cookie } : { ok: false, error: 'invalid_response' };
    }
    catch {
        return { ok: false, error: 'transport_error' };
    }
}
