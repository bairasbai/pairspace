import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { toNodeHandler } from 'better-auth/node';
import { createApiApplication } from '../../src/api-application.ts';
import { createFixture } from './fixture.mjs';
import { withDeadline } from './async-bounds.mjs';

/** Dedicated real fixture: independent opt-in/migration, existing guards unchanged. */
export async function createDailyQuestionsMobileFixture() {
  const fixture = await createFixture();
  let featureNow = '2026-11-10T00:00:00.000Z';
  let handler = async (_req, res) => { res.writeHead(503); res.end(); };
  const server = createServer((req, res) => { void handler(req, res).catch(() => res.destroy()); });
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.timeout = 6000;
  try {
    await fixture.domainPool.query(await readFile(new URL('../../migrations/046_daily_questions.sql', import.meta.url), 'utf8'));
    await withDeadline(new Promise((resolve, reject) => {
      server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
    }), 3000, 'Daily question mobile HTTP listen');
    const baseURL = `http://127.0.0.1:${server.address().port}`;
    const app = createApiApplication({ pool: fixture.domainPool, baseURL, trustedOrigins: [baseURL],
      secret: randomBytes(48).toString('base64url'), emailPasswordEnabled: true,
      enableSyntheticDailyQuestions: true, enableSyntheticPairLeave: true,
      limits: { bodyBytes: 65536, bodyReadMs: 1000, statementMs: 7000, lockMs: 5000 } }, { dailyQuestionsClock: () => new Date(featureNow) });
    handler = toNodeHandler(app.handle);
    return { ...fixture, baseURL, setFeatureTime(value) {
      if (!Number.isFinite(Date.parse(value))) throw Error('invalid_fixture_time');
      featureNow = value;
    }, async close() {
      try {
        server.closeIdleConnections();
        await withDeadline(new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())), 5000, 'Daily question mobile HTTP cleanup');
      } finally { server.closeAllConnections(); await fixture.close(); }
    } };
  } catch (error) { server.closeAllConnections(); server.close(); await fixture.close(); throw error; }
}
