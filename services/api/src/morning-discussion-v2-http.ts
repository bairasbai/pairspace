import { readMorningDiscussionMessage } from './morning-discussions.ts';
import type { AuthorizedDatabase } from './contracts.ts';
import { isUuid } from './validation.ts';
import { readJson } from './http.ts';
import { windowReadId } from './chat-history-window-http.ts';
import { createMorningDiscussionsHandler } from './morning-discussions-http.ts';
import { mutateMorningDiscussion } from './morning-discussion-mutations.ts';
export function createMorningDiscussionV2Handler(db: AuthorizedDatabase) {
    const reads = createMorningDiscussionsHandler(db, true);
    return async (request: Request): Promise<Response> => {
        const url = new URL(request.url);
        const route = url.pathname.match(/^\/v1\/couples\/([^/]+)\/mornings\/slots\/([^/]+)\/discussion-v2(?:\/([^/]+))?$/);
        if (route && !route[3])
            return reads(request);
        const json = (status: number, body: unknown) => Response.json(body, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
        const fail = (status: number, error: string) => json(status, { ok: false, error, ...(request.method === 'GET' ? { readId: windowReadId(request) } : {}) });
        try {
            if (!route)
                return fail(404, 'not_found');
            if (!['GET', 'PATCH', 'DELETE'].includes(request.method))
                return fail(405, 'method_not_allowed');
            const p = await db.sessionAuthority.authenticate(request);
            if (!p || p.source !== db.sessionAuthority.source || !isUuid(p.userId))
                return fail(401, 'unauthenticated');
            if (request.method === 'GET') {
                const q = url.searchParams;
                if ([...q.keys()].length !== 2 || q.getAll('membership_epoch').length !== 1 || q.getAll('read_id').length !== 1
                    || !/^[1-9][0-9]*$/.test(q.get('membership_epoch') ?? '') || !windowReadId(request))
                    return fail(400, 'invalid_request');
                const result = await readMorningDiscussionMessage(db, p, { coupleId: route[1], slotId: route[2], messageId: route[3], membershipEpoch: Number(q.get('membership_epoch')), readId: windowReadId(request) });
                if (!result.ok)
                    return fail(result.error === 'unavailable' ? 403 : result.error === 'stale_membership' ? 409 : 400, result.error);
                return json(200, result);
            }
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
            const f = raw as Record<string, unknown>, editing = request.method === 'PATCH';
            const keys = ['membership_epoch', 'command_id', 'expected_version', editing ? 'body' : 'confirm'];
            if (Object.keys(f).sort().join(',') !== keys.sort().join(',') || !isUuid(f.command_id) || request.headers.get('idempotency-key') !== f.command_id)
                return fail(400, 'invalid_request');
            const result = await mutateMorningDiscussion(db, p, { coupleId: route[1], slotId: route[2], messageId: route[3], membershipEpoch: f.membership_epoch,
                commandId: f.command_id, expectedVersion: f.expected_version, ...(editing ? { body: f.body } : { confirm: f.confirm }) }, editing ? 'edit' : 'delete');
            if (!result.ok) {
                if (result.error === 'message_deleted')
                    return json(409, result);
                return fail(result.error === 'unavailable' ? 403 : result.error === 'invalid_request' ? 400 : 409, result.error);
            }
            return json(200, result);
        }
        catch {
            return fail(503, 'temporarily_unavailable');
        }
    };
}
