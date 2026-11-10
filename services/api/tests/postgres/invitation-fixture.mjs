import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { toNodeHandler } from 'better-auth/node';
import { createPairInvitationHandler } from '../../src/pair-invitations.ts';
import { createProfileProvisionHandler } from '../../src/profile-provision.ts';
import { createWaitingSpaceHandler } from '../../src/waiting-space.ts';
import { withDeadline, barrierOrCompletion } from './async-bounds.mjs';
import { account, database, password, waitForQueryLock } from './profile-fixture.mjs';

export const invitationPath = '/v1/spaces/waiting/invite';
export const flags = { enableSyntheticProfileProvisioning: true,
  enableSyntheticWaitingSpaceCreation: true, enableSyntheticPairInvitations: true };
export async function request(f, connection, { method = 'POST', body, suffix = '', headers = {}, path = invitationPath } = {}) {
  const cookie = typeof connection === 'string' ? connection : await connection.getCookie();
  return fetch(`${f.baseURL}${path}${suffix}`, { method, body: method === 'GET' ? undefined : body ?? '{}',
    headers: { origin: f.baseURL, cookie, 'content-type': 'application/json', ...headers } });
}
export async function signup(connection, index) {
  const email = `invitation-${index}@example.test`;
  const result = await connection.auth.signUp.email({ email, password, name: 'Synthetic' });
  assert.equal(result.error, null); return { ...result.data, email };
}
export async function prepareWaiting(f, connection) {
  const profile = await request(f, connection, { path: '/v1/profile' });
  assert.equal(profile.status, 201);
  const waiting = await request(f, connection, { path: '/v1/spaces/waiting' });
  assert.equal(waiting.status, 201); return (await waiting.json()).value;
}
export async function issue(f, connection, commandId) {
  return request(f, connection, { body: JSON.stringify({ commandId }) });
}
export async function revoke(f, connection, inviteId) {
  return request(f, connection, { method: 'DELETE', body: JSON.stringify({ inviteId }) });
}
export async function invitationRows(f) {
  return (await f.domainPool.query('SELECT * FROM pair_invites ORDER BY created_at,id')).rows;
}
export function assertMetadata(invitation) {
  assert.deepEqual(Object.keys(invitation).sort(),
    ['id', 'commandId', 'status', 'createdAt', 'expiresAt', 'revokedAt', 'consumedAt'].sort());
}

// Official provider verification plus product handlers, transaction adapter, and actual loopback sockets.
// Only the response-drop and transaction observation hooks differ from the composed application.
export async function harness(f, { db = database(f), getSession = headers => f.resolve(headers.get('cookie')),
  dropFirstCreatedResponse = false } = {}) {
  let handle;
  const server = createServer((req, res) => { void handle(req, res).catch(() => res.destroy()); });
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.timeout = 6000;
  await withDeadline(new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  }), 3000, 'Invitation HTTP listen');
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  const options = { getSession, trustedOrigins: [baseURL] };
  const invitation = createPairInvitationHandler(db, options);
  const profile = createProfileProvisionHandler(database(f), options);
  const waiting = createWaitingSpaceHandler(database(f), options);
  handle = toNodeHandler(async incoming => {
    const path = new URL(incoming.url).pathname;
    const response = await (path === '/v1/profile' ? profile(incoming)
      : path === '/v1/spaces/waiting' ? waiting(incoming) : invitation(incoming));
    if (path === invitationPath && response.status === 201 && dropFirstCreatedResponse) {
      dropFirstCreatedResponse = false;
      throw new Error('synthetic_lost_http_acknowledgement');
    }
    return response;
  });
  return { baseURL,
    async close() {
      server.closeIdleConnections();
      try { await withDeadline(new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())), 5000, 'Invitation HTTP cleanup'); }
      finally { server.closeAllConnections(); }
    },
  };
}
export async function ownWaiting(f, server, index = 0) {
  const a = await account(f, index);
  return { ...a, ...(await prepareWaiting(server, a.cookie)) };
}
export function observedDatabase(f, hook) {
  const base = database(f);
  return { ...base, transaction: work => base.transaction(tx => work({ query: async (sql, params) => {
    const result = await tx.query(sql, params);
    await hook(sql, params, result);
    return result;
  } })) };
}
export async function waitForLock(f, pending, pattern) {
  return barrierOrCompletion(waitForQueryLock(f, pattern), pending);
}
export async function waitUntilDatabaseTime(f, timestamp) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const result = await f.admin.query('SELECT clock_timestamp() >= $1::timestamptz AS reached', [timestamp]);
    if (result.rows[0].reached) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Database clock did not reach the required expiry');
}
export async function closeCase(f, server, blocker) {
  if (blocker) { try { await blocker.query('ROLLBACK'); } finally { blocker.release(); } }
  try { await server?.close(); } finally { await f.close(); }
}
