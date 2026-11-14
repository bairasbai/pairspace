import type { AuthorizedDatabase } from './contracts.ts';
import { isUuid } from './validation.ts';
import { readJson } from './http.ts';
import { windowReadId } from './chat-history-window-http.ts';
import { readMorningDiscussion, sendMorningDiscussion } from './morning-discussions.ts';
export function createMorningDiscussionsHandler(db: AuthorizedDatabase, v2 = false) {
    return async (request: Request): Promise<Response> => {
        const reading = request.method === 'GET';
        const json = (status: number, body: unknown) => Response.json(body, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
        const fail = (status: number, error: string) => json(status, { ok: false, error, ...(reading ? { readId: windowReadId(request) } : {}) });
        try {
            const url = new URL(request.url), route = (v2 ? url.pathname.replace(/\/discussion-v2$/, '/discussion') : url.pathname).match(/^\/v1\/couples\/([^/]+)\/mornings\/slots\/([^/]+)\/discussion$/);
            if (!route)
                return fail(404, 'not_found');
            if (!reading && request.method !== 'POST')
                return fail(405, 'method_not_allowed');
            const p = await db.sessionAuthority.authenticate(request);
            if (!p || p.source !== db.sessionAuthority.source || !isUuid(p.userId))
                return fail(401, 'unauthenticated');
            if (reading) {
                const q = url.searchParams, anchored = q.get('direction') === 'before' || q.get('direction') === 'after';
                const keys = ['membership_epoch', 'read_id', 'direction', ...(anchored ? ['anchor_id', 'anchor_seq'] : [])];
                if ([...q.keys()].length !== keys.length || keys.some(k => q.getAll(k).length !== 1) || !windowReadId(request)
                    || !/^[1-9][0-9]*$/.test(q.get('membership_epoch') ?? ''))
                    return fail(400, 'invalid_request');
                if (anchored && !/^[1-9][0-9]*$/.test(q.get('anchor_seq') ?? ''))
                    return fail(400, 'invalid_cursor');
                const readInput = { coupleId: route[1], slotId: route[2], membershipEpoch: Number(q.get('membership_epoch')),
                    readId: windowReadId(request), direction: q.get('direction'), ...(anchored ? { anchorId: q.get('anchor_id'), anchorSeq: Number(q.get('anchor_seq')) } : {}) };
                const result = v2 ? await readMorningDiscussion(db, p, readInput, true) : await readMorningDiscussion(db, p, readInput);
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
            const f = raw as Record<string, unknown>;
            if (Object.keys(f).sort().join(',') !== 'body,command_id,membership_epoch' || !isUuid(f.command_id) || request.headers.get('idempotency-key') !== f.command_id)
                return fail(400, 'invalid_request');
            const sendInput = { coupleId: route[1], slotId: route[2], membershipEpoch: f.membership_epoch, commandId: f.command_id, body: f.body };
            const result = v2 ? await sendMorningDiscussion(db, p, sendInput, true) : await sendMorningDiscussion(db, p, sendInput);
            if (!result.ok)
                return fail(result.error === 'unavailable' ? 403 : result.error === 'invalid_request' ? 400 : 409, result.error);
            return json(200, result);
        }
        catch {
            return fail(503, 'temporarily_unavailable');
        }
    };
}
