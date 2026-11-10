import type { AuthorizedDatabase } from './contracts.ts';
import { listLetters, openLetter, sendLetter } from './letters.ts';
import { readJson } from './http.ts';
import { isUuid } from './validation.ts';
const response = (status: number, body: unknown) => Response.json(body, { status,
  headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    ...(status === 405 ? { allow: 'GET, POST' } : {}) } });
const error = (status: number, code: string) => response(status, { ok: false, error: code });
export function createLettersHandler(db: AuthorizedDatabase) {
  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      const route = url.pathname.match(/^\/v1\/couples\/([^/]+)\/letters(?:\/([^/]+))?$/);
      if (!route) return error(404, 'not_found');
      if (!['GET', 'POST'].includes(request.method) || (route[2] && request.method !== 'GET')) return error(405, 'method_not_allowed');
      const principal = await db.sessionAuthority.authenticate(request);
      if (!principal || principal.source !== db.sessionAuthority.source || !isUuid(principal.userId)) return error(401, 'unauthenticated');
      let input: unknown;
      if (request.method === 'POST') {
        if (url.search) return error(400, 'invalid_request');
        if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return error(415, 'unsupported_media_type');
        let body: unknown;
        try { body = await readJson(request); } catch { return error(400, 'invalid_request'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)
          || Object.keys(body).sort().join(',') !== 'body,client_letter_id,membership_epoch') return error(400, 'invalid_request');
        const fields = body as Record<string, unknown>;
        if (!isUuid(fields.client_letter_id) || request.headers.get('idempotency-key') !== fields.client_letter_id) return error(400, 'invalid_request');
        input = { coupleId: route[1], clientId: fields.client_letter_id, membershipEpoch: fields.membership_epoch, body: fields.body };
      } else {
        if (request.body || [...url.searchParams.keys()].join(',') !== 'membership_epoch'
          || !/^[1-9][0-9]*$/.test(url.searchParams.get('membership_epoch') ?? '')) return error(400, 'invalid_request');
        input = { coupleId: route[1], membershipEpoch: Number(url.searchParams.get('membership_epoch')), ...(route[2] ? { letterId: route[2] } : {}) };
      }
      const result = request.method === 'POST' ? await sendLetter(db, principal, input) : route[2] ? await openLetter(db, principal, input) : await listLetters(db, principal, input);
      if (result.ok) return response('replay' in result.value && !result.value.replay ? 201 : 200, result);
      return response(result.error === 'unavailable' ? 403
        : ['stale_membership', 'idempotency_conflict'].includes(result.error) ? 409 : 400, result);
    } catch { return error(503, 'temporarily_unavailable'); }
  };
}
