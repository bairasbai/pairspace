import type { AuthorizedDatabase } from './contracts.ts';
import { getNotificationPreferences, saveNotificationPreferences, previewNotificationPreferences } from './notification-preferences.ts';
import { readJson } from './http.ts';
import { isUuid } from './validation.ts';
const response = (status: number, body: unknown) => Response.json(body, { status,
  headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    ...(status === 405 ? { allow: 'GET, PUT' } : {}) } });
const error = (status: number, code: string) => response(status, { ok: false, error: code });
export function createNotificationPreferencesHandler(db: AuthorizedDatabase) {
  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      const route = url.pathname.match(/^\/v1\/couples\/([^/]+)\/notification-preferences(\/preview)?$/);
      if (!route) return error(404, 'not_found');
      const preview = !!route[2];
      if (!(preview ? ['GET'] : ['GET', 'PUT']).includes(request.method)) {
        const denied = error(405, 'method_not_allowed');
        if (preview) denied.headers.set('allow', 'GET');
        return denied;
      }
      const principal = await db.sessionAuthority.authenticate(request);
      if (!principal || principal.source !== db.sessionAuthority.source || !isUuid(principal.userId)) return error(401, 'unauthenticated');
      let input: unknown;
      if (request.method !== 'GET') {
        if (url.search) return error(400, 'invalid_request');
        if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return error(415, 'unsupported_media_type');
        let body: unknown;
        try { body = await readJson(request); } catch { return error(400, 'invalid_request'); }
        const keys = 'care,chat,command_id,expected_version,letter,membership_epoch,quiet';
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== keys) return error(400, 'invalid_request');
        const fields = body as Record<string, unknown>;
        if (!isUuid(fields.command_id) || request.headers.get('idempotency-key') !== fields.command_id) return error(400, 'invalid_request');
        input = { coupleId: route[1], commandId: fields.command_id, membershipEpoch: fields.membership_epoch,
          expectedVersion: fields.expected_version, care: fields.care, chat: fields.chat, letter: fields.letter, quiet: fields.quiet };
      } else {
        if (request.body || [...url.searchParams.keys()].sort().join(',') !== (preview ? 'category,membership_epoch' : 'membership_epoch')
          || !/^[1-9][0-9]*$/.test(url.searchParams.get('membership_epoch') ?? '')) return error(400, 'invalid_request');
        input = { coupleId: route[1], membershipEpoch: Number(url.searchParams.get('membership_epoch')), ...(preview ? {category:url.searchParams.get('category')} : {}) };
      }
      const result = preview ? await previewNotificationPreferences(db, principal, input) : request.method === 'GET' ? await getNotificationPreferences(db, principal, input) : await saveNotificationPreferences(db, principal, input);
      if (result.ok) return response(200, result);
      return response(result.error === 'unavailable' ? 403 : result.error === 'invalid_request' ? 400 : 409, result);
    } catch { return error(503, 'temporarily_unavailable'); }
  };
}
