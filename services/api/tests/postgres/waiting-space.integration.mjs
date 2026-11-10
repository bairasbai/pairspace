import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createComposedFixture, client } from './composed-fixture.mjs';
import { password, counts } from './profile-fixture.mjs';

const flags = { enableSyntheticProfileProvisioning: true, enableSyntheticWaitingSpaceCreation: true };
const emptyCounts = { users: 0, mappings: 0, couples: 0, members: 0, messages: 0, outbox: 0 };
async function signup(connection, index) {
  const email = `waiting-composed-${index}@example.test`;
  const result = await connection.auth.signUp.email({ email, password, name: 'Synthetic' });
  assert.equal(result.error, null); return { ...result.data, email };
}
async function post(f, connection, { body = '{}', suffix = '', method = 'POST', headers = {}, path = '/v1/spaces/waiting' } = {}) {
  return fetch(`${f.baseURL}${path}${suffix}`, { method, body: method === 'GET' ? undefined : body,
    headers: { origin: f.baseURL, cookie: await connection.getCookie(), 'content-type': 'application/json', ...headers } });
}
async function context(f, connection) {
  return fetch(`${f.baseURL}/v1/session/context`, { headers: { origin: f.baseURL, cookie: await connection.getCookie() } });
}
async function profile(f, connection) {
  const result = await post(f, connection, { path: '/v1/profile' });
  assert.equal(result.status, 201); return (await result.json()).value;
}

test('waiting creation is explicit, independently gated and never provisions a missing profile', async () => {
  for (const options of [{}, { enableSyntheticProfileProvisioning: true }, { enableSyntheticWaitingSpaceCreation: true }]) {
    const f = await createComposedFixture(options);
    try {
      const connection = client(f.baseURL); await signup(connection, 0);
      const result = await post(f, connection);
      assert.equal(result.status, options.enableSyntheticWaitingSpaceCreation ? 409 : 404);
      if (options.enableSyntheticWaitingSpaceCreation) {
        assert.deepEqual(await result.json(), { ok: false, error: 'profile_unavailable' });
        assert.equal((await post(f, connection, { path: '/v1/profile' })).status, 404);
      }
      assert.deepEqual(await counts(f), emptyCounts);
    } finally { await f.close(); }
  }
});

test('two accounts create isolated own waiting spaces and context snapshots without chat authority', async () => {
  const f = await createComposedFixture(flags);
  try {
    const connections = [client(f.baseURL), client(f.baseURL)];
    const accounts = await Promise.all(connections.map((connection, index) => signup(connection, index + 1)));
    const profiles = await Promise.all(connections.map(connection => profile(f, connection)));
    const spaces = [];
    for (const [index, connection] of connections.entries()) {
      const response = await post(f, connection);
      assert.equal(response.status, 201);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      const payload = await response.json(); const { coupleId } = payload.value;
      assert.match(coupleId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      const { sessionId, userId } = profiles[index];
      assert.deepEqual(payload, { ok: true, value: { sessionId, userId, coupleId, membershipEpoch: 1, created: true } });
      assert.deepEqual((await (await context(f, connection)).json()).value,
        { state: 'waiting_partner', sessionId, userId, coupleId, membershipEpoch: 1 });
      assert.equal((await connection.send(coupleId, randomUUID())).status, 403);
      assert.equal((await connection.history(coupleId)).status, 403);
      const retry = await post(f, connection);
      assert.equal(retry.status, 200);
      assert.deepEqual(await retry.json(), { ok: true, value: { ...payload.value, created: false } });
      spaces.push(payload.value);
    }
    assert.notEqual(spaces[0].coupleId, spaces[1].coupleId);
    assert.equal((await connections[0].history(spaces[1].coupleId)).status, 403);
    assert.equal((await connections[1].send(spaces[0].coupleId, randomUUID())).status, 403);
    const relogin = client(f.baseURL);
    assert.equal((await relogin.auth.signIn.email({ email: accounts[0].email, password })).error, null);
    const repeated = await post(f, relogin);
    assert.equal(repeated.status, 200);
    const value = (await repeated.json()).value;
    assert.notEqual(value.sessionId, spaces[0].sessionId);
    assert.deepEqual(value, { ...spaces[0], sessionId: (await relogin.auth.getSession()).data.session.id, created: false });
    assert.deepEqual(await counts(f), { ...emptyCounts, users: 2, mappings: 2, couples: 2, members: 2 });
    assert.deepEqual((await f.domainPool.query('SELECT status,membership_epoch,next_chat_seq::int FROM couples')).rows,
      [{ status: 'waiting_partner', membership_epoch: 1, next_chat_seq: 1 }, { status: 'waiting_partner', membership_epoch: 1, next_chat_seq: 1 }]);
    assert.ok((await f.domainPool.query('SELECT slot,status FROM couple_members')).rows.every(row => row.slot === 1 && row.status === 'active'));
  } finally { await f.close(); }
});

test('waiting HTTP rejects caller IDs, malformed bodies, wrong methods/origins and unauthenticated requests without writes', async () => {
  const f = await createComposedFixture(flags);
  try {
    const connection = client(f.baseURL); await signup(connection, 4); await profile(f, connection);
    for (const body of ['[]', 'null', 'true', '1', '{', '', '{"userId":"spoof"}', '{"sessionId":"spoof"}',
      '{"authUserId":"spoof"}', '{"coupleId":"spoof"}', '{"created":true}', '{"slot":1}', '{"membershipEpoch":1}']) {
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
    assert.deepEqual(await counts(f), { ...emptyCounts, users: 1, mappings: 1 });
  } finally { await f.close(); }
});

test('an active pair or closed live membership cannot be bypassed by creating another space', async () => {
  const f = await createComposedFixture(flags);
  try {
    const connections = [client(f.baseURL), client(f.baseURL)];
    const accounts = await Promise.all(connections.map((connection, index) => signup(connection, index + 10)));
    const coupleId = randomUUID();
    const ids = await f.provision(accounts.map(a => a.user.id), coupleId);
    const before = await counts(f);
    for (const status of ['active', 'closed']) {
      await f.domainPool.query('UPDATE couples SET status=$1 WHERE id=$2', [status, coupleId]);
      for (const connection of connections) {
        const result = await post(f, connection); assert.equal(result.status, 409);
        assert.deepEqual(await result.json(), { ok: false, error: 'space_unavailable' });
      }
      assert.deepEqual(await counts(f), before);
      assert.deepEqual((await f.domainPool.query('SELECT user_id FROM couple_members ORDER BY slot')).rows.map(row => row.user_id), ids);
    }
  } finally { await f.close(); }
});

test('malformed waiting membership fails closed, and deleted profiles are never resurrected', async () => {
  const f = await createComposedFixture(flags);
  try {
    const connection = client(f.baseURL); await signup(connection, 20); const own = await profile(f, connection);
    const space = (await (await post(f, connection)).json()).value;
    await f.domainPool.query('UPDATE couple_members SET slot=2 WHERE user_id=$1', [own.userId]);
    assert.equal((await post(f, connection)).status, 409);
    assert.equal((await context(f, connection)).status, 503);
    await f.domainPool.query('UPDATE couple_members SET slot=1 WHERE user_id=$1', [own.userId]);
    const other = randomUUID(); await f.domainPool.query('INSERT INTO users(id) VALUES($1)', [other]);
    await f.domainPool.query("INSERT INTO couple_members VALUES($1,$2,2,'active')", [space.coupleId, other]);
    assert.equal((await post(f, connection)).status, 409);
    assert.equal((await context(f, connection)).status, 503);
    await f.domainPool.query('UPDATE users SET deleted_at=clock_timestamp() WHERE id=$1', [own.userId]);
    const before = await counts(f); const result = await post(f, connection);
    assert.equal(result.status, 409); assert.deepEqual(await result.json(), { ok: false, error: 'profile_unavailable' });
    assert.equal((await context(f, connection)).status, 401);
    assert.deepEqual(await counts(f), before);
    const fresh = client(f.baseURL); await signup(fresh, 21); const freshProfile = await profile(f, fresh);
    await f.domainPool.query('UPDATE users SET deleted_at=clock_timestamp() WHERE id=$1', [freshProfile.userId]);
    const beforeDeletedCreate = await counts(f);
    assert.equal((await post(f, fresh)).status, 409);
    assert.deepEqual(await counts(f), beforeDeletedCreate);
  } finally { await f.close(); }
});

test('failed member insert rolls back its waiting couple and retry creates exactly one complete space', async () => {
  const f = await createComposedFixture(flags);
  try {
    const connection = client(f.baseURL); await signup(connection, 30); await profile(f, connection);
    await f.domainPool.query(`CREATE FUNCTION reject_waiting_member() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic private SQL failure'; END; $$;
      CREATE TRIGGER reject_waiting_member BEFORE INSERT ON couple_members FOR EACH ROW EXECUTE FUNCTION reject_waiting_member()`);
    const result = await post(f, connection);
    assert.equal(result.status, 503); assert.deepEqual(await result.json(), { ok: false, error: 'temporarily_unavailable' });
    assert.deepEqual(await counts(f), { ...emptyCounts, users: 1, mappings: 1 });
    await f.domainPool.query('DROP TRIGGER reject_waiting_member ON couple_members');
    assert.equal((await post(f, connection)).status, 201); assert.equal((await post(f, connection)).status, 200);
    assert.deepEqual(await counts(f), { ...emptyCounts, users: 1, mappings: 1, couples: 1, members: 1 });
  } finally { await f.close(); }
});
