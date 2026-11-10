import { readBoundedJson } from '../chat/transport';
import { validateSyntheticConfig, type SyntheticConfig } from './config';
type ProfileResult = { ok: true } | { ok: false; error:
  'auth_required' | 'access_required' | 'profile_unavailable' | 'profile_retry_required' };
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Explicit user action only. Outcome may have committed even if its response is lost. */
export async function provisionProfile(config: SyntheticConfig, sessionId: string, cookie: string,
  request: (request: Request) => Promise<Response>): Promise<ProfileResult> {
  try {
    const baseURL = config.baseURL;
    validateSyntheticConfig({ mode: config.mode, baseURL });
    if (!sessionId || !cookie || cookie.length > 8192 || /[\x00-\x1f\x7f]/.test(cookie)) return { ok: false, error: 'auth_required' };
    const response = await request(new Request(baseURL + '/v1/profile', {
      method: 'POST', headers: { Cookie: cookie, Origin: baseURL, 'Content-Type': 'application/json' },
      body: '{}', credentials: 'omit', redirect: 'error', cache: 'no-store',
    }));
    if (response.status === 401) return { ok: false, error: 'auth_required' };
    if (response.status === 403) return { ok: false, error: 'access_required' };
    if (response.status === 409 || response.status === 400 || response.status === 404) {
      return { ok: false, error: 'profile_unavailable' };
    }
    if (response.status !== 200 && response.status !== 201) return { ok: false, error: 'profile_retry_required' };
    const body = await readBoundedJson(response, 4096);
    if (!record(body) || body.ok !== true || !record(body.value)
      || body.value.sessionId !== sessionId || typeof body.value.created !== 'boolean'
      || typeof body.value.userId !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.value.userId)) {
      return { ok: false, error: 'profile_retry_required' };
    }
    return { ok: true };
  } catch { return { ok: false, error: 'profile_retry_required' }; }
}
