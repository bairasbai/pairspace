import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
const provider = vi.hoisted(() => {
  const handler = vi.fn(async (_request: Request) => { void _request; return Response.json({ provider: true }); });
  const getSession = vi.fn(async (): Promise<unknown> => null);
  return { handler, getSession, create: vi.fn((_options: unknown) => { void _options; return { handler, api: { getSession } }; }) };
});
vi.mock('better-auth', () => ({ betterAuth: provider.create }));
import { createApiApplication, type ApiApplicationConfig } from '../src/api-application.ts';
const baseURL = 'https://fixture.invalid';
const secret = 'synthetic-explicit-secret-for-tests-only-123456789';
const pool = { connect: vi.fn() } as unknown as Pool;
const config = (): ApiApplicationConfig => ({ pool, baseURL, secret, trustedOrigins: [baseURL, 'pairspace://'], emailPasswordEnabled: true,
  limits: { bodyBytes: 16, bodyReadMs: 100, statementMs: 7000, lockMs: 5000 } });
const request = (path = '/api/auth/get-session', method = 'GET', headers: Record<string, string> = { origin: baseURL }, body?: string) =>
  new Request(baseURL + path, { method, headers, body });
beforeEach(() => { vi.clearAllMocks(); provider.handler.mockImplementation(async () => Response.json({ provider: true })); provider.getSession.mockResolvedValue(null); });
afterEach(() => { vi.unstubAllEnvs(); });

it('constructs official provider with the exact pool and explicit single secret configuration', async () => {
  vi.stubEnv('BETTER_AUTH_SECRETS', 'synthetic-invalid-env-value');
  const app = createApiApplication(config());
  expect(provider.create).toHaveBeenCalledWith(expect.objectContaining({ database: pool, secret, secrets: [{ version: 1, value: secret }],
    session: { cookieCache: { enabled: false } }, telemetry: { enabled: false }, logger: { disabled: true }, onAPIError: { throw: true } }));
  const response = await app.handle(request());
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ provider: true });
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(provider.handler).toHaveBeenCalledOnce();
  const chat = await app.handle(request('/v1/couples/00000000-0000-4000-8000-000000000001/chat/messages', 'GET', { origin: baseURL, cookie: 'synthetic' }));
  expect(chat.status).toBe(401); expect(provider.getSession).toHaveBeenCalledOnce();
});
it('rejects absent/invalid configuration without provider creation or environment fallback', () => {
  const valid = config();
  const invalid: unknown[] = [null, {}, { ...valid, pool: {} }, { ...valid, baseURL: 'not-url' },
    { ...valid, baseURL: 'pairspace://' }, { ...valid, baseURL: 'http://remote.invalid', trustedOrigins: ['http://remote.invalid'] },
    { ...valid, secret: '' }, { ...valid, secret: 'x'.repeat(513) }, { ...valid, secret: 'x'.repeat(40) + '\n' },
    { ...valid, emailPasswordEnabled: undefined }, { ...valid, trustedOrigins: [] }, { ...valid, trustedOrigins: ['https://other.invalid'] },
    { ...valid, trustedOrigins: [baseURL, 'https://user:password@host.invalid'] }, { ...valid, trustedOrigins: [baseURL, '*'] },
    { ...valid, trustedOrigins: [baseURL, '\n'] }, { ...valid, trustedOrigins: [baseURL, 'x'.repeat(2049)] },
    { ...valid, trustedOrigins: [baseURL, 'https://fixture.invalid/path'] }, { ...valid, trustedOrigins: [baseURL, 'https://fixture.invalid?query'] },
    { ...valid, trustedOrigins: [baseURL, 'https://fixture.invalid#hash'] }, { ...valid, trustedOrigins: [baseURL, 1] },
    { ...valid, limits: null }];
  for (const key of ['bodyBytes', 'bodyReadMs', 'statementMs', 'lockMs']) {
    invalid.push({ ...valid, limits: { ...valid.limits, [key]: 0 } }, { ...valid, limits: { ...valid.limits, [key]: Infinity } });
  }
  invalid.push({ ...valid, limits: { ...valid.limits, lockMs: 8000 } });
  for (const value of invalid) expect(() => createApiApplication(value as ApiApplicationConfig)).toThrow('invalid_api_configuration');
  expect(provider.create).not.toHaveBeenCalled();
  expect(() => createApiApplication({ ...valid, baseURL: 'http://127.0.0.1:1234', trustedOrigins: ['http://127.0.0.1:1234'] })).not.toThrow();
});
it('routes only known paths/methods/origins and limits body before auth handler', async () => {
  const app = createApiApplication(config());
  expect((await app.handle(request('/unknown'))).status).toBe(404);
  const wrongMethod = await app.handle(request('/api/auth/sign-out', 'DELETE'));
  expect(wrongMethod.status).toBe(405); expect(wrongMethod.headers.get('allow')).toBe('GET, POST');
  expect((await app.handle(request('/api/auth/get-session', 'GET', {}))).status).toBe(403);
  expect((await app.handle(request('/api/auth/get-session', 'GET', { origin: 'https://attacker.invalid', 'expo-origin': 'pairspace://' }))).status).toBe(403);
  expect((await app.handle(request('/api/auth/sign-in/email', 'POST', { origin: baseURL }, '{}'))).status).toBe(415);
  expect((await app.handle(request('/api/auth/sign-in/email', 'POST', { origin: baseURL, 'content-type': 'application/json' }, 'x'.repeat(17)))).status).toBe(413);
  expect(provider.handler).not.toHaveBeenCalled();
  expect((await app.handle(request('/api/auth/sign-in/email', 'POST', { 'expo-origin': 'pairspace://', 'content-type': 'application/json; charset=utf-8' }, '{}'))).status).toBe(200);
});
it('redacts thrown errors/provider 5xx and preserves controlled provider validation responses', async () => {
  const app = createApiApplication(config());
  provider.handler.mockRejectedValueOnce(new Error('private SQL/secret detail'));
  const failure = await app.handle(request());
  expect(failure.status).toBe(503); expect(await failure.text()).not.toContain('private');
  provider.handler.mockResolvedValueOnce(new Response('private database error', { status: 500 }));
  expect(await (await app.handle(request())).json()).toEqual({ ok: false, error: 'temporarily_unavailable' });
  provider.handler.mockResolvedValueOnce(Response.json({ code: 'INVALID_PASSWORD' }, { status: 400 }));
  expect((await app.handle(request())).status).toBe(400);
});

it('mounts selector-free session context with the same provider and strict origin perimeter', async () => {
  const app = createApiApplication(config());
  const path = '/v1/session/context';
  expect((await app.handle(request(path))).status).toBe(401);
  expect((await app.handle(request(path, 'GET', { origin: baseURL, cookie: 'synthetic' }))).status).toBe(401);
  expect(provider.getSession).toHaveBeenCalledWith({ headers: expect.any(Headers) });
  expect(provider.handler).not.toHaveBeenCalled();
  expect(provider.create).toHaveBeenCalledOnce();
  expect((await app.handle(request(path, 'GET', {}))).status).toBe(403);
  expect((await app.handle(request(path, 'GET', { origin: 'https://attacker.invalid', 'expo-origin': 'pairspace://' }))).status).toBe(403);
  expect((await app.handle(request(path + '?coupleId=spoofed'))).status).toBe(400);
  const method = await app.handle(request(path, 'POST', { origin: baseURL, 'content-type': 'application/json' }, '{}'));
  expect(method.status).toBe(405); expect(method.headers.get('allow')).toBe('GET');
  expect((await app.handle(request(path, 'DELETE'))).status).toBe(405);
});

it('requires explicit synthetic profile enablement and loopback baseURL with no environment fallback', async () => {
  vi.stubEnv('ENABLE_SYNTHETIC_PROFILE_PROVISIONING', 'true');
  for (const flag of [undefined, false]) {
    const app = createApiApplication({ ...config(), enableSyntheticProfileProvisioning: flag });
    expect((await app.handle(request('/v1/profile', 'POST', { origin: baseURL, 'content-type': 'application/json' }, '{}'))).status).toBe(404);
  }
  for (const invalid of [true, null, 'true', 1]) {
    expect(() => createApiApplication({ ...config(), enableSyntheticProfileProvisioning: invalid } as ApiApplicationConfig)).toThrow('invalid_api_configuration');
  }
  for (const baseURL of ['http://127.0.0.1:3123', 'http://[::1]:3123', 'https://localhost']) {
    const app = createApiApplication({ ...config(), baseURL, trustedOrigins: [baseURL], enableSyntheticProfileProvisioning: true });
    const send = (method = 'POST', body?: string, headers: Record<string, string> = {}) => app.handle(new Request(baseURL + '/v1/profile', {
      method, body, headers: { origin: baseURL, cookie: 'synthetic', 'content-type': 'application/json', ...headers },
    }));
    expect((await send('POST', '{}')).status).toBe(401);
    expect(provider.getSession).toHaveBeenCalledWith({ headers: expect.any(Headers) });
    const get = await send('GET');
    expect(get.status).toBe(405); expect(get.headers.get('allow')).toBe('POST');
    expect((await send('DELETE')).status).toBe(405);
    expect((await send('POST', '{}', { origin: 'https://attacker.invalid', 'expo-origin': baseURL })).status).toBe(403);
    expect((await send('POST', '{}', { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await send('POST', 'x'.repeat(17))).status).toBe(413);
    expect((await send('POST', '{"userId":1}')).status).toBe(400);
  }
  expect(provider.handler).not.toHaveBeenCalled();
});


it('gates waiting-space creation independently, default disabled, explicit boolean and loopback only', async () => {
  vi.stubEnv('ENABLE_SYNTHETIC_WAITING_SPACE_CREATION', 'true');
  const path = '/v1/spaces/waiting';
  for (const flag of [undefined, false]) {
    const app = createApiApplication({ ...config(), enableSyntheticWaitingSpaceCreation: flag });
    expect((await app.handle(request(path, 'POST', { origin: baseURL, 'content-type': 'application/json' }, '{}'))).status).toBe(404);
  }
  for (const invalid of [true, null, 'true', 1]) {
    expect(() => createApiApplication({ ...config(), enableSyntheticWaitingSpaceCreation: invalid } as ApiApplicationConfig)).toThrow('invalid_api_configuration');
  }
  for (const baseURL of ['http://127.0.0.1:3123', 'http://[::1]:3123', 'https://localhost']) {
    const app = createApiApplication({ ...config(), baseURL, trustedOrigins: [baseURL], enableSyntheticWaitingSpaceCreation: true });
    const send = (method = 'POST', body?: string, headers: Record<string, string> = {}) => app.handle(new Request(baseURL + path, {
      method, body, headers: { origin: baseURL, cookie: 'synthetic', 'content-type': 'application/json', ...headers },
    }));
    expect((await send('POST', '{}')).status).toBe(401);
    expect(provider.getSession).toHaveBeenCalledWith({ headers: expect.any(Headers) });
    const get = await send('GET'); expect(get.status).toBe(405); expect(get.headers.get('allow')).toBe('POST');
    expect((await send('DELETE')).status).toBe(405);
    expect((await send('POST', '{}', { origin: 'https://attacker.invalid' })).status).toBe(403);
    expect((await send('POST', '{}', { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await send('POST', 'x'.repeat(17))).status).toBe(413);
    expect((await send('POST', '{"userId":1}')).status).toBe(400);
    expect((await app.handle(new Request(baseURL + '/v1/profile', { method: 'POST',
      headers: { origin: baseURL, 'content-type': 'application/json' }, body: '{}' }))).status).toBe(404);
  }
  expect(provider.handler).not.toHaveBeenCalled();
});

it('gates invitations independently on loopback and enforces Origin, methods and DELETE JSON', async () => {
  vi.stubEnv('ENABLE_SYNTHETIC_PAIR_INVITATIONS', 'true');
  const path = '/v1/spaces/waiting/invite';
  for (const flag of [undefined, false]) {
    const app = createApiApplication({ ...config(), enableSyntheticPairInvitations: flag });
    expect((await app.handle(request(path))).status).toBe(404);
  }
  for (const invalid of [true, null, 'true', 1]) {
    expect(() => createApiApplication({ ...config(), enableSyntheticPairInvitations: invalid } as ApiApplicationConfig)).toThrow('invalid_api_configuration');
  }
  for (const baseURL of ['http://127.0.0.1:3123', 'http://[::1]:3123', 'https://localhost']) {
    const app = createApiApplication({ ...config(), baseURL, trustedOrigins: [baseURL], enableSyntheticPairInvitations: true });
    const send = (path: string, method = 'GET', body?: string, headers: Record<string, string> = {}) => app.handle(new Request(baseURL + path, {
      method, body, headers: { origin: baseURL, cookie: 'synthetic', 'content-type': 'application/json', ...headers },
    }));
    expect((await send(path)).status).toBe(401);
    expect((await send('/v1/profile', 'POST', '{}')).status).toBe(404);
    expect((await send('/v1/spaces/waiting', 'POST', '{}')).status).toBe(404);
    const method = await send(path, 'PUT', '{}'); expect(method.status).toBe(405); expect(method.headers.get('allow')).toBe('GET, POST, DELETE');
    expect((await send(path, 'GET', undefined, { origin: 'https://other.invalid' })).status).toBe(403);
    expect((await send(path, 'DELETE', '{}', { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await send(path, 'DELETE', '{}')).status).toBe(400);
    expect((await send(path, 'GET', undefined, { 'content-length': 'invalid' })).status).toBe(400);
    expect((await send(path, 'GET', undefined, { 'transfer-encoding': 'chunked' })).status).toBe(400);
  }
  expect(provider.handler).not.toHaveBeenCalled();
});

it('bounds streamed DELETE bytes and read deadlines before verification and normalizes invitation failures', async () => {
  const baseURL = 'http://127.0.0.1:3123', path = '/v1/spaces/waiting/invite';
  const app = createApiApplication({ ...config(), baseURL, trustedOrigins: [baseURL], enableSyntheticPairInvitations: true });
  const stream = (body: ReadableStream<Uint8Array>) => new Request(baseURL + path, {
    method: 'DELETE', headers: { origin: baseURL, 'content-type': 'application/json', cookie: 'synthetic' }, body, duplex: 'half',
  } as RequestInit);
  const oversized = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(17)); controller.close(); } });
  expect((await app.handle(stream(oversized))).status).toBe(413);
  expect((await app.handle(stream(new ReadableStream<Uint8Array>()))).status).toBe(408);
  expect(provider.getSession).not.toHaveBeenCalled();
  const larger = createApiApplication({ ...config(), baseURL, trustedOrigins: [baseURL], enableSyntheticPairInvitations: true,
    limits: { ...config().limits, bodyBytes: 128 } });
  provider.getSession.mockRejectedValueOnce(new Error('private cookie'));
  const response = await larger.handle(new Request(baseURL + path, { method: 'DELETE',
    headers: { origin: baseURL, 'content-type': 'application/json', cookie: 'synthetic' }, body: '{"inviteId":"00000000-0000-4000-8000-000000000020"}' }));
  expect(response.status).toBe(503); expect(await response.json()).toEqual({ ok: false, error: 'temporarily_unavailable' });
});

it('gates preview/accept independently with boolean loopback opt-in and uniform perimeter/limits', async () => {
  vi.stubEnv('ENABLE_SYNTHETIC_PAIR_ACCEPTANCE', 'true');
  const paths = ['/v1/pair-invitations/preview', '/v1/pair-invitations/accept'];
  for (const flag of [undefined, false]) {
    const app = createApiApplication({ ...config(), enableSyntheticPairAcceptance: flag });
    for (const path of paths) expect((await app.handle(request(path))).status).toBe(404);
  }
  for (const invalid of [true, null, 'true', 1]) {
    expect(() => createApiApplication({ ...config(), enableSyntheticPairAcceptance: invalid } as ApiApplicationConfig)).toThrow('invalid_api_configuration');
  }
  for (const baseURL of ['http://127.0.0.1:3123', 'http://[::1]:3123', 'https://localhost']) {
    const app = createApiApplication({ ...config(), baseURL, trustedOrigins: [baseURL], enableSyntheticPairAcceptance: true,
      limits: { ...config().limits, bodyBytes: 128 } });
    for (const path of paths) {
      const send = (method = 'POST', body?: string, headers: Record<string, string> = {}) => app.handle(new Request(baseURL + path, {
        method, body, headers: { origin: baseURL, cookie: 'synthetic', 'content-type': 'application/json', ...headers },
      }));
      const body = JSON.stringify(path.endsWith('preview') ? { token: Buffer.alloc(32, 17).toString('base64url') }
        : { token: Buffer.alloc(32, 17).toString('base64url'), accept: true });
      expect((await send('POST', body)).status).toBe(401);
      expect((await send('POST', body, { origin: 'https://other.invalid' })).status).toBe(403);
      expect((await send('POST', body, { 'content-type': 'text/plain' })).status).toBe(415);
      expect((await send('POST', 'x'.repeat(129))).status).toBe(413);
      const method = await send('GET'); expect(method.status).toBe(405); expect(method.headers.get('allow')).toBe('POST');
      expect((await send('DELETE', '{}')).status).toBe(405);
    }
    for (const path of ['/v1/profile', '/v1/spaces/waiting', '/v1/spaces/waiting/invite']) {
      expect((await app.handle(new Request(baseURL + path, { method: 'POST', body: '{}',
        headers: { origin: baseURL, 'content-type': 'application/json' } }))).status).toBe(404);
    }
  }
  const baseURL = 'http://127.0.0.1:3123';
  const app = createApiApplication({ ...config(), baseURL, trustedOrigins: [baseURL], enableSyntheticPairAcceptance: true });
  for (const path of paths) {
    const stream = (body: ReadableStream<Uint8Array>) => new Request(baseURL + path, { method: 'POST',
      headers: { origin: baseURL, 'content-type': 'application/json' }, body, duplex: 'half' } as RequestInit);
    expect((await app.handle(stream(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(17)); c.close(); } })))).status).toBe(413);
    expect((await app.handle(stream(new ReadableStream()))).status).toBe(408);
  }
  expect(provider.handler).not.toHaveBeenCalled();
});

it('mounts care signals only with an explicit boolean loopback opt-in', async () => {
  const path = '/v1/couples/00000000-0000-4000-8000-000000000001/care-signals?membership_epoch=1';
  expect((await createApiApplication(config()).handle(request(path))).status).toBe(404);
  expect(() => createApiApplication({ ...config(), enableSyntheticCareSignals: true })).toThrow('invalid_api_configuration');
  expect(() => createApiApplication({ ...config(), enableSyntheticCareSignals: 'true' } as unknown as ApiApplicationConfig)).toThrow('invalid_api_configuration');
  const origin = 'http://127.0.0.1:1234';
  const app = createApiApplication({ ...config(), baseURL: origin, trustedOrigins: [origin], enableSyntheticCareSignals: true });
  const response = await app.handle(new Request(origin + path, { headers: { origin } }));
  expect(response.status).toBe(401);
});

it('mounts letters collection and open only with explicit boolean loopback opt-in', async () => {
  const paths = ['/v1/couples/00000000-0000-4000-8000-000000000001/letters',
    '/v1/couples/00000000-0000-4000-8000-000000000001/letters/00000000-0000-4000-8000-000000000002'];
  for (const path of paths) expect((await createApiApplication(config()).handle(request(path))).status).toBe(404);
  expect(() => createApiApplication({ ...config(), enableSyntheticLetters: true })).toThrow('invalid_api_configuration');
  expect(() => createApiApplication({ ...config(), enableSyntheticLetters: 'true' } as unknown as ApiApplicationConfig)).toThrow('invalid_api_configuration');
  const origin = 'http://127.0.0.1:1234';
  const app = createApiApplication({ ...config(), baseURL: origin, trustedOrigins: [origin], enableSyntheticLetters: true });
  for (const path of paths) expect((await app.handle(new Request(origin + path + '?membership_epoch=1', { headers: { origin } }))).status).toBe(401);
});

it('pair leave is independently opt-in, loopback-only, origin/body bounded and POST-only', async () => {
  const path = '/v1/pair/leave';
  expect((await createApiApplication(config()).handle(request(path, 'POST', { origin: baseURL, 'content-type': 'application/json' }, '{}'))).status).toBe(404);
  expect(() => createApiApplication({ ...config(), enableSyntheticPairLeave: true })).toThrow('invalid_api_configuration');
  expect(() => createApiApplication({ ...config(), enableSyntheticPairLeave: 'true' } as unknown as ApiApplicationConfig)).toThrow('invalid_api_configuration');
  const local = 'http://localhost:3210';
  const app = createApiApplication({ ...config(), baseURL: local, trustedOrigins: [local], enableSyntheticPairLeave: true });
  const req = (method: string, body?: string, origin = local) => new Request(local + path, { method,
    headers: { origin, cookie: 'synthetic', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body }) });
  expect((await app.handle(req('GET'))).status).toBe(405);
  expect((await app.handle(req('POST', '{}', 'http://attacker.invalid'))).status).toBe(403);
  expect((await app.handle(req('POST', 'x'.repeat(17)))).status).toBe(413);
  expect((await app.handle(req('POST', '{}'))).status).toBe(401);
});

it('shared tasks are independently loopback-only and default disabled with bounded origin-checked mutations', async () => {
  const path = '/v1/couples/00000000-0000-4000-8000-000000000001/tasks';
  for (const flag of [undefined, false]) expect((await createApiApplication({ ...config(), enableSyntheticSharedTasks: flag }).handle(request(path))).status).toBe(404);
  for (const flag of [true, 'true', null]) expect(() => createApiApplication({ ...config(), enableSyntheticSharedTasks: flag } as ApiApplicationConfig)).toThrow('invalid_api_configuration');
  const origin = 'http://127.0.0.1:1234';
  const app = createApiApplication({ ...config(), baseURL: origin, trustedOrigins: [origin], enableSyntheticSharedTasks: true });
  expect((await app.handle(new Request(origin + path + '?membership_epoch=1', { headers: { origin } }))).status).toBe(401);
  expect((await app.handle(new Request(origin + path, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}' }))).status).toBe(401);
  expect((await app.handle(new Request(origin + path + '/00000000-0000-4000-8000-000000000002', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}' }))).status).toBe(401);
  expect((await app.handle(new Request(origin + path, { headers: { origin: 'https://attacker.invalid' } }))).status).toBe(403);
});

it('blind answers are independently loopback-only and default disabled', async () => {
  const path = '/v1/couples/00000000-0000-4000-8000-000000000001/blind-round';
  for (const flag of [undefined, false]) expect((await createApiApplication({ ...config(), enableSyntheticBlindAnswers: flag }).handle(request(path))).status).toBe(404);
  for (const flag of [true, 'true', null]) expect(() => createApiApplication({ ...config(), enableSyntheticBlindAnswers: flag } as ApiApplicationConfig)).toThrow('invalid_api_configuration');
  const origin = 'http://127.0.0.1:1234';
  const app = createApiApplication({ ...config(), baseURL: origin, trustedOrigins: [origin], enableSyntheticBlindAnswers: true });
  for (const suffix of ['', '/00000000-0000-4000-8000-000000000002/answer']) expect((await app.handle(new Request(origin + path + suffix, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}' }))).status).toBe(401);
  expect((await app.handle(new Request(origin + path, { headers: { origin: 'https://attacker.invalid' } }))).status).toBe(403);
});

it('shared dates are independently loopback-only and default disabled with bounded origin-checked mutations', async () => {
  const path = '/v1/couples/00000000-0000-4000-8000-000000000001/dates';
  for (const flag of [undefined, false]) expect((await createApiApplication({ ...config(), enableSyntheticSharedDates: flag }).handle(request(path))).status).toBe(404);
  for (const flag of [true, 'true', null]) expect(() => createApiApplication({ ...config(), enableSyntheticSharedDates: flag } as ApiApplicationConfig)).toThrow('invalid_api_configuration');
  const origin = 'http://127.0.0.1:1234';
  const app = createApiApplication({ ...config(), baseURL: origin, trustedOrigins: [origin], enableSyntheticSharedDates: true });
  expect((await app.handle(new Request(origin + path + '?membership_epoch=1', { headers: { origin } }))).status).toBe(401);
  expect((await app.handle(new Request(origin + path, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}' }))).status).toBe(401);
  expect((await app.handle(new Request(origin + path, { headers: { origin: 'https://attacker.invalid' } }))).status).toBe(403);
});

it('date PATCH passes only the enabled item route and preserves origin, media type and body limits', async () => {
  const origin = 'http://127.0.0.1:1234';
  const path = '/v1/couples/00000000-0000-4000-8000-000000000001/dates';
  const item = path + '/00000000-0000-4000-8000-000000000002';
  const settings = { ...config(), baseURL: origin, trustedOrigins: [origin] };
  const app = createApiApplication({ ...settings, enableSyntheticSharedDates: true });
  const patch = (target = item, headers: Record<string, string> = {}, body = '{}') => new Request(origin + target,
    { method: 'PATCH', headers: { origin, 'content-type': 'application/json', ...headers }, body });
  expect((await app.handle(patch())).status).toBe(401);
  for (const flag of [undefined, false]) {
    const disabled = createApiApplication({ ...settings, enableSyntheticSharedDates: flag });
    expect((await disabled.handle(patch())).status).toBe(404);
  }
  expect((await app.handle(patch(path))).status).toBe(405);
  expect((await app.handle(patch(item, { origin: 'https://attacker.invalid' }))).status).toBe(403);
  expect((await app.handle(patch(item, { 'content-type': 'text/plain' }))).status).toBe(415);
  expect((await app.handle(patch(item, {}, 'x'.repeat(17)))).status).toBe(413);
  expect((await app.handle(patch('/api/auth/get-session'))).status).toBe(405);
});

it('shared memories are independently loopback-only and default disabled with bounded origin-checked mutations', async () => {
  const path = '/v1/couples/00000000-0000-4000-8000-000000000001/memories';
  for (const flag of [undefined, false]) expect((await createApiApplication({ ...config(), enableSyntheticSharedMemories: flag }).handle(request(path))).status).toBe(404);
  for (const flag of [true, 'true', null]) expect(() => createApiApplication({ ...config(), enableSyntheticSharedMemories: flag } as ApiApplicationConfig)).toThrow('invalid_api_configuration');
  const origin = 'http://127.0.0.1:1234';
  const app = createApiApplication({ ...config(), baseURL: origin, trustedOrigins: [origin], enableSyntheticSharedMemories: true });
  expect((await app.handle(new Request(origin + path + '?membership_epoch=1', { headers: { origin } }))).status).toBe(401);
  expect((await app.handle(new Request(origin + path, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}' }))).status).toBe(401);
  expect((await app.handle(new Request(origin + path, { headers: { origin: 'https://attacker.invalid' } }))).status).toBe(403);
  for (const method of ['PATCH', 'DELETE', 'PUT']) expect((await app.handle(new Request(origin + path, { method, headers: { origin } }))).status).toBe(405);
  expect((await app.handle(new Request(origin + path, { method: 'POST', headers: { origin, 'content-type': 'text/plain' }, body: '{}' }))).status).toBe(415);
  expect((await app.handle(new Request(origin + path, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: 'x'.repeat(17) }))).status).toBe(413);
  expect((await app.handle(new Request(origin + path + '/item', { headers: { origin } }))).status).toBe(404);

});

it('shared songs are independently loopback-only and default disabled with bounded origin-checked mutations', async () => {
  const path = '/v1/couples/00000000-0000-4000-8000-000000000001/songs';
  for (const flag of [undefined, false]) for (const target of [path, path + '/item'])
    expect((await createApiApplication({ ...config(), enableSyntheticSharedSongs: flag }).handle(request(target))).status).toBe(404);
  for (const flag of [true, 'true', null]) expect(() => createApiApplication({ ...config(), enableSyntheticSharedSongs: flag } as ApiApplicationConfig)).toThrow('invalid_api_configuration');
  const origin = 'http://127.0.0.1:1234';
  const app = createApiApplication({ ...config(), baseURL: origin, trustedOrigins: [origin], enableSyntheticSharedSongs: true });
  expect((await app.handle(new Request(origin + path + '?membership_epoch=1', { headers: { origin } }))).status).toBe(401);
  expect((await app.handle(new Request(origin + path, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}' }))).status).toBe(401);
  expect((await app.handle(new Request(origin + path, { headers: { origin: 'https://attacker.invalid' } }))).status).toBe(403);
  for (const method of ['PATCH', 'DELETE', 'PUT']) expect((await app.handle(new Request(origin + path, { method, headers: { origin } }))).status).toBe(405);
  expect((await app.handle(new Request(origin + path, { method: 'POST', headers: { origin, 'content-type': 'text/plain' }, body: '{}' }))).status).toBe(415);
  expect((await app.handle(new Request(origin + path, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: 'x'.repeat(17) }))).status).toBe(413);
  expect((await app.handle(new Request(origin + path + '/item', { headers: { origin } }))).status).toBe(405);
  expect((await app.handle(new Request(origin + path + '/item', { method: 'PATCH', headers: { origin, 'content-type': 'application/json' }, body: '{}' }))).status).toBe(401);
  expect((await app.handle(new Request(origin + path + '/item', { method: 'PATCH', headers: { origin: 'https://attacker.invalid', 'content-type': 'application/json' }, body: '{}' }))).status).toBe(403);

});
it('shared wishes are independently loopback-only and default disabled with bounded origin-checked mutations', async () => {
  const path = '/v1/couples/00000000-0000-4000-8000-000000000001/wishes';
  for (const flag of [undefined, false]) expect((await createApiApplication({ ...config(), enableSyntheticSharedWishes: flag }).handle(request(path))).status).toBe(404);
  for (const flag of [true, 'true', null]) expect(() => createApiApplication({ ...config(), enableSyntheticSharedWishes: flag } as ApiApplicationConfig)).toThrow('invalid_api_configuration');
  const origin = 'http://127.0.0.1:1234';
  const app = createApiApplication({ ...config(), baseURL: origin, trustedOrigins: [origin], enableSyntheticSharedWishes: true });
  expect((await app.handle(new Request(origin + path + '?membership_epoch=1', { headers: { origin } }))).status).toBe(401);
  expect((await app.handle(new Request(origin + path, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}' }))).status).toBe(401);
  expect((await app.handle(new Request(origin + path, { headers: { origin: 'https://attacker.invalid' } }))).status).toBe(403);
  for (const method of ['PATCH', 'DELETE', 'PUT']) expect((await app.handle(new Request(origin + path, { method, headers: { origin } }))).status).toBe(405);
  expect((await app.handle(new Request(origin + path, { method: 'POST', headers: { origin, 'content-type': 'text/plain' }, body: '{}' }))).status).toBe(415);
  expect((await app.handle(new Request(origin + path, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: 'x'.repeat(17) }))).status).toBe(413);
  expect((await app.handle(new Request(origin + path + '/item', { headers: { origin } }))).status).toBe(405);
  expect((await app.handle(new Request(origin + path + '/item', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}' }))).status).toBe(401);
});
it('bounded chat windows are independently opt-in and preserve read nonce on perimeter errors', async () => {
  const nonce='00000000-0000-4000-8000-000000009999';
  const path='/v1/couples/00000000-0000-4000-8000-000000000001/chat/history-window?membership_epoch=1&direction=latest&read_id='+nonce;
  for(const flag of [undefined,false])expect((await createApiApplication({...config(),enableSyntheticChatHistoryWindow:flag}).handle(request(path))).status).toBe(404);
  for(const flag of [true,'true',null])expect(()=>createApiApplication({...config(),enableSyntheticChatHistoryWindow:flag} as ApiApplicationConfig)).toThrow('invalid_api_configuration');
  const origin='http://127.0.0.1:1234';
  const app=createApiApplication({...config(),baseURL:origin,trustedOrigins:[origin],enableSyntheticChatHistoryWindow:true});
  for(const [method,headers,status] of [
    ['GET',{origin},401],['GET',{origin:'https://attacker.invalid'},403],['DELETE',{origin},405],
  ] as const){const response=await app.handle(new Request(origin+path,{method,headers}));expect(response.status).toBe(status);expect(await response.json()).toHaveProperty('readId',nonce);}
});
it('reply-aware routes require their own explicit loopback opt-in', async () => {
  const origin='http://127.0.0.1:1234',nonce='00000000-0000-4000-8000-000000009999';
  const prefix='/v1/couples/00000000-0000-4000-8000-000000000001/chat/';
  for(const path of ['replies','reply-window','message-detail'])expect((await createApiApplication(config()).handle(request(prefix+path))).status).toBe(404);
  for(const flag of [true,'true',null])expect(()=>createApiApplication({...config(),enableSyntheticChatReplies:flag} as ApiApplicationConfig)).toThrow('invalid_api_configuration');
  const app=createApiApplication({...config(),baseURL:origin,trustedOrigins:[origin],enableSyntheticChatReplies:true});
  for(const path of ['reply-window','message-detail']){
    const response=await app.handle(new Request(origin+prefix+path+'?read_id='+nonce,{headers:{origin}}));
    expect(response.status).toBe(401);expect(await response.json()).toHaveProperty('readId',nonce);
    const forbidden=await app.handle(new Request(origin+prefix+path+'?read_id='+nonce));expect(forbidden.status).toBe(403);expect(await forbidden.json()).toHaveProperty('readId',nonce);
  }
  expect((await app.handle(new Request(origin+prefix+'replies',{method:'POST',headers:{origin,'content-type':'application/json'},body:'{}'}))).status).toBe(401);
});
it('own deletion is independently opt-in and DELETE bodies obey the perimeter', async () => {
  const path='/v1/couples/00000000-0000-4000-8000-000000000001/chat/messages/00000000-0000-4000-8000-000000000002';
  expect((await createApiApplication(config()).handle(request(path,'DELETE'))).status).toBe(404);
  for(const flag of [true,'true',null])expect(()=>createApiApplication({...config(),enableSyntheticChatDeletion:flag} as ApiApplicationConfig)).toThrow('invalid_api_configuration');
  const origin='http://127.0.0.1:1234';
  const app=createApiApplication({...config(),baseURL:origin,trustedOrigins:[origin],enableSyntheticChatDeletion:true});
  for(const [headers,body,status] of [
    [{origin,'content-type':'application/json'},'{}',401],
    [{origin,'content-type':'text/plain'},'{}',415],
    [{origin,'content-type':'application/json'},'x'.repeat(17),413],
    [{origin:'https://attacker.invalid','content-type':'application/json'},'{}',403],
  ] as const)expect((await app.handle(new Request(origin+path,{method:'DELETE',headers,body}))).status).toBe(status);
  expect((await app.handle(new Request(origin+path,{headers:{origin}}))).status).toBe(405);
});
it('own editing requires independent loopback opt-in and bounded PATCH bodies', async()=>{
  const path='/v1/couples/00000000-0000-4000-8000-000000000001/chat/messages/00000000-0000-4000-8000-000000000002';
  expect((await createApiApplication(config()).handle(request(path,'PATCH'))).status).toBe(404);
  for(const flag of [true,'true',null])expect(()=>createApiApplication({...config(),enableSyntheticChatEditing:flag} as ApiApplicationConfig)).toThrow('invalid_api_configuration');
  const origin='http://127.0.0.1:1234';const app=createApiApplication({...config(),baseURL:origin,trustedOrigins:[origin],enableSyntheticChatEditing:true});
  for(const [headers,body,status] of [[{origin,'content-type':'application/json'},'{}',401],[{origin,'content-type':'text/plain'},'{}',415],[{origin,'content-type':'application/json'},'x'.repeat(17),413],[{origin:'https://attacker.invalid','content-type':'application/json'},'{}',403]] as const)expect((await app.handle(new Request(origin+path,{method:'PATCH',headers,body}))).status).toBe(status);
});
it('love words requires independent loopback opt-in and bounds every mutation body', async () => {
  const path='/v1/couples/00000000-0000-4000-8000-000000000001/love-words';
  expect((await createApiApplication(config()).handle(request(path))).status).toBe(404);
  for (const flag of [true,'true',null]) expect(() => createApiApplication({...config(),enableSyntheticLoveWords:flag} as ApiApplicationConfig)).toThrow('invalid_api_configuration');
  const origin='http://127.0.0.1:1234';
  const app=createApiApplication({...config(),baseURL:origin,trustedOrigins:[origin],enableSyntheticLoveWords:true});
  for(const method of ['POST','PUT','DELETE']) {
    const route=path+(method==='POST'?'':'/00000000-0000-4000-8000-000000000002');
    for(const [headers,body,status] of [
      [{origin,'content-type':'application/json'},'{}',401],
      [{origin,'content-type':'text/plain'},'{}',415],
      [{origin,'content-type':'application/json'},'x'.repeat(17),413],
      [{origin:'https://attacker.invalid','content-type':'application/json'},'{}',403],
    ] as const) expect((await app.handle(new Request(origin+route,{method,headers,body}))).status).toBe(status);
  }
  const wrong=await app.handle(new Request(origin+path+'/00000000-0000-4000-8000-000000000002',{headers:{origin}}));
  expect(wrong.status).toBe(405);expect(wrong.headers.get('allow')).toBe('PUT, DELETE');
});
it('asks requires independent loopback opt-in and bounds all mutation bodies', async () => {
  const path='/v1/couples/00000000-0000-4000-8000-000000000001/asks';
  expect((await createApiApplication(config()).handle(request(path))).status).toBe(404);
  for (const flag of [true,'true',null]) expect(() => createApiApplication({...config(),enableSyntheticAsks:flag} as ApiApplicationConfig)).toThrow('invalid_api_configuration');
  const origin='http://127.0.0.1:1234';
  const app=createApiApplication({...config(),baseURL:origin,trustedOrigins:[origin],enableSyntheticAsks:true});
  for(const [method,suffix] of [['POST',''],['POST','/id/answer'],['POST','/id/skip'],['DELETE','/id/question'],['DELETE','/id/answer']]) {
    for(const [headers,body,status] of [[{origin,'content-type':'application/json'},'{}',401],[{origin,'content-type':'text/plain'},'{}',415],[{origin,'content-type':'application/json'},'x'.repeat(17),413],[{origin:'https://attacker.invalid','content-type':'application/json'},'{}',403]] as const)
      expect((await app.handle(new Request(origin+path+suffix,{method,headers,body}))).status).toBe(status);
  }
  const wrong=await app.handle(new Request(origin+path+'/id/answer',{headers:{origin}}));
  expect(wrong.status).toBe(405);expect(wrong.headers.get('allow')).toBe('POST, DELETE');
});
it('day scale has independent loopback opt-in and bounded POST/PUT/DELETE', async () => {
 const path='/v1/couples/00000000-0000-4000-8000-000000000001/day-scale';
 expect((await createApiApplication(config()).handle(request(path))).status).toBe(404);
 for(const flag of [true,'true',null])expect(()=>createApiApplication({...config(),enableSyntheticDayScale:flag}as ApiApplicationConfig)).toThrow('invalid_api_configuration');
 const origin='http://127.0.0.1:1234',app=createApiApplication({...config(),baseURL:origin,trustedOrigins:[origin],enableSyntheticDayScale:true});
 for(const method of ['POST','PUT','DELETE'])for(const [headers,body,status]of [[{origin,'content-type':'application/json'},'{}',401],[{origin,'content-type':'text/plain'},'{}',415],[{origin,'content-type':'application/json'},'x'.repeat(17),413],[{origin:'https://attacker.invalid','content-type':'application/json'},'{}',403]]as const)expect((await app.handle(new Request(origin+path+(method==='POST'?'':'/id'),{method,headers,body}))).status).toBe(status);
 const wrong=await app.handle(new Request(origin+path+'/id',{headers:{origin}}));expect(wrong.status).toBe(405);expect(wrong.headers.get('allow')).toBe('PUT, DELETE');
});
it('stems has independent loopback opt-in and bounded creation/completion/removal', async () => {
 const path='/v1/couples/00000000-0000-4000-8000-000000000001/stems';
 expect((await createApiApplication(config()).handle(request(path))).status).toBe(404);
 for(const flag of [true,'true',null])expect(()=>createApiApplication({...config(),enableSyntheticStems:flag}as ApiApplicationConfig)).toThrow('invalid_api_configuration');
 const origin='http://127.0.0.1:1234',app=createApiApplication({...config(),baseURL:origin,trustedOrigins:[origin],enableSyntheticStems:true});
 for(const [method,suffix]of [['POST',''],['POST','/id/complete'],['POST','/id/skip'],['DELETE','/id/author-bundle'],['DELETE','/id/recipient-continuation']])for(const [headers,body,status]of [[{origin,'content-type':'application/json'},'{}',401],[{origin,'content-type':'text/plain'},'{}',415],[{origin,'content-type':'application/json'},'x'.repeat(17),413],[{origin:'https://attacker.invalid','content-type':'application/json'},'{}',403]]as const)expect((await app.handle(new Request(origin+path+suffix,{method,headers,body}))).status).toBe(status);
 const wrong=await app.handle(new Request(origin+path+'/id/complete',{headers:{origin}}));expect(wrong.status).toBe(405);expect(wrong.headers.get('allow')).toBe('POST');
});
