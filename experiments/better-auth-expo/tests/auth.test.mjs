import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { expo } from '@better-auth/expo';

// Disposable memory database, random process-only secret, synthetic users only.
async function fixture() {
  const db = new DatabaseSync(':memory:');
  const options = {
    database: db,
    secret: randomBytes(48).toString('base64url'),
    baseURL: 'http://localhost:3123',
    trustedOrigins: ['pairspace-spike://'],
    emailAndPassword: { enabled: true },
    session: { cookieCache: { enabled: false } },
    plugins: [expo()],
    logger: { level: 'error' },
  };
  await (await getMigrations(options)).runMigrations();
  const auth = betterAuth(options);
  async function call(path, body, cookie, origin = 'http://localhost:3123') {
    const headers = { origin };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (cookie) headers.cookie = cookie;
    return auth.handler(new Request(`http://localhost:3123/api/auth/${path}`, {
      method: body === undefined ? 'GET' : 'POST', headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }));
  }
  return { db, call, auth };
}
function cookies(response) {
  return response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
}
const credentials = { email: 'alice@example.test', password: 'Synthetic-only-password-712!', name: 'Synthetic Alice' };

test('real signup, login, sessions, owner isolation, revoke and signout', async () => {
  const { db, call } = await fixture();
  try {
    assert.equal(await (await call('get-session')).json(), null);
    const signup = await call('sign-up/email', credentials);
    assert.equal(signup.status, 200);
    const first = await signup.json();
    const cookie1 = cookies(signup);
    assert.ok(cookie1.includes('session_token='));
    assert.ok(!('password' in first.user));
    assert.equal((await (await call('get-session', undefined, cookie1)).json()).user.id, first.user.id);
    assert.equal((await call('sign-in/email', { ...credentials, password: 'wrong-password' })).status, 401);
    const login = await call('sign-in/email', credentials);
    assert.equal(login.status, 200);
    const second = await login.json();
    const cookie2 = cookies(login);
    assert.notEqual(first.token, second.token);
    const bob = await call('sign-up/email', { ...credentials, email: 'bob@example.test', name: 'Synthetic Bob' });
    assert.equal(bob.status, 200);
    // A different user cannot revoke Alice's session.
    await call('revoke-session', { token: second.token }, cookies(bob));
    assert.ok(await (await call('get-session', undefined, cookie2)).json());
    const revoked = await call('revoke-session', { token: second.token }, cookie1);
    assert.equal(revoked.status, 200);
    assert.equal(await (await call('get-session', undefined, cookie2)).json(), null);
    assert.ok(await (await call('get-session', undefined, cookie1)).json());
    assert.equal((await call('sign-out', {}, cookie1)).status, 200);
    assert.equal(await (await call('get-session', undefined, cookie1)).json(), null);
    assert.equal(db.prepare('SELECT count(*) AS n FROM session WHERE userId = ?').get(first.user.id).n, 0);
    const stored = db.prepare('SELECT password FROM account WHERE userId = ?').get(first.user.id);
    assert.ok(stored.password && stored.password !== credentials.password);
  } finally { db.close(); }
});

test('forged cookie, expired and database-deleted sessions fail closed; untrusted origin rejected', async () => {
  const { db, call } = await fixture();
  try {
    assert.equal(await (await call('get-session', undefined, 'better-auth.session_token=forged')).json(), null);
    assert.equal((await call('sign-up/email', credentials, undefined, 'https://attacker.invalid')).status, 403);
    const signup = await call('sign-up/email', credentials);
    const cookie = cookies(signup);
    const { token } = await signup.json();
    db.prepare('UPDATE session SET expiresAt = ? WHERE token = ?').run(Date.now() - 60000, token);
    assert.equal(await (await call('get-session', undefined, cookie)).json(), null);
    const login = await call('sign-in/email', credentials);
    const validCookie = cookies(login);
    assert.ok(await (await call('get-session', undefined, validCookie)).json());
    db.exec('DELETE FROM session');
    assert.equal(await (await call('get-session', undefined, validCookie)).json(), null);
  } finally { db.close(); }
});


test('Expo native origin accepted only when trusted, unsafe auth proxy destinations rejected', async () => {
  const { db, auth } = await fixture();
  try {
    async function nativeSignup(origin) {
      return auth.handler(new Request('http://localhost:3123/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'expo-origin': origin },
        body: JSON.stringify(credentials),
      }));
    }
    assert.equal((await nativeSignup('malicious://')).status, 403);
    assert.equal((await nativeSignup('pairspace-spike://')).status, 200);
    for (const destination of ['https://attacker.invalid/?state=fake', 'javascript:alert(1)', 'https://attacker.invalid/#fragment']) {
      const response = await auth.handler(new Request('http://localhost:3123/api/auth/expo-authorization-proxy?authorizationURL=' + encodeURIComponent(destination)));
      assert.equal(response.status, 400);
      assert.equal(response.headers.get('location'), null);
      assert.equal(response.headers.getSetCookie().length, 0);
    }
    const bearer = await auth.handler(new Request('http://localhost:3123/api/auth/get-session', { headers: { authorization: 'Bearer synthetic.jwt.fallback' } }));
    assert.equal(await bearer.json(), null);
  } finally { db.close(); }
});
