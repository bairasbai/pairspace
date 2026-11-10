import { readHistory, sendMessage } from './chat.ts';
import type { Database, Principal } from './contracts.ts';
import { isUuid } from './validation.ts';

/** Must verify authenticity, expiry and revocation on every request. No default implementation. */
export type SessionVerifier = (opaqueToken: string) => Promise<Principal | null>;
const MAX_BODY_BYTES = 65536;
const response = (status: number, body: unknown) => Response.json(body, { status,
  headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    ...(status === 405 ? { Allow: 'GET, POST' } : {}) } });
const error = (status: number, code: string) => response(status, { ok: false, error: code });

async function readJson(request: Request): Promise<unknown> {
  if (!request.body) throw new Error('invalid_body');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) { await reader.cancel(); throw new Error('invalid_body'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

/** In-process transport prototype. Not a listener, auth provider or production perimeter. */
export function createChatHandler(db: Database, verify: SessionVerifier): (request: Request) => Promise<Response> {
  return async request => {
    try {
      const url = new URL(request.url);
      const route = url.pathname.match(/^\/v1\/couples\/([^/]+)\/chat\/messages$/);
      if (!route) return error(404, 'not_found');
      if (request.method !== 'POST' && request.method !== 'GET') return error(405, 'method_not_allowed');
      const authorization = request.headers.get('authorization');
      const match = authorization?.match(/^Bearer ([A-Za-z0-9._~-]{1,2048})$/);
      if (!match) return error(401, 'unauthenticated');
      const principal = await verify(match[1]);
      if (!principal || !isUuid(principal.userId)) return error(401, 'unauthenticated');
      let input: unknown;
      if (request.method === 'POST') {
        if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
          return error(415, 'unsupported_media_type');
        }
        let body: unknown;
        try { body = await readJson(request); } catch { return error(400, 'invalid_request'); }
        if (typeof body !== 'object' || body === null || !('client_message_id' in body)
          || !isUuid(body.client_message_id) || request.headers.get('idempotency-key') !== body.client_message_id) {
          return error(400, 'invalid_request');
        }
        const fields = body as Record<string, unknown>;
        input = { coupleId: route[1], clientId: fields.client_message_id, body: fields.body,
          membershipEpoch: fields.membership_epoch };
      } else {
        input = { coupleId: route[1], membershipEpoch: Number(url.searchParams.get('membership_epoch')),
          limit: Number(url.searchParams.get('limit') ?? 50),
          ...(url.searchParams.has('beforeSeq') ? { beforeSeq: Number(url.searchParams.get('beforeSeq')) } : {}) };
      }
      const result = request.method === 'POST' ? await sendMessage(db, principal, input) : await readHistory(db, principal, input);
      if (result.ok) return response('replay' in result.value && !result.value.replay ? 201 : 200, result);
      const status = result.error === 'unavailable' ? 403
        : result.error === 'idempotency_conflict' || result.error === 'stale_membership' ? 409 : 400;
      return response(status, result);
    } catch { return error(503, 'temporarily_unavailable'); }
  };
}
