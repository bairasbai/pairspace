import { readBoundedJson } from './transport';
import { keys, record } from './reply-model';
import type { Scope } from './types';
import { VISIBILITY_HEADER, visibilityRevision } from './visibility-revision';
type Capture = {
    generation: number;
    scope: Scope;
};
type Host = {
    capture(): Capture | null;
    cookie(): Promise<string | null>;
    advance(): void;
};
const scopeKey = (value: Capture) => `${value.generation}/${value.scope.sessionId}/${value.scope.userId}/${value.scope.coupleId}/${value.scope.membershipEpoch}`;
/** One revision per verified account/pair/epoch, never a collection of hidden IDs. */
export function createVisibilityFence(host: Host) {
    let scope: string | null = null, revision: number | null = null;
    const stillCurrent = (key: string) => {
        const current = host.capture();
        return current !== null && scopeKey(current) === key;
    };
    return {
        reset() { scope = null; revision = null; },
        revision: () => revision,
        async exchange(input: Request, request: (request: Request) => Promise<Response>, valid: () => boolean = () => true) {
            const url = new URL(input.url);
            const captured = host.capture();
            if (!url.pathname.includes('/chat/') || !captured)
                return request(input);
            const key = scopeKey(captured);
            if (scope !== key) {
                scope = key;
                revision = null;
            }
            const started = revision;
            const headers = new Headers(input.headers);
            headers.set('X-Chat-Visibility', '1');
            const response = await request(new Request(input, { headers }));
            // Authentication denials retain their established precedence and parsing.
            if (!valid() || !stillCurrent(key) || response.status === 401 || response.status === 403)
                return response;
            const json = await readBoundedJson(response.clone(), 4 * 1024 * 1024);
            if (!valid() || !stillCurrent(key))
                return response;
            const readId = url.searchParams.get('read_id');
            if (readId !== null) {
                const echoed = record(json) && json.ok === true && record(json.value) ? json.value.readId : record(json) ? json.readId : null;
                if (echoed !== readId)
                    throw Error('invalid_read_identity');
            }
            if (response.status === 409 && record(json) && json.ok === false
                && json.error === 'stale_membership' && keys(json, readId === null ? 'ok,error' : 'ok,error,readId'))
                return response;
            const received = visibilityRevision(response);
            if (received === null)
                throw Error('invalid_visibility_revision');
            const cookie = await host.cookie();
            if (!valid() || !stillCurrent(key))
                return response;
            if (cookie !== input.headers.get('cookie')) {
                const value = { ok: false, error: 'unavailable', ...(readId === null ? {} : { readId }) };
                return new Response(JSON.stringify(value), { status: 403 });
            }
            const metadataOnly = url.pathname.endsWith('/hidden') || url.pathname.endsWith('/visibility') || url.pathname.endsWith('/hidden-window');
            const committedHidden = record(json) && json.ok === true && record(json.value) && Object.hasOwn(json.value, 'hiddenMessage');
            const higher = revision !== null && received > revision;
            const lower = revision !== null && received < revision;
            if (revision === null || higher) {
                revision = received;
                if (higher)
                    host.advance();
            }
            if (lower || (!metadataOnly && !committedHidden && (higher || (started !== null && started !== revision)))) {
                return new Response(JSON.stringify({ ok: false, error: 'visibility_changed', ...(readId === null ? {} : { readId }) }), {
                    status: 409, headers: { [VISIBILITY_HEADER]: String(revision) },
                });
            }
            return response;
        },
    };
}
