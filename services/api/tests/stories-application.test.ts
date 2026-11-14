import { expect, it } from 'vitest';
import { Pool } from 'pg';
import { createApiApplication, type ApiApplicationConfig } from '../src/api-application.ts';
import { id } from './fixtures.ts';

it('stories has an independent boolean/default-off/loopback-only opt-in without contacting a database', async () => {
  // No connection is made: disabled routes reject before auth; enabled cookie-free reads reject before SQL.
  const pool = new Pool({ max: 1 });
  const config: ApiApplicationConfig = { pool, baseURL: 'http://127.0.0.1:8787', secret: 'synthetic-explicit-stories-secret-for-tests-only',
    trustedOrigins: ['http://127.0.0.1:8787'], emailPasswordEnabled: true,
    limits: { bodyBytes: 65536, bodyReadMs: 1000, statementMs: 7000, lockMs: 5000 } };
  const request = () => new Request(config.baseURL + '/v1/couples/' + id(1) + '/stories?membership_epoch=1', { headers: { origin: config.baseURL } });
  try {
    expect((await createApiApplication(config).handle(request())).status).toBe(404);
    expect((await createApiApplication({ ...config, enableSyntheticStories: false }).handle(request())).status).toBe(404);
    expect((await createApiApplication({ ...config, enableSyntheticStories: true }).handle(request())).status).toBe(401);
    expect(() => createApiApplication({ ...config, enableSyntheticStories: 'true' as unknown as boolean })).toThrow('invalid_api_configuration');
    const baseURL = 'https://remote.invalid';
    expect(() => createApiApplication({ ...config, baseURL, trustedOrigins: [baseURL], enableSyntheticStories: true })).toThrow('invalid_api_configuration');
    expect(pool.totalCount).toBe(0);
  } finally { await pool.end(); }
});
