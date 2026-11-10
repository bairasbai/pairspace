import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createComposedFixture, client } from './composed-fixture.mjs';
import { createFixture } from './fixture.mjs';
import { observeTask, barrierOrCompletion, settleBounded } from './async-bounds.mjs';
import { password, account, signin, database, harness, gate, waitForProviderLock, waitForQueryLock, counts } from './profile-fixture.mjs';

async function post(f, connection, { body = '{}', suffix = '', method = 'POST', headers = {} } = {}) {
  return fetch(`${f.baseURL}/v1/profile${suffix}`, { method, body: method === 'GET' ? undefined : body,
    headers: { origin: f.baseURL, cookie: await connection.getCookie(), 'content-type': 'application/json', ...headers } });
}
async function signup(connection, index) {
  const result = await connection.auth.signUp.email({ email: `profile-composed-${index}@example.test`, password, name: 'Synthetic' });
  assert.equal(result.error, null); return result.data;
}
const emptyCounts = { users: 0, mappings: 0, couples: 0, members: 0, messages: 0, outbox: 0 };

test('profile endpoint defaults disabled; explicit synthetic opt-in creates exactly one own profile with no pair access', async () => {
  const disabled = await createComposedFixture();
  try {
    const connection = client(disabled.baseURL); await signup(connection, 0);
    assert.equal((await post(disabled, connection)).status, 404);
    assert.deepEqual(await counts(disabled), emptyCounts);
  } finally { await disabled.close(); }
  const f = await createComposedFixture({ enableSyntheticProfileProvisioning: true });
  try {
    const connections = [client(f.baseURL), client(f.baseURL)];
    const accounts = await Promise.all(connections.map((connection, index) => signup(connection, index + 1)));
    assert.deepEqual(await counts(f), emptyCounts, 'signup must not implicitly provision a domain user');
    const expected = [];
    for (const [index, connection] of connections.entries()) {
      const sessionId = (await connection.auth.getSession()).data.session.id;
      const response = await post(f, connection);
      assert.equal(response.status, 201);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      const payload = await response.json();
      assert.equal(payload.ok, true);
      const userId = payload.value.userId;
      assert.match(userId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      assert.notEqual(userId, accounts[index].user.id);
      assert.deepEqual(payload.value, { sessionId, userId, created: true });
      const retry = await post(f, connection);
      assert.equal(retry.status, 200);
      assert.deepEqual(await retry.json(), { ok: true, value: { sessionId, userId, created: false } });
      const context = await fetch(`${f.baseURL}/v1/session/context`, { headers: { origin: f.baseURL, cookie: await connection.getCookie() } });
      assert.deepEqual((await context.json()).value, { state: 'no_active_pair', sessionId, userId });
      assert.equal((await connection.history(randomUUID())).status, 403);
      expected.push(userId);
    }
    assert.notEqual(expected[0], expected[1]);
    assert.deepEqual(await counts(f), { ...emptyCounts, users: 2, mappings: 2 });
    const mappings = await f.domainPool.query('SELECT auth_user_id,user_id FROM better_auth_identities');
    for (const [index, a] of accounts.entries()) assert.equal(mappings.rows.find(row => row.auth_user_id === a.user.id).user_id, expected[index]);
  } finally { await f.close(); }
});

test('profile HTTP rejects identity selectors, unknown fields, malformed input, origins and unauthenticated clients without writes', async () => {
  const f = await createComposedFixture({ enableSyntheticProfileProvisioning: true });
  try {
    const connection = client(f.baseURL); await signup(connection, 3);
    for (const body of ['[]', 'null', 'true', '1', '{', '', '{"userId":"spoof"}', '{"sessionId":"spoof"}',
      '{"authUserId":"spoof"}', '{"coupleId":"spoof"}', '{"created":true}', '{"__proto__":{}}']) {
      assert.equal((await post(f, connection, { body })).status, 400);
    }
    for (const suffix of ['?userId=' + randomUUID(), '?sessionId=spoof', '?authUserId=spoof', '?coupleId=' + randomUUID()]) {
      assert.equal((await post(f, connection, { suffix })).status, 400);
    }
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const result = await post(f, connection, { method });
      assert.equal(result.status, 405); assert.equal(result.headers.get('allow'), 'POST');
    }
    assert.equal((await post(f, connection, { headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await post(f, connection, { body: ' '.repeat(65537) })).status, 413);
    assert.equal((await post(f, connection, { headers: { cookie: '' } })).status, 401);
    assert.equal((await post(f, connection, { headers: { authorization: 'Bearer spoofed' } })).status, 401);
    assert.equal((await post(f, connection, { headers: { origin: 'https://attacker.invalid', 'expo-origin': f.baseURL } })).status, 403);
    assert.deepEqual(await counts(f), emptyCounts);
  } finally { await f.close(); }
});

test('simultaneous profile requests from distinct sessions serialize on provider user and retry with domain-first lock order', async () => {
  const f = await createFixture(); const barrier = gate();
  let server; let first; let second;
  const traces = [];
  try {
    const a = await account(f); const b = await signin(f, a.email);
    assert.notEqual((await f.resolve(a.cookie)).session.id, (await f.resolve(b.cookie)).session.id);
    const base = database(f);
    const db = { ...base, transaction: work => {
      const trace = []; traces.push(trace);
      return base.transaction(tx => work({ query: async (sql, params) => {
        trace.push(sql.replace(/\s+/g, ' ').trim());
        const result = await tx.query(sql, params);
        if (traces.length === 1 && sql.includes('FROM "user"') && sql.includes('FOR UPDATE')) await barrier.hook();
        return result;
      } }));
    } };
    server = await harness(f, { db });
    first = observeTask(server.request(a.cookie));
    await barrierOrCompletion(barrier.ready, first);
    second = observeTask(server.request(b.cookie));
    await waitForProviderLock(f);
    barrier.release();
    const responses = await Promise.all([first, second]);
    assert.deepEqual(responses.map(result => result.status), [201, 200]);
    const [created, existing] = await Promise.all(responses.map(result => result.json()));
    assert.equal(created.value.userId, existing.value.userId);
    assert.notEqual(created.value.sessionId, existing.value.sessionId);
    assert.equal(created.value.created, true); assert.equal(existing.value.created, false);
    assert.deepEqual(await counts(f), { ...emptyCounts, users: 1, mappings: 1 });
    assert.equal(traces.length, 3);
    assert.ok(traces[1].every(sql => !/FROM users|INSERT|UPDATE users|DELETE/.test(sql)), 'waiting transaction must remain read-only');
    assert.match(traces[2][1], /FROM users.*FOR SHARE/);
    assert.match(traces[2][2], /FROM "user".*FOR UPDATE/);
  } finally {
    barrier.release();
    try { await settleBounded([first, second]); } finally { try { await server?.close(); } finally { await f.close(); } }
  }
});

test('lost real HTTP acknowledgement after COMMIT is safely retried without orphan or duplicate profile', async () => {
  const f = await createFixture(); let server;
  try {
    const a = await account(f);
    server = await harness(f, { dropFirstCreatedResponse: true });
    await assert.rejects(server.request(a.cookie), /fetch failed/);
    assert.deepEqual(await counts(f), { ...emptyCounts, users: 1, mappings: 1 });
    const persisted = (await f.domainPool.query('SELECT user_id FROM better_auth_identities WHERE auth_user_id=$1', [a.user.id])).rows[0].user_id;
    const retry = await server.request(a.cookie);
    assert.equal(retry.status, 200);
    assert.deepEqual((await retry.json()).value, { sessionId: (await f.resolve(a.cookie)).session.id, userId: persisted, created: false });
    assert.deepEqual(await counts(f), { ...emptyCounts, users: 1, mappings: 1 });
  } finally { try { await server?.close(); } finally { await f.close(); } }
});

test('revocation completed while profile waits for provider-user lock denies all domain writes', async () => {
  const f = await createFixture(); let server; let pending; let blocker;
  try {
    const a = await account(f);
    server = await harness(f);
    blocker = await f.domainPool.connect(); await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE', [a.user.id]);
    pending = observeTask(server.request(a.cookie));
    await waitForProviderLock(f);
    assert.equal((await f.call('sign-out', {}, a.cookie)).status, 200);
    await blocker.query('COMMIT'); blocker.release(); blocker = undefined;
    const result = await pending;
    assert.equal(result.status, 401);
    assert.deepEqual(await result.json(), { ok: false, error: 'unauthenticated' });
    assert.deepEqual(await counts(f), emptyCounts);
  } finally {
    if (blocker) { try { await blocker.query('ROLLBACK'); } finally { blocker.release(); } }
    try { await settleBounded([pending]); } finally { try { await server?.close(); } finally { await f.close(); } }
  }
});

test('profile-first session lock makes official revocation wait; revoked retry cannot create another profile', async () => {
  const f = await createFixture(); const barrier = gate();
  let server; let pending; let revoke;
  try {
    const a = await account(f); const base = database(f);
    const db = { ...base, transaction: work => base.transaction(tx => work({ query: async (sql, params) => {
      const result = await tx.query(sql, params);
      if (sql.includes('FROM "session"')) await barrier.hook();
      return result;
    } })) };
    server = await harness(f, { db });
    pending = observeTask(server.request(a.cookie));
    await barrierOrCompletion(barrier.ready, pending);
    revoke = observeTask(f.call('sign-out', {}, a.cookie));
    await f.waitForAuthDeleteLock();
    barrier.release();
    assert.equal((await pending).status, 201);
    assert.equal((await revoke).status, 200);
    assert.equal((await server.request(a.cookie)).status, 401);
    assert.deepEqual(await counts(f), { ...emptyCounts, users: 1, mappings: 1 });
  } finally {
    barrier.release();
    try { await settleBounded([pending, revoke]); } finally { try { await server?.close(); } finally { await f.close(); } }
  }
});

test('deleted domain profiles remain unavailable and never get resurrected or reassigned across accounts', async () => {
  const f = await createComposedFixture({ enableSyntheticProfileProvisioning: true });
  try {
    const a = client(f.baseURL); const b = client(f.baseURL);
    const accounts = await Promise.all([signup(a, 10), signup(b, 11)]);
    const values = await Promise.all([a, b].map(async connection => (await (await post(f, connection)).json()).value));
    await f.domainPool.query('UPDATE users SET deleted_at=clock_timestamp() WHERE id=$1', [values[0].userId]);
    const deleted = await post(f, a);
    assert.equal(deleted.status, 409); assert.deepEqual(await deleted.json(), { ok: false, error: 'profile_unavailable' });
    assert.equal((await post(f, a, { body: JSON.stringify({ userId: values[1].userId, authUserId: accounts[1].user.id }) })).status, 400);
    assert.equal((await post(f, b, { body: JSON.stringify({ userId: values[0].userId }) })).status, 400);
    assert.deepEqual((await (await post(f, b)).json()).value, { ...values[1], created: false });
    const mapping = (await f.domainPool.query('SELECT user_id FROM better_auth_identities WHERE auth_user_id=$1', [accounts[0].user.id])).rows[0];
    assert.equal(mapping.user_id, values[0].userId);
    assert.notEqual((await f.domainPool.query('SELECT deleted_at FROM users WHERE id=$1', [values[0].userId])).rows[0].deleted_at, null);
    assert.deepEqual(await counts(f), { ...emptyCounts, users: 2, mappings: 2 });
  } finally { await f.close(); }
});

test('observed mapping removal or unsupported reassignment fails closed without overwriting any identity', async () => {
  for (const change of ['remove', 'replace']) {
    const f = await createFixture(); let server;
    try {
      const a = await account(f); const original = randomUUID(); const other = randomUUID();
      await f.domainPool.query('INSERT INTO users(id) VALUES($1),($2)', [original, other]);
      await f.domainPool.query('INSERT INTO better_auth_identities VALUES($1,$2)', [a.user.id, original]);
      const base = database(f);
      const db = { ...base, transaction: work => base.transaction(tx => work({ query: async (sql, params) => {
        const result = await tx.query(sql, params);
        if (sql.includes('FROM better_auth_identities') && !sql.includes('FOR SHARE')) {
          if (change === 'remove') await f.domainPool.query('DELETE FROM better_auth_identities WHERE auth_user_id=$1', [a.user.id]);
          else await f.domainPool.query('UPDATE better_auth_identities SET user_id=$1 WHERE auth_user_id=$2', [other, a.user.id]);
        }
        return result;
      } })) };
      server = await harness(f, { db });
      assert.equal((await server.request(a.cookie)).status, 409);
      const rows = (await f.domainPool.query('SELECT user_id FROM better_auth_identities')).rows;
      assert.deepEqual(rows, change === 'remove' ? [] : [{ user_id: other }]);
      assert.deepEqual(await counts(f), { ...emptyCounts, users: 2, mappings: change === 'remove' ? 0 : 1 });
    } finally { try { await server?.close(); } finally { await f.close(); } }
  }
});

test('mapping-insert failure rolls back the new domain row and a later retry creates one complete profile', async () => {
  const f = await createComposedFixture({ enableSyntheticProfileProvisioning: true });
  try {
    const connection = client(f.baseURL); await signup(connection, 12);
    await f.domainPool.query(`CREATE FUNCTION reject_profile() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic private SQL failure'; END; $$;
      CREATE TRIGGER reject_profile BEFORE INSERT ON better_auth_identities FOR EACH ROW EXECUTE FUNCTION reject_profile()`);
    const response = await post(f, connection);
    assert.equal(response.status, 503); assert.deepEqual(await response.json(), { ok: false, error: 'temporarily_unavailable' });
    assert.deepEqual(await counts(f), emptyCounts, 'the users insert must roll back with its failed mapping');
    await f.domainPool.query('DROP TRIGGER reject_profile ON better_auth_identities');
    assert.equal((await post(f, connection)).status, 201);
    assert.equal((await post(f, connection)).status, 200);
    assert.deepEqual(await counts(f), { ...emptyCounts, users: 1, mappings: 1 });
  } finally { await f.close(); }
});


test('authoritative expiry is checked again after a real mapping-row lock wait', async () => {
  const f = await createFixture(); let server; let pending; let blocker;
  try {
    const a = await account(f); const id = randomUUID();
    await f.domainPool.query('INSERT INTO users(id) VALUES($1)', [id]);
    await f.domainPool.query('INSERT INTO better_auth_identities VALUES($1,$2)', [a.user.id, id]);
    server = await harness(f, { getSession: async headers => {
      const session = await f.resolve(headers.get('cookie'));
      assert.ok(session);
      // Keep the real official verification output; shorten only the authoritative SQL row.
      await f.authPool.query(`UPDATE "session" SET "expiresAt"=clock_timestamp()+interval '1 second' WHERE id=$1`, [session.session.id]);
      return session;
    } });
    blocker = await f.domainPool.connect(); await blocker.query('BEGIN');
    await blocker.query('SELECT user_id FROM better_auth_identities WHERE auth_user_id=$1 FOR UPDATE', [a.user.id]);
    pending = observeTask(server.request(a.cookie));
    await waitForQueryLock(f, '%FROM better_auth_identities%FOR SHARE%');
    await new Promise(resolve => setTimeout(resolve, 1100));
    await blocker.query('COMMIT'); blocker.release(); blocker = undefined;
    const result = await pending;
    assert.equal(result.status, 401);
    assert.deepEqual(await result.json(), { ok: false, error: 'unauthenticated' });
    assert.deepEqual(await counts(f), { ...emptyCounts, users: 1, mappings: 1 });
  } finally {
    if (blocker) { try { await blocker.query('ROLLBACK'); } finally { blocker.release(); } }
    try { await settleBounded([pending]); } finally { try { await server?.close(); } finally { await f.close(); } }
  }
});
