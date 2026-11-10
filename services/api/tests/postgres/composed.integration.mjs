import { request as httpRequest } from 'node:http';
import { performance } from 'node:perf_hooks';
import { withDeadline } from './async-bounds.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createComposedFixture, client } from './composed-fixture.mjs';
const password = 'Synthetic-only-password-712!';
async function signup(connection, index) {
  const result = await connection.auth.signUp.email({ email: `composed-${index}@example.test`, password, name: 'Synthetic' });
  assert.equal(result.error, null); return result.data;
}

test('official client → real loopback composed app → auth → PRODUCT chat → revoke denial on real PG', async () => {
  const f = await createComposedFixture();
  try {
    const clients = [1, 2, 3, 4].map(() => client(f.baseURL));
    const accounts = await Promise.all(clients.map((connection, index) => signup(connection, index)));
    const pairA = randomUUID(); const pairB = randomUUID();
    assert.equal((await clients[0].send(pairA, randomUUID())).status, 401, 'auth account alone has no domain mapping');
    const ids = await f.provision(accounts.slice(0, 2).map(a => a.user.id), pairA);
    await f.provision(accounts.slice(2).map(a => a.user.id), pairB);
    const messageId = randomUUID();
    assert.equal((await clients[0].send(pairA, messageId)).status, 201);
    assert.equal((await clients[0].send(pairA, messageId)).status, 200);
    const page = await clients[1].history(pairA);
    assert.equal(page.status, 200); assert.equal((await page.json()).value.messages[0].senderId, ids[0]);
    assert.equal((await clients[2].history(pairA)).status, 403);
    assert.equal((await clients[0].send(pairB, randomUUID())).status, 403);
    const second = client(f.baseURL);
    assert.equal((await second.auth.signIn.email({ email: accounts[0].user.email, password: 'wrong-password' })).error.status, 401);
    const login = await second.auth.signIn.email({ email: accounts[0].user.email, password });
    assert.equal(login.error, null);
    assert.equal((await second.auth.getSession()).data.user.id, accounts[0].user.id);
    assert.equal((await second.history(pairA)).status, 200);
    assert.equal((await clients[0].auth.revokeSession({ token: login.data.token })).error, null);
    assert.equal((await second.auth.getSession()).data, null);
    assert.equal((await second.send(pairA, randomUUID())).status, 401);
    assert.equal((await clients[0].history(pairA)).status, 200);
    assert.equal((await clients[0].auth.signOut()).error, null);
    assert.equal((await clients[0].history(pairA)).status, 401);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM outbox_events')).rows[0].n, 1);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM auth_sessions')).rows[0].n, 0);
  } finally { await f.close(); }
});

test('composed HTTP perimeter rejects CSRF origins, missing origin, oversized and invalid requests', async () => {
  const f = await createComposedFixture();
  try {
    const endpoint = `${f.baseURL}/api/auth/sign-up/email`;
    for (const headers of [{}, { origin: 'https://attacker.invalid' }, { origin: 'https://attacker.invalid', 'expo-origin': f.baseURL }]) {
      const result = await fetch(endpoint, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' });
      assert.equal(result.status, 403);
    }
    const oversized = await fetch(endpoint, { method: 'POST', headers: { origin: f.baseURL, 'content-type': 'application/json' }, body: 'x'.repeat(65537) });
    assert.equal(oversized.status, 413);
    const media = await fetch(endpoint, { method: 'POST', headers: { origin: f.baseURL, 'content-type': 'text/plain' }, body: '{}' });
    assert.equal(media.status, 415);
    const malformed = await fetch(endpoint, { method: 'POST', headers: { origin: f.baseURL, 'content-type': 'application/json' }, body: '{' });
    assert.equal(malformed.status, 400);
    const unknown = await fetch(`${f.baseURL}/unmounted`, { headers: { origin: f.baseURL } });
    assert.equal(unknown.status, 404);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM "user"')).rows[0].n, 0);
  } finally { await f.close(); }
});

test('composed HTTP redacts auth/database failures and product outbox transaction remains atomic', async () => {
  const f = await createComposedFixture();
  try {
    const alice = client(f.baseURL); const bob = client(f.baseURL);
    const a = await signup(alice, 10); const b = await signup(bob, 11);
    const pair = randomUUID(); await f.provision([a.user.id, b.user.id], pair);
    await f.domainPool.query('ALTER TABLE outbox_events ADD CONSTRAINT synthetic_reject CHECK(false)');
    const inputId = randomUUID();
    const failure = await alice.send(pair, inputId);
    assert.equal(failure.status, 503);
    assert.deepEqual(await failure.json(), { ok: false, error: 'temporarily_unavailable' });
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM chat_messages')).rows[0].n, 0);
    await f.domainPool.query('ALTER TABLE outbox_events DROP CONSTRAINT synthetic_reject');
    assert.equal((await alice.send(pair, inputId)).status, 201);
    await f.domainPool.query('ALTER TABLE "user" RENAME TO unavailable_provider_users');
    const originalError = console.error;
    const errorLogs = [];
    try {
      console.error = (...args) => { errorLogs.push(args); };
      const authFailure = await alice.auth.signIn.email({ email: a.user.email, password });
      assert.equal(authFailure.error.status, 503);
      assert.equal(JSON.stringify(authFailure.error).includes('SELECT'), false);
      assert.equal(errorLogs.length, 0, 'unexpected provider failure must not log raw SQL/details');
    } finally { console.error = originalError; }
  } finally { await f.close(); }
});


test('stalled HTTP upload is bounded and does not prevent a later healthy request', async () => {
  const f = await createComposedFixture();
  let pending;
  try {
    const started = performance.now();
    const outcome = await withDeadline(new Promise(resolve => {
      pending = httpRequest(`${f.baseURL}/api/auth/sign-up/email`, { method: 'POST',
        headers: { origin: f.baseURL, 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, response => {
        response.resume(); response.on('end', () => resolve({ status: response.statusCode }));
      });
      pending.on('error', error => resolve({ error: error.code }));
      pending.write('{'); // Deliberately never finish the upload.
    }), 3000, 'Stalled upload');
    assert.ok(outcome.status === 408 || outcome.error === 'ECONNRESET', 'deadline rejects or closes the stalled upload');
    assert.ok(performance.now() - started >= 500, 'not an unrelated immediate transport failure');
    const healthy = await fetch(`${f.baseURL}/api/auth/get-session`, { headers: { origin: f.baseURL } });
    assert.equal(healthy.status, 200);
  } finally { pending?.destroy(); await f.close(); }
});


test('explicitly disabled email/password configuration cannot create accounts', async () => {
  const f = await createComposedFixture({ emailPasswordEnabled: false });
  try {
    const connection = client(f.baseURL);
    const signup = await connection.auth.signUp.email({ email: 'disabled@example.test', password, name: 'Synthetic' });
    assert.ok(signup.error && signup.error.status >= 400);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM "user"')).rows[0].n, 0);
  } finally { await f.close(); }
});
