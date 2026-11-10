import type { AuthorizedDatabase } from './contracts.ts';
import { readCareSignal, sendCareSignal } from './care-signals.ts';
import { readJson } from './http.ts';
import { isUuid } from './validation.ts';
const response = (status: number, body: unknown) => Response.json(body, { status,
  headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    ...(status === 405 ? { allow: 'GET, POST' } : {}), ...(status === 429 ? { 'retry-after': '60' } : {}) } });
const error = (status: number, code: string) => response(status, { ok: false, error: code });
export function createCareSignalHandler(db: AuthorizedDatabase) {
  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      const route = url.pathname.match(/^\/v1\/couples\/([^/]+)\/care-signals$/);
      if (!route) return error(404, 'not_found');
      if (!['GET', 'POST'].includes(request.method)) return error(405, 'method_not_allowed');
      const principal = await db.sessionAuthority.authenticate(request);
      if (!principal || principal.source !== db.sessionAuthority.source || !isUuid(principal.userId)) return error(401, 'unauthenticated');
      let input: unknown;
      if (request.method === 'POST') {
        if (url.search) return error(400, 'invalid_request');
        if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return error(415, 'unsupported_media_type');
        let body: unknown;
        try { body = await readJson(request); } catch { return error(400, 'invalid_request'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)
          || Object.keys(body).sort().join(',') !== 'client_signal_id,membership_epoch') return error(400, 'invalid_request');
        const fields = body as Record<string, unknown>;
        if (!isUuid(fields.client_signal_id) || request.headers.get('idempotency-key') !== fields.client_signal_id) return error(400, 'invalid_request');
        input = { coupleId: route[1], clientId: fields.client_signal_id, membershipEpoch: fields.membership_epoch };
      } else {
        if (request.body || [...url.searchParams.keys()].join(',') !== 'membership_epoch'
          || !/^[1-9][0-9]*$/.test(url.searchParams.get('membership_epoch') ?? '')) return error(400, 'invalid_request');
        input = { coupleId: route[1], membershipEpoch: Number(url.searchParams.get('membership_epoch')) };
      }
      const result = request.method === 'POST' ? await sendCareSignal(db, principal, input) : await readCareSignal(db, principal, input);
      if (result.ok) return response('replay' in result.value && !result.value.replay ? 201 : 200, result);
      return response(result.error === 'unavailable' ? 403 : result.error === 'cooldown' ? 429
        : ['stale_membership', 'idempotency_conflict'].includes(result.error) ? 409 : 400, result);
    } catch { return error(503, 'temporarily_unavailable'); }
  };
}
