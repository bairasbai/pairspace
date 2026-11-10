import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { toNodeHandler } from 'better-auth/node';
import { createPostgresDatabase } from '../../src/postgres-database.ts';
import { createProfileProvisionHandler } from '../../src/profile-provision.ts';
import { withDeadline } from './async-bounds.mjs';

export const password = 'Synthetic-only-password-712!';
const cookie = response => response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
export async function account(f, index = 0) {
  const email = `profile-${index}@example.test`;
  const response = await f.call('sign-up/email', { name: 'Synthetic', email, password });
  assert.equal(response.status, 200);
  return { ...(await response.json()), email, cookie: cookie(response) };
}
export async function signin(f, email) {
  const response = await f.call('sign-in/email', { email, password });
  assert.equal(response.status, 200);
  return { ...(await response.json()), cookie: cookie(response) };
}
export function database(f) {
  return createPostgresDatabase(f.domainPool, { statementMs: 7000, lockMs: 5000 });
}

// Only test wrappers differ: official verification, product transaction adapter and real loopback HTTP.
export async function harness(f, { db = database(f), getSession = headers => f.resolve(headers.get('cookie')),
  dropFirstCreatedResponse = false } = {}) {
  let handle;
  const server = createServer((req, res) => { void handle(req, res).catch(() => res.destroy()); });
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.timeout = 6000;
  await withDeadline(new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  }), 3000, 'Profile HTTP listen');
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  const profile = createProfileProvisionHandler(db, { getSession, trustedOrigins: [baseURL] });
  handle = toNodeHandler(async request => {
    const response = await profile(request);
    if (response.status === 201 && dropFirstCreatedResponse) {
      dropFirstCreatedResponse = false;
      // The real transaction has committed; destroy the socket before its HTTP acknowledgement.
      throw new Error('synthetic_lost_http_acknowledgement');
    }
    return response;
  });
  return { baseURL,
    request: (sessionCookie, body = '{}') => fetch(`${baseURL}/v1/profile`, {
      method: 'POST', body, headers: { origin: baseURL, cookie: sessionCookie, 'content-type': 'application/json' },
    }),
    async close() {
      server.closeIdleConnections();
      try { await withDeadline(new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())), 5000, 'Profile HTTP cleanup'); }
      finally { server.closeAllConnections(); }
    },
  };
}

export function gate() {
  let entered; let release;
  const ready = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  return { ready, release: () => release(), hook: async () => { entered(); await blocked; } };
}
export const waitForProviderLock = f => waitForQueryLock(f, '%FROM "user"%FOR UPDATE%');
export async function waitForQueryLock(f, pattern) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const { rows } = await f.admin.query(`SELECT wait_event_type FROM pg_stat_activity
      WHERE datname=current_database() AND application_name=$1 AND state='active'
        AND query LIKE $2`, [`ps-domain-${f.schema}`, pattern]);
    if (rows.some(row => row.wait_event_type === 'Lock')) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Required database lock wait was not observed');
}
export async function counts(f) {
  return (await f.domainPool.query(`SELECT
    (SELECT count(*)::int FROM users) users,
    (SELECT count(*)::int FROM better_auth_identities) mappings,
    (SELECT count(*)::int FROM couples) couples,
    (SELECT count(*)::int FROM couple_members) members,
    (SELECT count(*)::int FROM chat_messages) messages,
    (SELECT count(*)::int FROM outbox_events) outbox`)).rows[0];
}
