import { expect, it } from 'vitest';
import { Pool } from 'pg';
import { createApiApplication, type ApiApplicationConfig } from '../src/api-application.ts';
import { id } from './fixtures.ts';
it('hard questions has its own default-off boolean/loopback flag and guarded DELETE body, without database contact', async () => {
  const pool = new Pool({ max: 1 });
  const config: ApiApplicationConfig = { pool, baseURL: 'http://127.0.0.1:8787', trustedOrigins: ['http://127.0.0.1:8787'],
    secret: 'synthetic-hard-question-secret-for-local-tests-only', emailPasswordEnabled: true,
    limits: { bodyBytes: 65536, bodyReadMs: 1000, statementMs: 7000, lockMs: 5000 } };
  const url = config.baseURL + '/v1/couples/' + id(1) + '/hard-questions';
  const get = () => new Request(url + '?membership_epoch=1', { headers: { origin: config.baseURL } });
  try {
    expect((await createApiApplication(config).handle(get())).status).toBe(404);
    expect((await createApiApplication({ ...config, enableSyntheticHardQuestions: false }).handle(get())).status).toBe(404);
    expect((await createApiApplication({ ...config, enableSyntheticStories: true }).handle(get())).status).toBe(404);
    const app = createApiApplication({ ...config, enableSyntheticHardQuestions: true });
    expect((await app.handle(get())).status).toBe(401);
    expect((await app.handle(new Request(url + '/' + id(2), { method: 'DELETE', headers: { origin: config.baseURL, 'content-type': 'text/plain' }, body: '{}' }))).status).toBe(415);
    expect((await app.handle(new Request(url + '/' + id(2), { method: 'PUT', headers: { origin: config.baseURL } }))).status).toBe(405);
    expect(() => createApiApplication({ ...config, enableSyntheticHardQuestions: 'true' as unknown as boolean })).toThrow('invalid_api_configuration');
    const remote = 'https://remote.invalid';
    expect(() => createApiApplication({ ...config, baseURL: remote, trustedOrigins: [remote], enableSyntheticHardQuestions: true })).toThrow('invalid_api_configuration');
    expect(pool.totalCount).toBe(0);
  } finally { await pool.end(); }
});
