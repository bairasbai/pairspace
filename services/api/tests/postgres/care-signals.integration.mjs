import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createComposedFixture, client } from './composed-fixture.mjs';
import { password } from './profile-fixture.mjs';
import { sendCareSignal, readCareSignal } from '../../src/care-signals.ts';
import { closeCouple } from '../../src/chat.ts';

async function fixture() {
  const f = await createComposedFixture({ enableSyntheticCareSignals: true });
  try {
    const connections = []; const identities = [];
    for (let n = 0; n < 4; n++) {
      const connection = client(f.baseURL);
      const result = await connection.auth.signUp.email({ email: `care-${n}@example.test`, password, name: 'Synthetic' });
      assert.equal(result.error === null, true); connections.push(connection); identities.push(result.data.user.id);
    }
    const pairA = randomUUID(); const pairB = randomUUID();
    const usersA = await f.provision(identities.slice(0, 2), pairA);
    await f.provision(identities.slice(2), pairB);
    async function request(index, pair = pairA, commandId, epoch = 1, extra = {}) {
      const headers = { origin: f.baseURL, cookie: index === null ? '' : await connections[index].getCookie() };
      if (commandId) { headers['content-type'] = 'application/json'; headers['idempotency-key'] = commandId; }
      return fetch(`${f.baseURL}/v1/couples/${pair}/care-signals${commandId ? '' : '?membership_epoch=' + epoch}`, {
        method: commandId ? 'POST' : 'GET', headers,
        ...(commandId ? { body: JSON.stringify({ client_signal_id: commandId, membership_epoch: epoch, ...extra }) } : {}),
      });
    }
    async function principal(index) {
      // Trusted synthetic test fixture reads the same authoritative provider rows.
      const { rows } = await f.domainPool.query(`SELECT s.id, s."userId" AS auth_user_id,
        s."expiresAt" AS expires_at, i.user_id FROM "session" s
        JOIN better_auth_identities i ON i.auth_user_id=s."userId" WHERE s."userId"=$1`, [identities[index]]);
      const row = rows[0];
      assert.ok(row);
      return { source: 'better-auth', userId: row.user_id, authUserId: row.auth_user_id,
        sessionId: row.id, tokenExpiresAt: Math.floor(row.expires_at.getTime() / 1000) };
    }
    return { f, connections, pairA, pairB, usersA, request, principal };
  } catch (error) { await f.close(); throw error; }
}

test('real PostgreSQL: fixed care signal isolation, concurrent replay/cooldown, epoch and revoked authority', async () => {
  const { f, pairA, pairB, request, connections } = await fixture();
  try {
    const id = randomUUID();
    const responses = await Promise.all(Array.from({ length: 12 }, () => request(0, pairA, id)));
    assert.equal(responses.filter(r => r.status === 201).length, 1);
    assert.equal(responses.filter(r => r.status === 200).length, 11);
    const bodies = await Promise.all(responses.map(r => r.json()));
    assert.equal(new Set(bodies.map(b => b.value.signal.id)).size, 1);
    assert.equal((await request(0, pairA, randomUUID())).status, 429);
    assert.equal((await (await request(0)).json()).value.signal, null);
    assert.equal((await (await request(1)).json()).value.signal.kind, 'thinking_of_you');
    assert.equal((await request(null)).status, 401);
    assert.equal((await request(2)).status, 403);
    assert.equal((await request(0, pairB, randomUUID())).status, 403);
    assert.equal((await request(0, pairA, randomUUID(), 1, { sender_id: randomUUID() })).status, 400);
    assert.equal((await request(0, pairA, id, 2)).status, 409);
    await f.domainPool.query('UPDATE care_signals SET created_at=clock_timestamp()-interval \'61 seconds\'');
    const race = await Promise.all(Array.from({ length: 8 }, () => request(0, pairA, randomUUID())));
    assert.equal(race.filter(r => r.status === 201).length, 1);
    assert.equal(race.filter(r => r.status === 429).length, 7);
    await f.domainPool.query('UPDATE couples SET membership_epoch=2 WHERE id=$1', [pairA]);
    assert.equal((await request(0, pairA, id, 2)).status, 409);
    assert.equal((await (await request(1, pairA, undefined, 2)).json()).value.signal, null);
    assert.equal((await f.domainPool.query('SELECT * FROM care_signals')).rows.length, 2);
    assert.equal((await f.domainPool.query("SELECT * FROM outbox_events WHERE type='care.signal_created'")).rows.length, 2);
    assert.equal((await f.domainPool.query('SELECT * FROM care_notification_simulations')).rows.length, 0);
    await connections[0].auth.signOut();
    assert.equal((await request(0, pairA, id, 2)).status, 401);
  } finally { await f.close(); }
});

async function pauseAfterMembers(db) {
  let release; let reached;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { reached = resolve; });
  return { release, entered, db: { ...db, transaction: work => db.transaction(tx => work({
    async query(sql, params) {
      const result = await tx.query(sql, params);
      if (sql.includes('FROM couple_members') && sql.includes('FOR SHARE')) { reached(); await gate; }
      return result;
    },
  })) } };
}
test('real PostgreSQL: member replacement and close serialize against authorized care write', async () => {
  const { f, pairA, principal, usersA } = await fixture();
  const db = f.database(); const p = await principal(0);
  const lock = await pauseAfterMembers(db); const tasks = [];
  let replacement;
  try {
    const sending = sendCareSignal(lock.db, p, { coupleId: pairA, membershipEpoch: 1, clientId: randomUUID() }); tasks.push(sending);
    await lock.entered;
    replacement = await f.domainPool.connect(); await replacement.query('BEGIN');
    let finished = false;
    const replacing = replacement.query("UPDATE couple_members SET status='revoked' WHERE couple_id=$1 AND user_id=$2", [pairA, usersA[1]]).then(() => { finished = true; }); tasks.push(replacing);
    await new Promise(resolve => setTimeout(resolve, 80)); assert.equal(finished, false, 'member row is locked');
    lock.release(); assert.equal((await sending).ok, true); await replacing;
    const newUser = randomUUID();
    await replacement.query('INSERT INTO users(id) VALUES($1)', [newUser]);
    await replacement.query("INSERT INTO couple_members(couple_id,user_id,slot,status) VALUES($1,$2,2,'active')", [pairA, newUser]);
    await replacement.query('COMMIT'); replacement.release(); replacement = null;
    assert.equal((await readCareSignal(db, await principal(1), { coupleId: pairA, membershipEpoch: 1 })).ok, false);
    const oldId = (await f.domainPool.query('SELECT client_signal_id FROM care_signals')).rows[0].client_signal_id;
    assert.deepEqual(await sendCareSignal(db, p, { coupleId: pairA, membershipEpoch: 1, clientId: oldId }), { ok: false, error: 'idempotency_conflict' });
    assert.equal((await closeCouple(db, p, pairA, 1)).ok, true);
    assert.equal((await sendCareSignal(db, p, { coupleId: pairA, membershipEpoch: 1, clientId: randomUUID() })).ok, false);
    assert.equal((await readCareSignal(db, p, { coupleId: pairA, membershipEpoch: 1 })).ok, false);
  } finally { lock.release(); await Promise.allSettled(tasks); if (replacement) { await replacement.query('ROLLBACK'); replacement.release(); } await f.close(); }
});

test('real PostgreSQL: expiry while pair lock is held denies send and replay', async () => {
  const { f, pairA, principal } = await fixture(); const db = f.database(); const p = await principal(0);
  const command = { coupleId: pairA, membershipEpoch: 1, clientId: randomUUID() };
  let held;
  try {
    assert.equal((await sendCareSignal(db, p, command)).ok, true);
    // Expiration is server-owned; let the already verified principal expire during lock wait.
    await f.domainPool.query('UPDATE "session" SET "expiresAt"=clock_timestamp()+interval \'1 second\' WHERE id=$1', [p.sessionId]);
    held = await f.domainPool.connect(); await held.query('BEGIN'); await held.query('SELECT id FROM couples WHERE id=$1 FOR UPDATE', [pairA]);
    const replay = sendCareSignal(db, p, command);
    await new Promise(resolve => setTimeout(resolve, 1200)); await held.query('COMMIT'); held.release(); held = null;
    assert.deepEqual(await replay, { ok: false, error: 'unavailable' });
    assert.equal((await f.domainPool.query('SELECT * FROM care_signals')).rows.length, 1);
  } finally { if (held) { await held.query('ROLLBACK'); held.release(); } await f.close(); }
});


test('real PostgreSQL: a retained command cannot replay into a new pair', async () => {
  const { f, pairA, principal, usersA } = await fixture(); const db = f.database(); const p = await principal(0);
  try {
    const clientId = randomUUID();
    assert.equal((await sendCareSignal(db, p, { coupleId: pairA, membershipEpoch: 1, clientId })).ok, true);
    assert.equal((await closeCouple(db, p, pairA, 1)).ok, true);
    const newPair = randomUUID();
    const connection = await f.domainPool.connect();
    try {
      await connection.query('BEGIN');
      await connection.query("INSERT INTO couples(id,status) VALUES($1,'waiting_partner')", [newPair]);
      for (let n = 0; n < 2; n++) await connection.query("INSERT INTO couple_members(couple_id,user_id,slot,status) VALUES($1,$2,$3,'active')", [newPair, usersA[n], n+1]);
      await connection.query("UPDATE couples SET status='active' WHERE id=$1", [newPair]);
      await connection.query('COMMIT');
    } catch (error) { await connection.query('ROLLBACK'); throw error; } finally { connection.release(); }
    assert.deepEqual(await sendCareSignal(db, p, { coupleId: newPair, membershipEpoch: 1, clientId }), { ok: false, error: 'idempotency_conflict' });
    assert.equal((await f.domainPool.query('SELECT * FROM care_signals')).rows.length, 1);
    assert.equal((await readCareSignal(db, await principal(1), { coupleId: newPair, membershipEpoch: 1 })).value.signal, null);
  } finally { await f.close(); }
});
