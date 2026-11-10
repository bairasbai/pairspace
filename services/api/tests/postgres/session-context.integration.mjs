import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { toNodeHandler } from 'better-auth/node';
import { createSessionContextHandler } from '../../src/session-context.ts';
import { createComposedFixture, client } from './composed-fixture.mjs';
import { createFixture } from './fixture.mjs';
import { observeTask, barrierOrCompletion, settleBounded, withDeadline } from './async-bounds.mjs';

const password = 'Synthetic-only-password-712!';
const cookie = response => response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
async function signup(connection, index) {
  const result = await connection.auth.signUp.email({ email: `context-${index}@example.test`, password, name: 'Synthetic' });
  assert.equal(result.error, null); return result.data;
}
async function context(f, connection, suffix = '', extra = {}) {
  return fetch(`${f.baseURL}/v1/session/context${suffix}`, {
    headers: { origin: f.baseURL, cookie: await connection.getCookie(), ...extra },
  });
}
async function value(f, connection) {
  const result = await context(f, connection);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  return (await result.json()).value;
}

// This harness changes only the injected reader/SQL wrapper. It uses official provider verification,
// real PostgreSQL, the product context handler, and real loopback HTTP rather than mocked auth output.
async function harness(f, database, getSession) {
  let handle;
  const server = createServer((req, res) => { void handle(req, res).catch(() => res.destroy()); });
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.timeout = 6000;
  await withDeadline(new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  }), 3000, 'Context HTTP listen');
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  handle = toNodeHandler(createSessionContextHandler(database, { getSession, trustedOrigins: [baseURL] }));
  return { baseURL,
    request: sessionCookie => fetch(`${baseURL}/v1/session/context`, { headers: { origin: baseURL, cookie: sessionCookie } }),
    async close() {
      server.closeIdleConnections();
      try { await withDeadline(new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())), 5000, 'Context HTTP cleanup'); }
      finally { server.closeAllConnections(); }
    },
  };
}
async function account(f) {
  const response = await f.call('sign-up/email', { name: 'Synthetic', email: 'context-race@example.test', password });
  assert.equal(response.status, 200);
  return { ...(await response.json()), cookie: cookie(response) };
}
function gate() {
  let entered; let release;
  const ready = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  return { ready, release: () => release(), hook: async () => { entered(); await blocked; } };
}

test('context discovers only server-owned unmapped/no-pair/ready states and refreshes pair/epoch', async () => {
  const f = await createComposedFixture();
  try {
    const clients = [0, 1, 2, 3, 4].map(() => client(f.baseURL));
    const accounts = await Promise.all(clients.map((connection, index) => signup(connection, index)));
    const session = (await clients[0].auth.getSession()).data.session;
    assert.deepEqual(await value(f, clients[0]), { state: 'unmapped', sessionId: session.id });
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM users')).rows[0].n, 0);
    const unmappedDomainId = randomUUID();
    await f.domainPool.query('INSERT INTO users(id) VALUES($1)', [unmappedDomainId]);
    await f.domainPool.query('INSERT INTO better_auth_identities VALUES($1,$2)', [accounts[0].user.id, unmappedDomainId]);
    assert.deepEqual(await value(f, clients[0]), { state: 'no_active_pair', sessionId: session.id, userId: unmappedDomainId });
    const pairA = randomUUID(); const pairB = randomUUID();
    const idsA = await f.provision(accounts.slice(1, 3).map(a => a.user.id), pairA);
    const idsB = await f.provision(accounts.slice(3, 5).map(a => a.user.id), pairB);
    const aSession = (await clients[1].auth.getSession()).data.session;
    assert.deepEqual(await value(f, clients[1]), { state: 'ready', sessionId: aSession.id,
      userId: idsA[0], coupleId: pairA, membershipEpoch: 1 });
    const bContext = await value(f, clients[3]);
    assert.equal(bContext.userId, idsB[0]); assert.equal(bContext.coupleId, pairB);
    await f.domainPool.query('UPDATE couples SET membership_epoch=2 WHERE id=$1', [pairA]);
    assert.equal((await value(f, clients[1])).membershipEpoch, 2);
    assert.equal((await clients[1].history(pairA)).status, 409, 'snapshot is not an authorization grant');
    await f.domainPool.query("UPDATE couples SET status='closed',membership_epoch=3 WHERE id=$1", [pairA]);
    assert.equal((await value(f, clients[1])).state, 'no_active_pair');
    await f.domainPool.query("UPDATE couple_members SET status='revoked' WHERE couple_id=$1", [pairA]);
    assert.equal((await value(f, clients[1])).state, 'no_active_pair');
    // A different active pair is selected on the next refresh, with no client-owned IDs involved.
    const replacement = randomUUID();
    const tx = await f.domainPool.connect();
    try {
      await tx.query('BEGIN');
      await tx.query("INSERT INTO couples(id,status) VALUES($1,'waiting_partner')", [replacement]);
      for (const [index, id] of idsA.entries()) await tx.query("INSERT INTO couple_members VALUES($1,$2,$3,'active')", [replacement, id, index + 1]);
      await tx.query("UPDATE couples SET status='active' WHERE id=$1", [replacement]);
      await tx.query('COMMIT');
    } catch (error) { await tx.query('ROLLBACK'); throw error; } finally { tx.release(); }
    assert.equal((await value(f, clients[1])).coupleId, replacement);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM chat_messages')).rows[0].n, 0);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM outbox_events')).rows[0].n, 0);
  } finally { await f.close(); }
});

test('context HTTP rejects forged selectors, missing cookie, bearer credentials, origins and non-GET writes', async () => {
  const f = await createComposedFixture();
  try {
    const connection = client(f.baseURL); await signup(connection, 10);
    for (const query of ['?coupleId=' + randomUUID(), '?userId=' + randomUUID(), '?membershipEpoch=1', '?sessionId=spoofed']) {
      assert.equal((await context(f, connection, query)).status, 400);
    }
    assert.equal((await context(f, connection, '', { authorization: 'Bearer spoofed' })).status, 401);
    for (const headers of [{}, { origin: 'https://attacker.invalid' }, { origin: 'https://attacker.invalid', 'expo-origin': f.baseURL }]) {
      assert.equal((await fetch(`${f.baseURL}/v1/session/context`, { headers })).status, 403);
    }
    assert.equal((await fetch(`${f.baseURL}/v1/session/context`, { headers: { origin: f.baseURL } })).status, 401);
    const wrongMethod = await fetch(`${f.baseURL}/v1/session/context`, { method: 'POST',
      headers: { origin: f.baseURL, cookie: await connection.getCookie(), 'content-type': 'application/json' },
      body: JSON.stringify({ userId: randomUUID(), coupleId: randomUUID() }) });
    assert.equal(wrongMethod.status, 405); assert.equal(wrongMethod.headers.get('allow'), 'GET');
  } finally { await f.close(); }
});

test('context denies revoked/expired/provider-deleted and domain-deleted identities and redacts SQL failure', async () => {
  const f = await createComposedFixture();
  try {
    const connections = [0, 1, 2].map(() => client(f.baseURL));
    const accounts = await Promise.all(connections.map((connection, index) => signup(connection, 20 + index)));
    const session = (await connections[0].auth.getSession()).data.session;
    const retainedCookie = await connections[0].getCookie();
    assert.equal((await connections[0].auth.signOut()).error, null);
    assert.equal((await context(f, { getCookie: async () => retainedCookie })).status, 401);
    const expiringSession = (await connections[1].auth.getSession()).data.session;
    await f.domainPool.query('UPDATE "session" SET "expiresAt"=clock_timestamp() WHERE id=$1', [expiringSession.id]);
    assert.equal((await context(f, connections[1])).status, 401);
    const id = randomUUID();
    await f.domainPool.query('INSERT INTO users(id,deleted_at) VALUES($1,clock_timestamp())', [id]);
    await f.domainPool.query('INSERT INTO better_auth_identities VALUES($1,$2)', [accounts[2].user.id, id]);
    assert.equal((await context(f, connections[2])).status, 401);
    await f.domainPool.query('UPDATE users SET deleted_at=NULL WHERE id=$1', [id]);
    await f.domainPool.query('ALTER TABLE better_auth_identities RENAME TO unavailable_identities');
    const failure = await context(f, connections[2]);
    assert.equal(failure.status, 503);
    assert.deepEqual(await failure.json(), { ok: false, error: 'temporarily_unavailable' });
    await f.domainPool.query('ALTER TABLE unavailable_identities RENAME TO better_auth_identities');
    await f.domainPool.query('DELETE FROM "user" WHERE id=$1', [accounts[2].user.id]);
    assert.equal((await context(f, connections[2])).status, 401);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM "session" WHERE id=$1', [session.id])).rows[0].n, 0);
  } finally { await f.close(); }
});

test('official revocation between provider verification and context transaction fails closed on real PG', async () => {
  const f = await createFixture(); let server;
  try {
    const a = await account(f);
    server = await harness(f, f.database(), async headers => {
      const verified = await f.resolve(headers.get('cookie'));
      assert.ok(verified);
      assert.equal((await f.call('sign-out', {}, a.cookie)).status, 200);
      return verified;
    });
    const result = await server.request(a.cookie);
    assert.equal(result.status, 401);
    assert.deepEqual(await result.json(), { ok: false, error: 'unauthenticated' });
  } finally { try { await server?.close(); } finally { await f.close(); } }
});

test('context transaction holds provider session lock while official revocation waits', async () => {
  const f = await createFixture(); const barrier = gate();
  let server; let reading; let revoke;
  try {
    const a = await account(f);
    const base = f.database();
    const database = { ...base, transaction: work => base.transaction(tx => work({ query: async (sql, params) => {
      const result = await tx.query(sql, params);
      if (sql.includes('FROM "session"')) await barrier.hook();
      return result;
    } })) };
    server = await harness(f, database, headers => f.resolve(headers.get('cookie')));
    reading = observeTask(server.request(a.cookie));
    await barrierOrCompletion(barrier.ready, reading);
    revoke = observeTask(f.call('sign-out', {}, a.cookie));
    await f.waitForAuthDeleteLock();
    barrier.release();
    assert.equal((await reading).status, 200);
    assert.equal((await revoke).status, 200);
    assert.equal((await server.request(a.cookie)).status, 401);
  } finally {
    barrier.release();
    try { await settleBounded([reading, revoke]); } finally { try { await server?.close(); } finally { await f.close(); } }
  }
});

test('context detects an unsupported mapping remap between discovery and authoritative lock', async () => {
  const f = await createFixture(); let server;
  try {
    const a = await account(f); const original = randomUUID(); const other = randomUUID();
    await f.domainPool.query('INSERT INTO users(id) VALUES($1),($2)', [original, other]);
    await f.domainPool.query('INSERT INTO better_auth_identities VALUES($1,$2)', [a.user.id, original]);
    const base = f.database();
    const database = { ...base, transaction: work => base.transaction(tx => work({ query: async (sql, params) => {
      const result = await tx.query(sql, params);
      if (sql.includes('FROM better_auth_identities') && !sql.includes('FOR SHARE')) {
        await f.domainPool.query('UPDATE better_auth_identities SET user_id=$1 WHERE auth_user_id=$2', [other, a.user.id]);
      }
      return result;
    } })) };
    server = await harness(f, database, headers => f.resolve(headers.get('cookie')));
    assert.equal((await server.request(a.cookie)).status, 401);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM couples')).rows[0].n, 0);
  } finally { try { await server?.close(); } finally { await f.close(); } }
});
