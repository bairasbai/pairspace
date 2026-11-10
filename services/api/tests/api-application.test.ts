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
