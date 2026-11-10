import type { AuthorizedDatabase } from './contracts.ts';
import { createSharedDate, listSharedDates } from './shared-dates.ts';
import { readJson } from './http.ts';
import { isUuid } from './validation.ts';
const response = (status: number, body: unknown) => Response.json(body, { status,
  headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    ...(status === 405 ? { allow: 'GET, POST' } : {}) } });
const error = (status: number, code: string) => response(status, { ok: false, error: code });
export function createSharedDatesHandler(db: AuthorizedDatabase) {
  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      const route = url.pathname.match(/^\/v1\/couples\/([^/]+)\/dates$/);
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
        const keys = 'command_id,local_date,membership_epoch,timezone,title';
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).filter(key => !['recurrence', 'leap_day_policy'].includes(key)).sort().join(',') !== keys) return error(400, 'invalid_request');
        const fields = body as Record<string, unknown>;
        if (!isUuid(fields.command_id) || request.headers.get('idempotency-key') !== fields.command_id) return error(400, 'invalid_request');
        input = { coupleId: route[1], commandId: fields.command_id, membershipEpoch: fields.membership_epoch,
          title: fields.title, localDate: fields.local_date, timezone: fields.timezone,
          ...(Object.hasOwn(fields, 'recurrence') ? { recurrence: fields.recurrence } : {}),
          ...(Object.hasOwn(fields, 'leap_day_policy') ? { leapDayPolicy: fields.leap_day_policy } : {}) };
      } else {
        if (request.body || [...url.searchParams.keys()].join(',') !== 'membership_epoch'
          || !/^[1-9][0-9]*$/.test(url.searchParams.get('membership_epoch') ?? '')) return error(400, 'invalid_request');
        input = { coupleId: route[1], membershipEpoch: Number(url.searchParams.get('membership_epoch')) };
      }
      const result = request.method === 'GET' ? await listSharedDates(db, principal, input)
        : await createSharedDate(db, principal, input);
      if (result.ok) return response(request.method === 'POST' && 'replay' in result.value && !result.value.replay ? 201 : 200, result);
      return response(result.error === 'unavailable' ? 403 : result.error === 'invalid_request' ? 400 : 409, result);
    } catch { return error(503, 'temporarily_unavailable'); }
  };
}
