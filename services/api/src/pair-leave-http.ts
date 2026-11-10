import type { AuthorizedDatabase } from './contracts.ts';
import { readJson } from './http.ts';
import { leavePair } from './pair-leave.ts';
const response = (status: number, body: unknown) => Response.json(body, { status,
  headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...(status === 405 ? { allow: 'POST' } : {}) } });
const failure = (status: number, error: string) => response(status, { ok: false, error });

/** Explicit synthetic composition opt-in only. No client account/pair selector grants authority. */
export function createPairLeaveHandler(db: AuthorizedDatabase): (request: Request) => Promise<Response> {
  return async request => {
    try {
      const url = new URL(request.url);
      if (url.pathname !== '/v1/pair/leave') return failure(404, 'not_found');
      if (request.method !== 'POST') return failure(405, 'method_not_allowed');
      if (url.search) return failure(400, 'invalid_request');
      if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return failure(415, 'unsupported_media_type');
      const principal = await db.sessionAuthority.authenticate(request);
      if (!principal || principal.source !== db.sessionAuthority.source) return failure(401, 'unauthenticated');
      let input: unknown;
      try { input = await readJson(request); } catch { return failure(400, 'invalid_request'); }
      const result = await leavePair(db, principal, input);
      return result.ok ? response(200, result) : failure(result.error === 'invalid_request' ? 400 : result.error === 'unauthenticated' ? 401 : 409, result.error);
    } catch { return failure(503, 'temporarily_unavailable'); }
  };
}
