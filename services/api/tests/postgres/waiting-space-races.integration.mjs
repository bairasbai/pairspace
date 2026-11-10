import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createFixture } from './fixture.mjs';
import { observeTask, barrierOrCompletion, settleBounded } from './async-bounds.mjs';
import { account, signin, database, gate, waitForQueryLock, counts } from './profile-fixture.mjs';
import { harness, mappedAccount, baseCounts } from './waiting-fixture.mjs';

const createdCounts = { ...baseCounts, couples: 1, members: 1 };

test('distinct sessions simultaneously creating a waiting space serialize on the domain user, not session identity', async () => {
  const f = await createFixture(); const barrier = gate();
  let server; let first; let second;
  const traces = [];
  try {
    const a = await account(f); const b = await signin(f, a.email); const userId = await mappedAccount(f, a);
    assert.notEqual((await f.resolve(a.cookie)).session.id, (await f.resolve(b.cookie)).session.id);
    const base = database(f);
    const db = { ...base, transaction: work => {
      const trace = []; traces.push(trace);
      return base.transaction(tx => work({ query: async (sql, params) => {
        trace.push(sql.replace(/\s+/g, ' ').trim());
        const result = await tx.query(sql, params);
        if (traces.length === 1 && sql.includes('FROM users') && sql.includes('FOR UPDATE')) await barrier.hook();
        return result;
      } }));
    } };
    server = await harness(f, { db });
    first = observeTask(server.request(a.cookie));
    await barrierOrCompletion(barrier.ready, first);
    second = observeTask(server.request(b.cookie));
    await waitForQueryLock(f, '%FROM users%FOR UPDATE%');
    barrier.release();
    const results = await Promise.all([first, second]);
    assert.deepEqual(results.map(result => result.status), [201, 200]);
    const values = await Promise.all(results.map(async result => (await result.json()).value));
    assert.equal(values[0].userId, userId); assert.equal(values[1].userId, userId);
    assert.equal(values[0].coupleId, values[1].coupleId);
    assert.notEqual(values[0].sessionId, values[1].sessionId);
    assert.equal(values[0].created, true); assert.equal(values[1].created, false);
    assert.deepEqual(await counts(f), createdCounts);
    assert.equal(traces.length, 2);
    for (const trace of traces) {
      assert.match(trace[1], /FROM users.*FOR UPDATE/);
      assert.match(trace[2], /FROM "user".*FOR SHARE/);
      assert.match(trace[3], /FROM "session".*FOR SHARE/);
      assert.match(trace[5], /FROM better_auth_identities.*FOR SHARE/);
    }
    assert.equal(traces[1].some(sql => sql.includes('INSERT')), false);
  } finally {
    barrier.release();
    try { await settleBounded([first, second]); } finally { try { await server?.close(); } finally { await f.close(); } }
  }
});

test('a real lost HTTP acknowledgement after COMMIT retries idempotently with no orphan or duplicate waiting space', async () => {
  const f = await createFixture(); let server;
  try {
    const a = await account(f); const userId = await mappedAccount(f, a);
    server = await harness(f, { dropFirstCreatedResponse: true });
    await assert.rejects(server.request(a.cookie), /fetch failed/);
    assert.deepEqual(await counts(f), createdCounts);
    const coupleId = (await f.domainPool.query('SELECT couple_id FROM couple_members WHERE user_id=$1', [userId])).rows[0].couple_id;
    const result = await server.request(a.cookie); assert.equal(result.status, 200);
    assert.deepEqual((await result.json()).value, { sessionId: (await f.resolve(a.cookie)).session.id,
      userId, coupleId, membershipEpoch: 1, created: false });
    assert.deepEqual(await counts(f), createdCounts);
  } finally { try { await server?.close(); } finally { await f.close(); } }
});

test('official revocation completed while creation waits for its domain-user lock prevents both inserts', async () => {
  const f = await createFixture(); let server; let pending; let blocker;
  try {
    const a = await account(f); const userId = await mappedAccount(f, a);
    server = await harness(f);
    blocker = await f.domainPool.connect(); await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
    pending = observeTask(server.request(a.cookie));
    await waitForQueryLock(f, '%FROM users%FOR UPDATE%');
    assert.equal((await f.call('sign-out', {}, a.cookie)).status, 200);
    await blocker.query('COMMIT'); blocker.release(); blocker = undefined;
    const result = await pending; assert.equal(result.status, 401);
    assert.deepEqual(await result.json(), { ok: false, error: 'unauthenticated' });
    assert.deepEqual(await counts(f), baseCounts);
  } finally {
    if (blocker) { try { await blocker.query('ROLLBACK'); } finally { blocker.release(); } }
    try { await settleBounded([pending]); } finally { try { await server?.close(); } finally { await f.close(); } }
  }
});

test('creation holds authoritative session lock before official revocation; revoked retry cannot create again', async () => {
  const f = await createFixture(); const barrier = gate();
  let server; let pending; let revoke;
  try {
    const a = await account(f); await mappedAccount(f, a); const base = database(f);
    const db = { ...base, transaction: work => base.transaction(tx => work({ query: async (sql, params) => {
      const result = await tx.query(sql, params);
      if (sql.includes('FROM "session"')) await barrier.hook();
      return result;
    } })) };
    server = await harness(f, { db });
    pending = observeTask(server.request(a.cookie));
    await barrierOrCompletion(barrier.ready, pending);
    revoke = observeTask(f.call('sign-out', {}, a.cookie));
    await f.waitForAuthDeleteLock(); barrier.release();
    assert.equal((await pending).status, 201); assert.equal((await revoke).status, 200);
    assert.equal((await server.request(a.cookie)).status, 401);
    assert.deepEqual(await counts(f), createdCounts);
  } finally {
    barrier.release();
    try { await settleBounded([pending, revoke]); } finally { try { await server?.close(); } finally { await f.close(); } }
  }
});

test('waiting creation and idempotent retry recheck authoritative expiry after real mapping/couple lock waits', async () => {
  for (const target of ['mapping', 'couple']) {
    const f = await createFixture(); let server; let pending; let blocker;
    try {
      const a = await account(f); const userId = await mappedAccount(f, a); const coupleId = randomUUID();
      if (target === 'couple') {
        await f.domainPool.query("INSERT INTO couples(id,status) VALUES($1,'waiting_partner')", [coupleId]);
        await f.domainPool.query("INSERT INTO couple_members VALUES($1,$2,1,'active')", [coupleId, userId]);
      }
      server = await harness(f, { getSession: async headers => {
        const session = await f.resolve(headers.get('cookie')); assert.ok(session);
        await f.authPool.query(`UPDATE "session" SET "expiresAt"=clock_timestamp()+interval '1 second' WHERE id=$1`, [session.session.id]);
        return session;
      } });
      blocker = await f.domainPool.connect(); await blocker.query('BEGIN');
      if (target === 'mapping') await blocker.query('SELECT user_id FROM better_auth_identities WHERE auth_user_id=$1 FOR UPDATE', [a.user.id]);
      else await blocker.query('SELECT id FROM couples WHERE id=$1 FOR UPDATE', [coupleId]);
      pending = observeTask(server.request(a.cookie));
      await waitForQueryLock(f, target === 'mapping' ? '%FROM better_auth_identities%FOR SHARE%' : '%FROM couples%FOR UPDATE%');
      await new Promise(resolve => setTimeout(resolve, 1100));
      await blocker.query('COMMIT'); blocker.release(); blocker = undefined;
      const result = await pending; assert.equal(result.status, 401);
      assert.deepEqual(await result.json(), { ok: false, error: 'unauthenticated' });
      assert.deepEqual(await counts(f), target === 'mapping' ? baseCounts : createdCounts);
    } finally {
      if (blocker) { try { await blocker.query('ROLLBACK'); } finally { blocker.release(); } }
      try { await settleBounded([pending]); } finally { try { await server?.close(); } finally { await f.close(); } }
    }
  }
});

test('observed mapping removal or reassignment fails closed without creating a space for either identity', async () => {
  for (const change of ['remove', 'replace']) {
    const f = await createFixture(); let server;
    try {
      const a = await account(f); await mappedAccount(f, a); const other = randomUUID();
      await f.domainPool.query('INSERT INTO users(id) VALUES($1)', [other]); const base = database(f);
      const db = { ...base, transaction: work => base.transaction(tx => work({ query: async (sql, params) => {
        const result = await tx.query(sql, params);
        if (sql.includes('FROM better_auth_identities') && !sql.includes('FOR SHARE')) {
          if (change === 'remove') await f.domainPool.query('DELETE FROM better_auth_identities WHERE auth_user_id=$1', [a.user.id]);
          else await f.domainPool.query('UPDATE better_auth_identities SET user_id=$1 WHERE auth_user_id=$2', [other, a.user.id]);
        }
        return result;
      } })) };
      server = await harness(f, { db }); const result = await server.request(a.cookie);
      assert.equal(result.status, 409); assert.deepEqual(await result.json(), { ok: false, error: 'profile_unavailable' });
      assert.deepEqual((await f.domainPool.query('SELECT user_id FROM better_auth_identities')).rows,
        change === 'remove' ? [] : [{ user_id: other }]);
      assert.deepEqual(await counts(f), { ...baseCounts, users: 2, mappings: change === 'remove' ? 0 : 1 });
    } finally { try { await server?.close(); } finally { await f.close(); } }
  }
});

test('domain deletion and waiting membership revocation during lock waits do not resurrect or replace state', async () => {
  for (const target of ['user', 'couple']) {
    const f = await createFixture(); let server; let pending; let blocker;
    try {
      const a = await account(f); const userId = await mappedAccount(f, a); const coupleId = randomUUID();
      if (target === 'couple') {
        await f.domainPool.query("INSERT INTO couples(id,status) VALUES($1,'waiting_partner')", [coupleId]);
        await f.domainPool.query("INSERT INTO couple_members VALUES($1,$2,1,'active')", [coupleId, userId]);
      }
      server = await harness(f); blocker = await f.domainPool.connect(); await blocker.query('BEGIN');
      await blocker.query(`SELECT id FROM ${target === 'user' ? 'users' : 'couples'} WHERE id=$1 FOR UPDATE`, [target === 'user' ? userId : coupleId]);
      pending = observeTask(server.request(a.cookie));
      await waitForQueryLock(f, target === 'user' ? '%FROM users%FOR UPDATE%' : '%FROM couples%FOR UPDATE%');
      if (target === 'user') await blocker.query('UPDATE users SET deleted_at=clock_timestamp() WHERE id=$1', [userId]);
      else {
        await blocker.query("UPDATE couples SET status='closed',membership_epoch=2 WHERE id=$1", [coupleId]);
        await blocker.query("UPDATE couple_members SET status='revoked' WHERE couple_id=$1", [coupleId]);
      }
      await blocker.query('COMMIT'); blocker.release(); blocker = undefined;
      const result = await pending; assert.equal(result.status, 409);
      assert.deepEqual(await result.json(), { ok: false, error: target === 'user' ? 'profile_unavailable' : 'space_unavailable' });
      assert.deepEqual(await counts(f), target === 'user' ? baseCounts : createdCounts);
    } finally {
      if (blocker) { try { await blocker.query('ROLLBACK'); } finally { blocker.release(); } }
      try { await settleBounded([pending]); } finally { try { await server?.close(); } finally { await f.close(); } }
    }
  }
});
