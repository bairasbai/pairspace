import type { AuthorizedDatabase } from './contracts.ts';
import { isUuid } from './validation.ts';
import { windowFailure, windowReadId } from './chat-history-window-http.ts';
import { reconcileChat } from './chat-reconciliation.ts';

export function createChatReconciliationHandler(db: AuthorizedDatabase) {
  return async (request: Request): Promise<Response> => {
    const fail = (status: number, error: string) => windowFailure(request, status, error);
    try {
      const url = new URL(request.url);
      const route = url.pathname.match(/^\/v1\/couples\/([^/]+)\/chat\/reconcile$/);
      if (!route) return fail(404, 'not_found');
      if (request.method !== 'GET') return fail(405, 'method_not_allowed');
      const principal = await db.sessionAuthority.authenticate(request);
      if (!principal || principal.source !== db.sessionAuthority.source || !isUuid(principal.userId)) return fail(401, 'unauthenticated');
      const params = url.searchParams;
      const keys = ['membership_epoch', 'read_id', 'message_ids', ...(params.has('detail_id') ? ['detail_id'] : []), ...(params.has('reply_target_id') ? ['reply_target_id'] : [])];
      if ([...params.keys()].length !== keys.length || keys.some(key => params.getAll(key).length !== 1)
        || !/^[1-9][0-9]*$/.test(params.get('membership_epoch') ?? '') || !windowReadId(request)) return fail(400, 'invalid_request');
      const rawIds = params.get('message_ids')!;
      // Bound allocation as well as the parsed list, before querying any message.
      if (rawIds.length > 1849) return fail(400, 'invalid_request');
      const result = await reconcileChat(db, principal, {
        coupleId: route[1], membershipEpoch: Number(params.get('membership_epoch')), readId: windowReadId(request),
        messageIds: rawIds === '' ? [] : rawIds.split(','),
        ...(params.has('detail_id') ? { detailId: params.get('detail_id') } : {}),
        ...(params.has('reply_target_id') ? { replyTargetId: params.get('reply_target_id') } : {}),
      });
      if (!result.ok) return fail(result.error === 'unavailable' ? 403 : result.error === 'stale_membership' ? 409 : 400, result.error);
      return Response.json(result, { headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
    } catch { return fail(503, 'temporarily_unavailable'); }
  };
}
