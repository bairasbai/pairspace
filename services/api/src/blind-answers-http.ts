import type { AuthorizedDatabase } from './contracts.ts';
import { openBlindRound, readBlindRound, submitBlindAnswer } from './blind-answers.ts';
import { readJson } from './http.ts';
import { isUuid } from './validation.ts';
const response = (status: number, body: unknown) => Response.json(body, { status,
  headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    ...(status === 405 ? { allow: 'GET, POST' } : {}) } });
const error = (status: number, code: string) => response(status, { ok: false, error: code });
export function createBlindAnswersHandler(db: AuthorizedDatabase) {
  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      const route = url.pathname.match(/^\/v1\/couples\/([^/]+)\/blind-round(?:\/([^/]+)\/answer)?$/);
      if (!route) return error(404, 'not_found');
      if (!['GET', 'POST'].includes(request.method) || (route[2] && request.method !== 'POST')) return error(405, 'method_not_allowed');
      const principal = await db.sessionAuthority.authenticate(request);
      if (!principal || principal.source !== db.sessionAuthority.source || !isUuid(principal.userId)) return error(401, 'unauthenticated');
      let input: unknown;
      if (request.method === 'POST') {
        if (url.search) return error(400, 'invalid_request');
        if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return error(415, 'unsupported_media_type');
        let body: unknown;
        try { body = await readJson(request); } catch { return error(400, 'invalid_request'); }
        const keys = route[2] ? 'answer,catalog_version,command_id,confirm,membership_epoch,question_id'
          : 'catalog_version,command_id,membership_epoch,question_id';
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== keys) return error(400, 'invalid_request');
        const f = body as Record<string, unknown>;
        if (!isUuid(f.command_id) || request.headers.get('idempotency-key') !== f.command_id) return error(400, 'invalid_request');
        input = { coupleId: route[1], commandId: f.command_id, membershipEpoch: f.membership_epoch,
          questionId: f.question_id, catalogVersion: f.catalog_version,
          ...(route[2] ? { roundId: route[2], answer: f.answer, confirm: f.confirm } : {}) };
      } else {
        if (request.body || [...url.searchParams.keys()].join(',') !== 'membership_epoch'
          || !/^[1-9][0-9]*$/.test(url.searchParams.get('membership_epoch') ?? '')) return error(400, 'invalid_request');
        input = { coupleId: route[1], membershipEpoch: Number(url.searchParams.get('membership_epoch')) };
      }
      const result = request.method === 'GET' ? await readBlindRound(db, principal, input)
        : route[2] ? await submitBlindAnswer(db, principal, input) : await openBlindRound(db, principal, input);
      if (result.ok) {
        const { created, ...value } = result.value;
        return response(created ? 201 : 200, { ok: true, value });
      }
      return response(result.error === 'unavailable' ? 403 : result.error === 'invalid_request' ? 400 : 409, result);
    } catch { return error(503, 'temporarily_unavailable'); }
  };
}
