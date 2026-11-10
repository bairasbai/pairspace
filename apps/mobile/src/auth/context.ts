import { readBoundedJson } from '../chat/transport';
import { validateSyntheticConfig, type SyntheticConfig } from './config';
export type SessionContext =
  | Readonly<{ state: 'unmapped'; sessionId: string }>
  | Readonly<{ state: 'no_active_pair'; sessionId: string; userId: string }>
  | Readonly<{ state: 'ready'; sessionId: string; userId: string; coupleId: string; membershipEpoch: number }>;
type ContextResult = { ok: true; value: SessionContext }
  | { ok: false; error: 'auth_required' | 'access_required' | 'invalid_context' | 'transport_error' };
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export async function readSessionContext(config: SyntheticConfig, sessionId: string, cookie: string,
  request: (request: Request) => Promise<Response>): Promise<ContextResult> {
  try {
    const baseURL = config.baseURL;
    validateSyntheticConfig({ mode: config.mode, baseURL });
    if (!cookie || cookie.length > 8192 || /[\x00-\x1f\x7f]/.test(cookie)) return { ok: false, error: 'auth_required' };
    const response = await request(new Request(baseURL + '/v1/session/context', {
      method: 'GET', headers: { Cookie: cookie, Origin: baseURL },
      credentials: 'omit', redirect: 'error', cache: 'no-store',
    }));
    if (response.status === 401) return { ok: false, error: 'auth_required' };
    if (response.status === 403) return { ok: false, error: 'access_required' };
    if (response.status !== 200) return { ok: false, error: 'transport_error' };
    let body: unknown;
    try { body = await readBoundedJson(response, 4096); }
    catch { return { ok: false, error: 'invalid_context' }; }
    if (!record(body) || body.ok !== true || !record(body.value)) return { ok: false, error: 'invalid_context' };
    const value = body.value;
    if (!sessionId || value.sessionId !== sessionId) return { ok: false, error: 'invalid_context' };
    if (value.state === 'unmapped') return { ok: true, value: { state: 'unmapped', sessionId } };
    if (!uuid(value.userId)) return { ok: false, error: 'invalid_context' };
    if (value.state === 'no_active_pair') return { ok: true, value: { state: 'no_active_pair', sessionId, userId: value.userId } };
    if (value.state !== 'ready' || !uuid(value.coupleId) || !Number.isSafeInteger(value.membershipEpoch)
      || Number(value.membershipEpoch) < 1) return { ok: false, error: 'invalid_context' };
    return { ok: true, value: { state: 'ready', sessionId, userId: value.userId,
      coupleId: value.coupleId, membershipEpoch: Number(value.membershipEpoch) } };
  } catch { return { ok: false, error: 'transport_error' }; }
}
