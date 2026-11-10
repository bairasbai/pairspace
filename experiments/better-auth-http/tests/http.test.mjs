import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAuthClient } from 'better-auth/client';
import { createFixture } from '../src/server.mjs';

// Node test cookie jar is a transport fixture, NOT a SecureStore implementation.
function client(baseURL) {
  const jar = new Map();
  async function transport(input, init) {
    const request = new Request(input, init);
    assert.equal(new URL(request.url).origin, baseURL, 'no requests outside loopback fixture');
    request.headers.set('origin', baseURL);
    if (jar.size) request.headers.set('cookie', [...jar].map(([key, value]) => `${key}=${value}`).join('; '));
    const response = await fetch(request);
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const separator = pair.indexOf('=');
      const key = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (!value || /max-age=0/i.test(cookie)) jar.delete(key);
      else jar.set(key, value);
    }
    return response;
  }
  return {
    auth: createAuthClient({ baseURL, fetchOptions: { customFetchImpl: transport, retry: 0 } }),
    async send(pair, body = { text: 'Synthetic message' }) {
      return transport(`${baseURL}/pairs/${pair}/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
    },
  };
}
const password = 'Synthetic-only-password-712!';
async function signup(client, email) {
  const result = await client.auth.signUp.email({ email, password, name: 'Synthetic User' });
  assert.equal(result.error, null);
  return result.data;
}
function gate() {
  let release;
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  return { ready, release: () => release(), hook: async () => { entered(); await waiting; } };
}

test('official client uses real loopback HTTP: signup/login/session, domain mapping, pair isolation, revoke/logout', async () => {
  const fixture = await createFixture();
  try {
    const alice = client(fixture.baseURL);
    const alice2 = client(fixture.baseURL);
    const bob = client(fixture.baseURL);
    const anonymous = client(fixture.baseURL);
    const a = await signup(alice, 'alice@example.test');
    const b = await signup(bob, 'bob@example.test');
    const domainA = fixture.provision(a.user.id, 'pair-a');
    fixture.provision(b.user.id, 'pair-b');
    assert.equal((await alice.auth.getSession()).data.user.id, a.user.id);
    assert.equal((await anonymous.send('pair-a')).status, 401);
    assert.equal((await bob.send('pair-a')).status, 403);
    assert.equal((await alice.send('pair-b')).status, 403);
    assert.equal((await alice.send('pair-a', { text: 'Synthetic', userId: b.user.id })).status, 400);
    assert.equal((await alice.send('pair-a')).status, 201);
    assert.equal(fixture.db.prepare('SELECT sender_id FROM messages').get().sender_id, domainA);
    const wrong = await alice2.auth.signIn.email({ email: a.user.email, password: 'wrong-password' });
    assert.equal(wrong.error.status, 401);
    const signin = await alice2.auth.signIn.email({ email: a.user.email, password });
    assert.equal(signin.error, null);
    assert.equal((await alice2.send('pair-a')).status, 201);
    assert.equal((await alice.auth.revokeSession({ token: signin.data.token })).error, null);
    assert.equal((await alice2.auth.getSession()).data, null);
    assert.equal((await alice2.send('pair-a')).status, 401);
    assert.equal((await alice.auth.signOut()).error, null);
    assert.equal((await alice.send('pair-a')).status, 401);
    assert.equal(fixture.db.prepare('SELECT count(*) n FROM messages').get().n, 2);
  } finally { await fixture.close(); }
});

test('revocation completed after initial resolution but before transaction blocks domain write', async () => {
  const barrier = gate();
  const fixture = await createFixture({ beforeTransaction: barrier.hook });
  try {
    const first = client(fixture.baseURL);
    const second = client(fixture.baseURL);
    const a = await signup(first, 'race@example.test');
    fixture.provision(a.user.id, 'pair-a');
    const login = await second.auth.signIn.email({ email: a.user.email, password });
    const pending = second.send('pair-a');
    await barrier.ready;
    assert.equal((await first.auth.revokeSession({ token: login.data.token })).error, null);
    barrier.release();
    assert.equal((await pending).status, 401);
    assert.equal(fixture.db.prepare('SELECT count(*) n FROM messages').get().n, 0);
  } finally { barrier.release(); await fixture.close(); }
});

test('membership removal or expiry before transaction blocks already-resolved principal', async () => {
  for (const mutation of ['membership', 'expiry', 'future-created', 'malformed-expiry']) {
    const barrier = gate();
    const fixture = await createFixture({ beforeTransaction: barrier.hook });
    try {
      const alice = client(fixture.baseURL);
      const a = await signup(alice, 'mutation@example.test');
      fixture.provision(a.user.id, 'pair-a');
      const pending = alice.send('pair-a');
      await barrier.ready;
      if (mutation === 'membership') {
        fixture.db.exec('UPDATE memberships SET active = 0; UPDATE couples SET epoch = epoch + 1');
      } else if (mutation === 'expiry') {
        fixture.db.prepare('UPDATE session SET expiresAt = ?').run(new Date(Date.now() - 60000).toISOString());
      } else if (mutation === 'future-created') {
        fixture.db.prepare('UPDATE session SET createdAt = ?').run(new Date(Date.now() + 60000).toISOString());
      } else fixture.db.prepare('UPDATE session SET expiresAt = ?').run('invalid-timestamp');
      barrier.release();
      assert.equal((await pending).status, mutation === 'membership' ? 403 : 401);
      assert.equal(fixture.db.prepare('SELECT count(*) n FROM messages').get().n, 0);
    } finally { barrier.release(); await fixture.close(); }
  }
});

test('untrusted origin and SQL failure cannot produce successful domain writes', async () => {
  const fixture = await createFixture();
  try {
    const alice = client(fixture.baseURL);
    const a = await signup(alice, 'errors@example.test');
    fixture.provision(a.user.id, 'pair-a');
    const untrusted = await fetch(`${fixture.baseURL}/pairs/pair-a/messages`, {
      method: 'POST', headers: { origin: 'https://attacker.invalid', 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Synthetic' }),
    });
    assert.equal(untrusted.status, 403);
    fixture.db.exec(`CREATE TRIGGER reject_insert BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;`);
    const failed = await alice.send('pair-a');
    assert.equal(failed.status, 500);
    assert.deepEqual(await failed.json(), { error: 'internal_error' });
    assert.equal(fixture.db.prepare('SELECT count(*) n FROM messages').get().n, 0);
    fixture.db.exec('DROP TRIGGER reject_insert');
    assert.equal((await alice.send('pair-a')).status, 201, 'rollback leaves database usable');
  } finally { await fixture.close(); }
});
