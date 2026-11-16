import type { AuthorizedDatabase } from './contracts.ts';
import { listDailyQuestions, readDailyAnswer, createDailyAnswer, rewriteDailyAnswer, removeDailyAnswer,
  type DailyQuestionClock, type DailyQuestionTimezoneResolver } from './daily-questions.ts';
import { readDisputesJson as readStrictJson } from './disputes-json.ts';
import { canonicalDailyDate } from '../../../packages/domain/daily-question/catalog.ts';
import { isUuid } from './validation.ts';

/** Synthetic adapter only. Calendar authority is injected during server construction. */
export function createDailyQuestionsHandler(db: AuthorizedDatabase, clock?: DailyQuestionClock, timezone?: DailyQuestionTimezoneResolver) {
  return async (request: Request): Promise<Response> => {
    let allow = 'GET, POST';
    const response = (status: number, body: unknown) => Response.json(body, { status, headers: {
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...(status === 405 ? { allow } : {}) } });
    const error = (status: number, code: string) => response(status, { ok: false, error: code });
    try {
      const url = new URL(request.url), route = url.pathname.match(/^\/v1\/couples\/([^/]+)\/daily-questions(?:\/answers\/([^/]+)(\/text)?)?$/);
      if (!route) return error(404, 'not_found');
      allow = !route[2] ? 'GET, POST' : route[3] ? 'GET' : 'PUT, DELETE';
      if (!allow.split(', ').includes(request.method)) return error(405, 'method_not_allowed');
      const principal = await db.sessionAuthority.authenticate(request);
      if (!principal || principal.source !== db.sessionAuthority.source || !isUuid(principal.userId)) return error(401, 'unauthenticated');
      let input: unknown;
      if (request.method === 'GET') {
        const keys = [...url.searchParams.keys()].sort().join(',');
        if (request.body || (keys !== 'membership_epoch' && (route[2] || keys !== 'before_day,membership_epoch'))
          || !/^[1-9][0-9]*$/.test(url.searchParams.get('membership_epoch') ?? '')
          || (url.searchParams.has('before_day') && !canonicalDailyDate(url.searchParams.get('before_day')))) return error(400, 'invalid_request');
        input = { coupleId: route[1], membershipEpoch: Number(url.searchParams.get('membership_epoch')),
          ...(route[2] ? { answerId: route[2] } : { beforeDay: url.searchParams.get('before_day') }) };
      } else {
        if (url.search) return error(400, 'invalid_request');
        if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return error(415, 'unsupported_media_type');
        let body: unknown;
        try { body = await readStrictJson(request); } catch { return error(400, 'invalid_request'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return error(400, 'invalid_request');
        const f = body as Record<string, unknown>;
        const keys = ['membership_epoch', 'command_id', 'confirm', ...(route[2] ? ['expected_version'] : ['expected_day']),
          ...(request.method !== 'DELETE' ? ['text'] : [])];
        if (Object.keys(f).sort().join() !== keys.sort().join() || !isUuid(f.command_id) || request.headers.get('idempotency-key') !== f.command_id) return error(400, 'invalid_request');
        input = { coupleId: route[1], membershipEpoch: f.membership_epoch, commandId: f.command_id, confirm: f.confirm,
          ...(route[2] ? { answerId: route[2], expectedVersion: f.expected_version } : { expectedDay: f.expected_day }),
          ...(request.method !== 'DELETE' ? { text: f.text } : {}) };
      }
      const operation = request.method === 'GET' ? (route[2] ? readDailyAnswer : listDailyQuestions)
        : !route[2] ? createDailyAnswer : request.method === 'PUT' ? rewriteDailyAnswer : removeDailyAnswer;
      const result = await operation(db, principal, input, clock, timezone);
      return response(result.ok ? 200 : result.error === 'unavailable' ? 403 : result.error === 'invalid_request' ? 400 : 409, result);
    } catch { return error(503, 'temporarily_unavailable'); }
  };
}
