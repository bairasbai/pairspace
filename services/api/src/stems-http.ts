import type { AuthorizedDatabase } from './contracts.ts';
import { createStem, completeStem, skipStem, removeAuthorBundle, removeRecipientContinuation, listStems } from './stems.ts';
import { readJson } from './http.ts';
import { isUuid } from './validation.ts';
export function createStemsHandler(db: AuthorizedDatabase) {
    return async (request: Request): Promise<Response> => {
        let allow = 'GET, POST';
        const response = (status: number, body: unknown) => Response.json(body, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...(status === 405 ? { allow } : {}) } });
        const error = (status: number, code: string) => response(status, { ok: false, error: code });
        try {
            const url = new URL(request.url), route = url.pathname.match(/^\/v1\/couples\/([^/]+)\/stems(?:\/([^/]+)\/(complete|skip|author-bundle|recipient-continuation))?$/);
            if (!route)
                return error(404, 'not_found');
            allow = !route[2] ? 'GET, POST' : ['complete', 'skip'].includes(route[3]) ? 'POST' : 'DELETE';
            if (!allow.split(', ').includes(request.method))
                return error(405, 'method_not_allowed');
            const principal = await db.sessionAuthority.authenticate(request);
            if (!principal || principal.source !== db.sessionAuthority.source || !isUuid(principal.userId))
                return error(401, 'unauthenticated');
            let input: unknown;
            if (request.method === 'GET') {
                if (request.body || [...url.searchParams.keys()].join(',') !== 'membership_epoch' || !/^[1-9][0-9]*$/.test(url.searchParams.get('membership_epoch') ?? ''))
                    return error(400, 'invalid_request');
                input = { coupleId: route[1], membershipEpoch: Number(url.searchParams.get('membership_epoch')) };
            }
            else {
                if (url.search)
                    return error(400, 'invalid_request');
                if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json')
                    return error(415, 'unsupported_media_type');
                let body: unknown;
                try {
                    body = await readJson(request);
                }
                catch {
                    return error(400, 'invalid_request');
                }
                if (!body || typeof body !== 'object' || Array.isArray(body))
                    return error(400, 'invalid_request');
                const fields = body as Record<string, unknown>;
                const hasText = route[3] === 'complete';
                const create = !route[2];
                const keys = ['membership_epoch', 'command_id', ...(route[2] ? ['expected_version'] : []), ...(hasText ? ['continuation'] : []), ...(create ? ['beginning', 'own_continuation'] : [])];
                if (Object.keys(fields).sort().join() !== keys.sort().join() || !isUuid(fields.command_id) || request.headers.get('idempotency-key') !== fields.command_id)
                    return error(400, 'invalid_request');
                input = { coupleId: route[1], membershipEpoch: fields.membership_epoch, commandId: fields.command_id, ...(route[2] ? { roundId: route[2], expectedVersion: fields.expected_version } : {}), ...(hasText ? { continuation: fields.continuation } : {}), ...(create ? { beginning: fields.beginning, ownContinuation: fields.own_continuation } : {}) };
            }
            const operation = request.method === 'GET' ? listStems : !route[2] ? createStem : route[3] === 'skip' ? skipStem : route[3] === 'author-bundle' ? removeAuthorBundle : request.method === 'POST' ? completeStem : removeRecipientContinuation;
            const result = await operation(db, principal, input);
            return response(result.ok ? 200 : result.error === 'unavailable' ? 403 : result.error === 'invalid_request' ? 400 : 409, result);
        }
        catch {
            return error(503, 'temporarily_unavailable');
        }
    };
}
