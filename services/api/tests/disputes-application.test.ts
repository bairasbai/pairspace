import { expect, it } from 'vitest';
import { Pool } from 'pg';
import { createApiApplication, type ApiApplicationConfig } from '../src/api-application.ts';
import { id } from './fixtures.ts';
it('disputes has its own default-off boolean/loopback flag and guarded DELETE body, without database contact', async () => {
  const pool = new Pool({ max: 1 });
  const config: ApiApplicationConfig = { pool, baseURL: 'http://127.0.0.1:8787', trustedOrigins: ['http://127.0.0.1:8787'],
    secret: 'synthetic-dispute-secret-for-local-tests-only', emailPasswordEnabled: true,
    limits: { bodyBytes: 65536, bodyReadMs: 1000, statementMs: 7000, lockMs: 5000 } };
  const url = config.baseURL + '/v1/couples/' + id(1) + '/disputes';
  const get = () => new Request(url + '?membership_epoch=1', { headers: { origin: config.baseURL } });
  try {
    expect((await createApiApplication(config).handle(get())).status).toBe(404);
    expect((await createApiApplication({ ...config, enableSyntheticDisputes: false }).handle(get())).status).toBe(404);
    expect((await createApiApplication({ ...config, enableSyntheticStories: true }).handle(get())).status).toBe(404);
    const app = createApiApplication({ ...config, enableSyntheticDisputes: true });
    expect((await app.handle(new Request(url))).status).toBe(403);
    expect((await app.handle(get())).status).toBe(401);
    expect((await app.handle(new Request(url + '/' + id(2), { method: 'DELETE', headers: { origin: config.baseURL, 'content-type': 'text/plain' }, body: '{}' }))).status).toBe(415);
    for (const method of ['POST', 'DELETE']) {
      expect((await app.handle(new Request(url + '/' + id(2), { method, headers: { origin: config.baseURL } }))).status).toBe(415);
      expect((await app.handle(new Request(url + '/' + id(2), { method, headers: { origin: 'https://foreign.invalid', 'content-type': 'application/json' }, body: '{}' }))).status).toBe(403);
    }
    expect((await app.handle(new Request(url + '/' + id(2), { method: 'PATCH', headers: { origin: config.baseURL } }))).status).toBe(405);
    expect(() => createApiApplication({ ...config, enableSyntheticDisputes: 'true' as unknown as boolean })).toThrow('invalid_api_configuration');
    const remote = 'https://remote.invalid';
    expect(() => createApiApplication({ ...config, baseURL: remote, trustedOrigins: [remote], enableSyntheticDisputes: true })).toThrow('invalid_api_configuration');
    expect(() => createApiApplication(config, { disputesClock: 'bad' as unknown as () => Date })).toThrow('invalid_api_configuration');
    expect((await createApiApplication(config, { disputesClock: () => new Date() }).handle(get())).status).toBe(404);
    expect(pool.totalCount).toBe(0);
  } finally { await pool.end(); }
});
