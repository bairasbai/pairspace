import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createFixture } from './fixture.mjs';
import { observeTask, barrierOrCompletion, settleBounded } from './async-bounds.mjs';
import { sendMessage, readHistory, closeCouple } from '../../src/chat.ts';
import { createChatHandler } from '../../src/http.ts';

const origin = 'http://localhost:3123';
const password = 'Synthetic-only-password-712!';
const cookie = response => response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
async function account(f, index) {
  const response = await f.call('sign-up/email', { name: 'Synthetic', email: `synthetic-${index}@example.test`, password });
  assert.equal(response.status, 200);
  return { ...(await response.json()), cookie: cookie(response) };
}
async function seed(f) {
  const accounts = await Promise.all([1, 2, 3, 4].map(index => account(f, index)));
  const pairA = randomUUID(); const pairB = randomUUID();
  const idsA = await f.provision(accounts.slice(0, 2).map(a => a.user.id), pairA);
  await f.provision(accounts.slice(2).map(a => a.user.id), pairB);
  const db = f.database();
  const principals = await Promise.all(accounts.map(a => db.sessionAuthority.authenticate(new Request(origin, { headers: { origin, cookie: a.cookie } }))));
  assert.ok(principals.every(Boolean));
  return { accounts, principals, pairA, pairB, idsA, db };
}
const command = coupleId => ({ coupleId, membershipEpoch: 1, clientId: randomUUID(), body: 'Synthetic message' });
const history = coupleId => ({ coupleId, membershipEpoch: 1, limit: 50 });
const denied = { ok: false, error: 'unavailable' };
function gate() {
  let entered; let release;
  const ready = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  return { ready, release: () => release(), hook: async () => { entered(); await blocked; } };
}

test('PRODUCT handler and use cases persist chat/idempotency/history/close/outbox with Better Auth only', async () => {
  const f = await createFixture();
  try {
    const s = await seed(f);
    const input = command(s.pairA);
    const handler = createChatHandler(s.db);
    const request = () => new Request(`${origin}/v1/couples/${s.pairA}/chat/messages`, {
      method: 'POST', headers: { origin, cookie: s.accounts[0].cookie, 'content-type': 'application/json', 'idempotency-key': input.clientId },
      body: JSON.stringify({ client_message_id: input.clientId, membership_epoch: 1, body: input.body, senderId: s.idsA[1] }),
    });
    assert.equal((await handler(request())).status, 201);
    assert.equal((await handler(request())).status, 200);
    assert.equal((await f.domainPool.query('SELECT sender_id FROM chat_messages')).rows[0].sender_id, s.idsA[0]);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM outbox_events')).rows[0].n, 1);
    const page = await readHistory(s.db, s.principals[1], history(s.pairA));
    assert.equal(page.ok, true); assert.equal(page.value.messages.length, 1);
    assert.deepEqual(await readHistory(s.db, s.principals[2], history(s.pairA)), denied);
    assert.deepEqual(await sendMessage(s.db, s.principals[0], command(s.pairB)), denied);
    assert.deepEqual(await closeCouple(s.db, s.principals[1], s.pairA, 1), { ok: true, value: null });
    assert.deepEqual(await sendMessage(s.db, s.principals[0], command(s.pairA)), denied);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM outbox_events')).rows[0].n, 2);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM auth_sessions')).rows[0].n, 0);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM "session"')).rows[0].n, 4);
  } finally { await f.close(); }
});

test('completed official revoke blocks PRODUCT send/history/close with previously verified principal', async () => {
  const f = await createFixture();
  try {
    const s = await seed(f);
    const login = await f.call('sign-in/email', { email: s.accounts[0].user.email, password });
    assert.equal(login.status, 200);
    const token = (await login.json()).token;
    const secondCookie = cookie(login);
    const p = await s.db.sessionAuthority.authenticate(new Request(origin, { headers: { origin, cookie: secondCookie } }));
    assert.ok(p);
    assert.equal((await f.call('revoke-session', { token }, s.accounts[0].cookie)).status, 200);
    assert.deepEqual(await sendMessage(s.db, p, command(s.pairA)), denied);
    assert.deepEqual(await readHistory(s.db, p, history(s.pairA)), denied);
    assert.deepEqual(await closeCouple(s.db, p, s.pairA, 1), denied);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM outbox_events')).rows[0].n, 0);
  } finally { await f.close(); }
});

test('PRODUCT transaction holds authoritative provider session lock while official revocation waits', async () => {
  const f = await createFixture();
  const barrier = gate();
  let write; let revoke;
  try {
    const s = await seed(f);
    const login = await f.call('sign-in/email', { email: s.accounts[0].user.email, password });
    const token = (await login.json()).token;
    const p = await s.db.sessionAuthority.authenticate(new Request(origin, { headers: { origin, cookie: cookie(login) } }));
    assert.ok(p);
    const base = s.db;
    const db = { ...base, transaction: work => base.transaction(tx => work({ query: async (sql, params) => {
      const result = await tx.query(sql, params);
      // Barrier after the authoritative session lock, before product's next query.
      if (sql.includes('FROM "session"')) await barrier.hook();
      return result;
    } })) };
    write = observeTask(sendMessage(db, p, command(s.pairA)));
    await barrierOrCompletion(barrier.ready, write);
    revoke = observeTask(f.call('revoke-session', { token }, s.accounts[0].cookie));
    await f.waitForAuthDeleteLock();
    barrier.release();
    assert.equal((await write).ok, true);
    assert.equal((await revoke).status, 200);
    assert.deepEqual(await sendMessage(base, p, command(s.pairA)), denied);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM outbox_events')).rows[0].n, 1);
  } finally {
    barrier.release();
    try { await settleBounded([write, revoke]); } finally { await f.close(); }
  }
});

test('PRODUCT row expiry, user deletion, identity remap and mixed authority fail closed', async () => {
  const f = await createFixture();
  try {
    const s = await seed(f); const p = s.principals[0];
    await f.authPool.query('UPDATE "session" SET "expiresAt"=clock_timestamp() WHERE id=$1', [p.sessionId]);
    assert.deepEqual(await sendMessage(s.db, p, command(s.pairA)), denied);
    await f.authPool.query('UPDATE "session" SET "expiresAt"=clock_timestamp()+interval \'1 day\' WHERE id=$1', [p.sessionId]);
    await f.domainPool.query('UPDATE users SET deleted_at=clock_timestamp() WHERE id=$1', [p.userId]);
    assert.deepEqual(await readHistory(s.db, p, history(s.pairA)), denied);
    await f.domainPool.query('UPDATE users SET deleted_at=NULL WHERE id=$1', [p.userId]);
    await f.domainPool.query('DELETE FROM better_auth_identities WHERE auth_user_id=$1', [p.authUserId]);
    assert.deepEqual(await closeCouple(s.db, p, s.pairA, 1), denied);
    assert.deepEqual(await sendMessage(s.db, { ...p, source: 'synthetic-jwt', sessionId: randomUUID() }, command(s.pairA)), denied);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM outbox_events')).rows[0].n, 0);
  } finally { await f.close(); }
});

test('PRODUCT outbox failure rolls back message and sequence under Better Auth authority', async () => {
  const f = await createFixture();
  try {
    const s = await seed(f); const input = command(s.pairA);
    await f.domainPool.query('ALTER TABLE outbox_events ADD CONSTRAINT synthetic_reject CHECK(false)');
    await assert.rejects(sendMessage(s.db, s.principals[0], input));
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM chat_messages')).rows[0].n, 0);
    assert.equal((await f.domainPool.query('SELECT next_chat_seq::int n FROM couples WHERE id=$1', [s.pairA])).rows[0].n, 1);
    await f.domainPool.query('ALTER TABLE outbox_events DROP CONSTRAINT synthetic_reject');
    assert.equal((await sendMessage(s.db, s.principals[0], input)).ok, true);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM outbox_events')).rows[0].n, 1);
  } finally { await f.close(); }
});
