import type { AuthorizedDatabase } from './contracts.ts';
import { createLoveWord, editLoveWord, deleteLoveWord, listLoveWords } from './love-words.ts';
import { readJson } from './http.ts';
import { isUuid } from './validation.ts';
export function createLoveWordsHandler(db: AuthorizedDatabase) {
    return async (request: Request): Promise<Response> => {
        let allow = 'GET, POST';
        const response = (status: number, body: unknown) => Response.json(body, { status,
            headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...(status === 405 ? { allow } : {}) } });
        const error = (status: number, code: string) => response(status, { ok: false, error: code });
        try {
            const url = new URL(request.url), route = url.pathname.match(/^\/v1\/couples\/([^/]+)\/love-words(?:\/([^/]+))?$/);
            if (!route)
                return error(404, 'not_found');
            allow = route[2] ? 'PUT, DELETE' : 'GET, POST';
            if (!allow.split(', ').includes(request.method))
                return error(405, 'method_not_allowed');
            const principal = await db.sessionAuthority.authenticate(request);
            if (!principal || principal.source !== db.sessionAuthority.source || !isUuid(principal.userId))
                return error(401, 'unauthenticated');
            let input: unknown;
            if (request.method === 'GET') {
                if (request.body || [...url.searchParams.keys()].join(',') !== 'membership_epoch'
                    || !/^[1-9][0-9]*$/.test(url.searchParams.get('membership_epoch') ?? ''))
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
                const allowed = ['membership_epoch', 'command_id', ...(route[2] ? ['expected_version'] : []),
                    ...(request.method === 'DELETE' ? [] : ['word', 'meaning', 'said_when'])];
                if (Object.keys(fields).some(key => !allowed.includes(key)) || !isUuid(fields.command_id)
                    || request.headers.get('idempotency-key') !== fields.command_id)
                    return error(400, 'invalid_request');
                input = { coupleId: route[1], membershipEpoch: fields.membership_epoch, commandId: fields.command_id,
                    ...(route[2] ? { wordId: route[2], expectedVersion: fields.expected_version } : {}),
                    ...(request.method === 'DELETE' ? {} : { word: fields.word, meaning: fields.meaning, saidWhen: fields.said_when }) };
            }
            const operation = request.method === 'GET' ? listLoveWords : request.method === 'POST' ? createLoveWord : request.method === 'PUT' ? editLoveWord : deleteLoveWord;
            const result = await operation(db, principal, input);
            return response(result.ok ? 200 : result.error === 'unavailable' ? 403 : result.error === 'invalid_request' ? 400 : 409, result);
        }
        catch {
            return error(503, 'temporarily_unavailable');
        }
    };
}
