import type { AuthorizedDatabase } from './contracts.ts';
import { isUuid } from './validation.ts';
import { readChatWindow } from './chat-history-window.ts';

export function windowReadId(request: Request): string | null {
  const params = new URL(request.url).searchParams, value = params.get('read_id');
  return params.getAll('read_id').length === 1 && isUuid(value) ? value.toLowerCase() : null;
}
export function windowFailure(request: Request, status: number, error: string): Response {
  return Response.json({ ok: false, error, readId: windowReadId(request) }, { status,
    headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}
export function createChatWindowHandler(db: AuthorizedDatabase, replyAware = false) {
  return async (request: Request): Promise<Response> => {
    const fail = (status: number, error: string) => windowFailure(request, status, error);
    try {
      const url = new URL(request.url), route = url.pathname.match(/^\/v1\/couples\/([^/]+)\/chat\/history-window$/);
      const replyRoute = replyAware ? url.pathname.match(/^\/v1\/couples\/([^/]+)\/chat\/reply-window$/) : null;
      const matched = replyAware ? replyRoute : route;
      if (!matched) return fail(404, 'not_found');
      if (request.method !== 'GET') return fail(405, 'method_not_allowed');
      const principal = await db.sessionAuthority.authenticate(request);
      if (!principal || principal.source !== db.sessionAuthority.source || !isUuid(principal.userId)) return fail(401, 'unauthenticated');
      const params = url.searchParams, direction = params.get('direction');
      const anchored = direction === 'before' || direction === 'after';
      const keys = ['membership_epoch', 'direction', 'read_id', ...(anchored ? ['anchor_id', 'anchor_seq'] : [])];
      if ([...params.keys()].length !== keys.length || keys.some(key => params.getAll(key).length !== 1)
        || !/^[1-9][0-9]*$/.test(params.get('membership_epoch') ?? '') || !windowReadId(request)) return fail(400, 'invalid_request');
      if (anchored && !/^[1-9][0-9]*$/.test(params.get('anchor_seq') ?? '')) return fail(400, 'invalid_cursor');
      const result = await readChatWindow(db, principal, { coupleId: matched[1], membershipEpoch: Number(params.get('membership_epoch')),
        readId: windowReadId(request), direction, ...(anchored ? { anchorId: params.get('anchor_id'), anchorSeq: Number(params.get('anchor_seq')) } : {}) }, replyAware);
      if (!result.ok) return fail(result.error === 'unavailable' ? 403 : result.error === 'stale_membership' ? 409 : 400, result.error);
      return Response.json(result, { headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
    } catch { return fail(503, 'temporarily_unavailable'); }
  };
}
