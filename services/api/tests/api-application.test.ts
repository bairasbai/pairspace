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
