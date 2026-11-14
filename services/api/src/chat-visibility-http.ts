import type { AuthorizedDatabase } from './contracts.ts';
import { readJson } from './http.ts';
import { isUuid } from './validation.ts';
import { windowReadId } from './chat-history-window-http.ts';
import { readChatVisibility, setChatVisibility } from './chat-visibility.ts';
import { readHiddenWindow } from './chat-hidden-window.ts';
export function createChatVisibilityHandler(db: AuthorizedDatabase) {
    return async (request: Request): Promise<Response> => {
        const url = new URL(request.url), reading = request.method === 'GET';
        const reply = (status: number, body: unknown) => Response.json(body, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
        const fail = (status: number, error: string) => reply(status, { ok: false, error, ...(reading ? { readId: windowReadId(request) } : {}) });
        try {
            const route = url.pathname.match(/^\/v1\/couples\/([^/]+)\/chat\/(hidden-window|messages\/([^/]+)\/(hidden|visibility))$/);
            if (!route)
                return fail(404, 'not_found');
            const list = route[2] === 'hidden-window', write = route[4] === 'hidden';
            if (request.method !== (write ? 'PUT' : 'GET'))
                return fail(405, 'method_not_allowed');
            const p = await db.sessionAuthority.authenticate(request);
            if (!p || p.source !== db.sessionAuthority.source || !isUuid(p.userId))
                return fail(401, 'unauthenticated');
            let input: unknown;
            if (write) {
                if (url.search)
                    return fail(400, 'invalid_request');
                if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json')
                    return fail(415, 'unsupported_media_type');
                let raw: unknown;
                try {
                    raw = await readJson(request);
                }
                catch {
                    return fail(400, 'invalid_request');
                }
                if (!raw || typeof raw !== 'object' || Array.isArray(raw))
                    return fail(400, 'invalid_request');
                const f = raw as Record<string, unknown>;
                if (Object.keys(f).sort().join(',') !== 'command_id,expected_visibility_version,hidden,membership_epoch'
                    || !isUuid(f.command_id) || request.headers.get('idempotency-key') !== f.command_id)
                    return fail(400, 'invalid_request');
                input = { coupleId: route[1], messageId: route[3], membershipEpoch: f.membership_epoch, commandId: f.command_id,
                    expectedVersion: f.expected_visibility_version, hidden: f.hidden };
            }
            else {
                const q = url.searchParams, anchored = q.get('direction') === 'before' || q.get('direction') === 'after';
                const keys = ['membership_epoch', 'read_id', ...(list ? ['direction', ...(anchored ? ['anchor_id', 'anchor_seq', 'visibility_revision'] : [])] : [])];
                if ([...q.keys()].length !== keys.length || keys.some(k => q.getAll(k).length !== 1) || !windowReadId(request)
                    || !/^[1-9][0-9]*$/.test(q.get('membership_epoch') ?? ''))
                    return fail(400, 'invalid_request');
                input = { coupleId: route[1], membershipEpoch: Number(q.get('membership_epoch')), readId: windowReadId(request),
                    ...(list ? { direction: q.get('direction'), ...(anchored ? { anchorId: q.get('anchor_id'), anchorSeq: Number(q.get('anchor_seq')),
                            visibilityRevision: /^(0|[1-9][0-9]*)$/.test(q.get('visibility_revision') ?? '') ? Number(q.get('visibility_revision')) : NaN } : {}) } : { messageId: route[3] }) };
            }
            const result = write ? await setChatVisibility(db, p, input) : list ? await readHiddenWindow(db, p, input) : await readChatVisibility(db, p, input);
            if (!result.ok)
                return fail(result.error === 'unavailable' ? 403 : ['version_conflict', 'idempotency_conflict', 'stale_membership', 'visibility_changed', 'message_unavailable'].includes(result.error) ? 409 : 400, result.error);
            return reply(200, result);
        }
        catch {
            return fail(503, 'temporarily_unavailable');
        }
    };
}
