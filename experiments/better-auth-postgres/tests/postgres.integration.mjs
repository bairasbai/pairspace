import assert from 'node:assert/strict';
import { test } from 'node:test';
import { observeTask, barrierOrCompletion, settleBounded } from '../src/async-bounds.mjs';
import { createFixture } from '../src/fixture.mjs';
import { writeMessage } from '../src/domain.mjs';

const credentials = { email: 'synthetic@example.test', password: 'Synthetic-only-password-712!', name: 'Synthetic' };
function cookie(response) { return response.headers.getSetCookie().map(value => value.split(';')[0]).join('; '); }
async function loginPair(fixture) {
  const signup = await fixture.call('sign-up/email', credentials);
  assert.equal(signup.status, 200);
  const user = (await signup.json()).user;
  const firstCookie = cookie(signup);
  const login = await fixture.call('sign-in/email', credentials);
  assert.equal(login.status, 200);
  const second = await login.json();
  const secondCookie = cookie(login);
  const domainId = await fixture.provision(user.id, 'pair-a');
  const principal = await fixture.resolve(secondCookie);
  assert.equal(principal.user.id, user.id);
  return { user, domainId, firstCookie, secondCookie, token: second.token, principal };
}
function gate() {
  let release;
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  return { ready, release: () => release(), hook: async () => { entered(); await blocked; } };
}
async function countMessages(fixture) {
  return Number((await fixture.domainPool.query('SELECT count(*) n FROM messages')).rows[0].n);
}

test('official PostgreSQL migrations, auth lifecycle and domain pair isolation', async () => {
  const f = await createFixture();
  try {
    const a = await loginPair(f);
    const bobSignup = await f.call('sign-up/email', { ...credentials, email: 'bob@example.test' });
    assert.equal(bobSignup.status, 200);
    const bob = (await bobSignup.json()).user;
    await f.provision(bob.id, 'pair-b');
    const bobPrincipal = await f.resolve(cookie(bobSignup));
    assert.equal(await writeMessage(f.domainPool, bobPrincipal, 'pair-a', 'Cross-pair'), 403);
    assert.equal(await writeMessage(f.domainPool, { ...a.principal, user: bob }, 'pair-a', 'Wrong owner'), 401);
    assert.equal(await writeMessage(f.domainPool, a.principal, 'pair-a', 'Synthetic'), 201);
    assert.equal(await writeMessage(f.domainPool, a.principal, 'pair-b', 'Synthetic'), 403);
    assert.equal((await f.domainPool.query('SELECT sender_id FROM messages')).rows[0].sender_id, a.domainId);
    const bad = await f.call('sign-in/email', { ...credentials, password: 'wrong-password' });
    assert.equal(bad.status, 401);
    assert.equal((await f.call('sign-out', {}, a.secondCookie)).status, 200);
    assert.equal(await f.resolve(a.secondCookie), null);
    assert.equal(await writeMessage(f.domainPool, a.principal, 'pair-a', 'Stale'), 401);
    assert.equal(await countMessages(f), 1);
  } finally { await f.close(); }
});

test('completed revoke after initial auth resolution blocks transaction with stale principal', async () => {
  const f = await createFixture();
  try {
    const a = await loginPair(f);
    assert.equal((await f.call('revoke-session', { token: a.token }, a.firstCookie)).status, 200);
    assert.equal(await writeMessage(f.domainPool, a.principal, 'pair-a', 'Stale'), 401);
    assert.equal(await countMessages(f), 0);
  } finally { await f.close(); }
});

test('active domain FOR SHARE blocks actual Better Auth revoke DELETE until commit', async () => {
  const f = await createFixture();
  const barrier = gate();
  let write;
  let revoke;
  try {
    const a = await loginPair(f);
    write = observeTask(writeMessage(f.domainPool, a.principal, 'pair-a', 'Authorized before revoke', { afterLocks: barrier.hook }));
    await barrierOrCompletion(barrier.ready, write);
    let revoked = false;
    revoke = observeTask(f.call('revoke-session', { token: a.token }, a.firstCookie).then(response => { revoked = true; return response; }));
    // Assert actual server-side lock wait, not a sleep-based inference.
    await f.waitForAuthDeleteLock();
    assert.equal(revoked, false);
    barrier.release();
    assert.equal(await write, 201);
    assert.equal((await revoke).status, 200);
    assert.equal(await f.resolve(a.secondCookie), null);
    assert.equal(await writeMessage(f.domainPool, a.principal, 'pair-a', 'After revoke'), 401);
    assert.equal(await countMessages(f), 1);
  } finally {
    barrier.release();
    try { await settleBounded([write, revoke]); } finally { await f.close(); }
  }
});

test('revoker locks/deletes first: domain waits and then rejects committed deletion', async () => {
  const f = await createFixture();
  let connection;
  let write;
  try {
    const a = await loginPair(f);
    connection = await f.authPool.connect();
    await connection.query('BEGIN');
    await connection.query('DELETE FROM "session" WHERE id = $1', [a.principal.session.id]);
    write = observeTask(writeMessage(f.domainPool, a.principal, 'pair-a', 'After pending delete'));
    const deadline = Date.now() + 3000;
    let observed = false;
    while (Date.now() < deadline) {
      const { rows } = await f.admin.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
        AND application_name=$1 AND wait_event_type='Lock' AND state='active'`, [`ps-domain-${f.schema}`]);
      if (rows.length) { observed = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(observed, true, 'domain query must be observed waiting on real PostgreSQL row lock');
    await connection.query('COMMIT');
    connection.release(); connection = null;
    assert.equal(await write, 401);
    assert.equal(await countMessages(f), 0);
  } finally {
    if (connection) { await connection.query('ROLLBACK'); connection.release(); }
    try { await settleBounded([write]); } finally { await f.close(); }
  }
});

test('membership removal, expiry and future creation rechecked after prior auth resolution', async () => {
  const f = await createFixture();
  try {
    const a = await loginPair(f);
    await f.domainPool.query('UPDATE memberships SET active=false');
    assert.equal(await writeMessage(f.domainPool, a.principal, 'pair-a', 'Removed'), 403);
    await f.domainPool.query('UPDATE memberships SET active=true');
    await f.authPool.query('UPDATE "session" SET "expiresAt"=clock_timestamp() - interval \'1 minute\' WHERE id=$1', [a.principal.session.id]);
    assert.equal(await writeMessage(f.domainPool, a.principal, 'pair-a', 'Expired'), 401);
    await f.authPool.query('UPDATE "session" SET "expiresAt"=clock_timestamp() + interval \'1 day\', "createdAt"=clock_timestamp() + interval \'1 minute\' WHERE id=$1', [a.principal.session.id]);
    assert.equal(await writeMessage(f.domainPool, a.principal, 'pair-a', 'Future'), 401);
    assert.equal(await countMessages(f), 0);
  } finally { await f.close(); }
});

test('SQL failure rolls back and pool remains usable', async () => {
  const f = await createFixture();
  try {
    const a = await loginPair(f);
    // NOT NULL failure is deliberate; this is not an HTTP/public input handler.
    await assert.rejects(writeMessage(f.domainPool, a.principal, 'pair-a', null));
    assert.equal(await countMessages(f), 0);
    assert.equal(await writeMessage(f.domainPool, a.principal, 'pair-a', 'Recovered'), 201);
  } finally { await f.close(); }
});


test('pre-barrier SQL failure is observed promptly and cleanup does not hang', async () => {
  const f = await createFixture();
  const barrier = gate();
  let write;
  try {
    const a = await loginPair(f);
    await f.domainPool.query('ALTER TABLE "session" RENAME TO session_unavailable');
    write = observeTask(writeMessage(f.domainPool, a.principal, 'pair-a', 'Must fail', { afterLocks: barrier.hook }));
    await assert.rejects(barrierOrCompletion(barrier.ready, write), error => error.code === '42P01');
    assert.equal(await countMessages(f), 0);
  } finally {
    barrier.release();
    try { await settleBounded([write]); } finally { await f.close(); }
  }
});
