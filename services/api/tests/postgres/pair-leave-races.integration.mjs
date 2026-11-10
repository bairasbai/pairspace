import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { test } from 'node:test';
import { leaveFixture, leaveHarness, assertClosed, pairState } from './pair-leave-fixture.mjs';
import { gate, waitForQueryLock } from './profile-fixture.mjs';
import { observedDatabase } from './invitation-fixture.mjs';
import { observeTask, barrierOrCompletion, settleBounded } from './async-bounds.mjs';
import { sendMessage, readHistory, closeCouple } from '../../src/chat.ts';
import { openLetter } from '../../src/letters.ts';

for (const firstOperation of ['leave', 'send', 'read']) {
  test(`pair leave PostgreSQL serialization: ${firstOperation} obtains locks first; competing operation cannot cross closure`, async () => {
    const x = await leaveFixture(); const { f, pairA } = x; const barrier = gate();
    const tasks = []; let server; let held = false;
    try {
      const observer = async sql => {
        if (!held && sql.includes('FROM couples') && /FOR (UPDATE|SHARE)/.test(sql)) { held = true; await barrier.hook(); }
      };
      const db = f.database();
      const traced = { ...db, transaction: work => db.transaction(tx => work({ query: async (sql, params) => {
        const result = await tx.query(sql, params); await observer(sql); return result;
      } })) };
      server = await leaveHarness(f, { db: firstOperation === 'leave' ? observedDatabase(f, observer) : undefined });
      const p = await x.principal(0); const partner = await x.principal(1);
      const cmd = x.command(); const chatCommand = { coupleId: pairA, membershipEpoch: 1, clientId: randomUUID(), body: 'Synthetic race' };
      const history = { coupleId: pairA, membershipEpoch: 1, limit: 50 };
      const first = observeTask(firstOperation === 'leave' ? server.request(await x.connections[0].getCookie(), cmd)
        : firstOperation === 'send' ? sendMessage(traced, partner, chatCommand) : readHistory(traced, partner, history)); tasks.push(first);
      await barrierOrCompletion(barrier.ready, first);
      const second = observeTask(firstOperation === 'leave' ? sendMessage(db, partner, chatCommand)
        : server.request(await x.connections[0].getCookie(), cmd)); tasks.push(second);
      await waitForQueryLock(f, '%FROM users%FOR %'); barrier.release();
      const [a, b] = await Promise.all(tasks);
      assert.equal(firstOperation === 'leave' ? a.status : b.status, 200);
      assert.equal(firstOperation === 'leave' ? b.ok : a.ok, firstOperation !== 'leave');
      await assertClosed(f, pairA);
      assert.deepEqual(await sendMessage(db, p, chatCommand), { ok: false, error: 'unavailable' });
      assert.deepEqual(await readHistory(db, partner, history), { ok: false, error: 'unavailable' });
    } finally { barrier.release(); await settleBounded(tasks); await server?.close(); await f.close(); }
  });
}

test('pair leave: both partners concurrently close once with deterministic sorted domain locks', async () => {
  const x = await leaveFixture(); const barrier = gate(); const trace = []; const tasks = []; let server; let held = false;
  try {
    server = await leaveHarness(x.f, { db: observedDatabase(x.f, async (sql, params) => {
      trace.push({ sql, params });
      if (!held && sql.includes('FROM couples') && sql.includes('FOR UPDATE')) { held = true; await barrier.hook(); }
    }) });
    const first = observeTask(server.request(await x.connections[0].getCookie(), x.command())); tasks.push(first);
    await barrierOrCompletion(barrier.ready, first);
    const second = observeTask(server.request(await x.connections[1].getCookie(), x.command())); tasks.push(second);
    await waitForQueryLock(x.f, '%FROM users%FOR UPDATE%'); barrier.release();
    const responses = await Promise.all(tasks); assert.deepEqual(responses.map(r => r.status), [200, 200]);
    await assertClosed(x.f, x.pairA);
    const locks = trace.filter(t => /FOR (SHARE|UPDATE)/.test(t.sql));
    assert.equal(locks[0].sql.includes('FROM users'), true); assert.equal(locks[1].sql.includes('FROM users'), true);
    assert.deepEqual(locks.slice(0, 2).map(t => t.params[0]), [...x.usersA].sort());
  } finally { barrier.release(); await settleBounded(tasks); await server?.close(); await x.f.close(); }
});

for (const operation of ['new leave', 'receipt replay', 'legacy close', 'chat send', 'chat read']) {
  test(`pair leave late expiry: ${operation} rechecks session after blocked pair lock`, async () => {
    const x = await leaveFixture(); let held; let server; const tasks = [];
    try {
      const cmd = x.command(); const p = await x.principal(0); const cookie = await x.connections[0].getCookie();
      if (operation === 'receipt replay') assert.equal((await x.leave(0, cmd)).status, 200);
      const expire = () => x.f.domainPool.query('UPDATE "session" SET "expiresAt"=clock_timestamp()+interval \'2 seconds\' WHERE id=$1', [p.sessionId]);
      server = await leaveHarness(x.f, { afterVerified: expire });
      if (!['new leave', 'receipt replay'].includes(operation)) await expire();
      held = await x.f.domainPool.connect(); await held.query('BEGIN');
      await held.query('SELECT id FROM couples WHERE id=$1 FOR UPDATE', [x.pairA]);
      const scope = { coupleId: x.pairA, membershipEpoch: 1 };
      const pending = observeTask(operation === 'legacy close' ? closeCouple(x.f.database(), p, x.pairA, 1)
        : operation === 'chat send' ? sendMessage(x.f.database(), p, { ...scope, clientId: randomUUID(), body: 'Synthetic late' })
          : operation === 'chat read' ? readHistory(x.f.database(), p, { ...scope, limit: 50 }) : server.request(cookie, cmd)); tasks.push(pending);
      await waitForQueryLock(x.f, '%FROM couples%FOR %');
      await new Promise(resolve => setTimeout(resolve, 2100));
      await held.query('COMMIT'); held.release(); held = null;
      const result = await pending;
      if (['new leave', 'receipt replay'].includes(operation)) assert.equal(result.status, 401);
      else assert.deepEqual(result, { ok: false, error: 'unavailable' });
      assert.equal((await pairState(x.f, x.pairA)).status, operation === 'receipt replay' ? 'closed' : 'active');
    } finally {
      if (held) { await held.query('ROLLBACK'); held.release(); }
      await settleBounded(tasks); await server?.close(); await x.f.close();
    }
  });
}

test('pair leave: scheduled letter remains unreadable even after its release instant following closure', async () => {
  const x = await leaveFixture();
  try {
    const release = new Date(Date.now() + 120000).toISOString();
    const response = await x.send(0, randomUUID(), 'Synthetic sealed closure', x.pairA, 1, { release_at: release, release_timezone: 'UTC' });
    assert.equal(response.status, 201); const letterId = (await response.json()).value.letter.id;
    const recipient = await x.principal(1); assert.equal((await x.leave(0)).status, 200);
    assert.deepEqual(await openLetter({ ...x.f.database(), now: () => new Date(release) }, recipient,
      { coupleId: x.pairA, membershipEpoch: 1, letterId }), { ok: false, error: 'unavailable' });
  } finally { await x.f.close(); }
});


test('pair leave versus invitation acceptance replay cannot resurrect either participant', async () => {
  const x = await leaveFixture(); const barrier = gate(); const tasks = []; let server; let stopped = false;
  try {
    const token = randomBytes(32).toString('base64url');
    await x.f.domainPool.query(`INSERT INTO pair_invites(couple_id,issuer_user_id,command_id,token_hash,
      created_at,expires_at,consumed_at,consumed_by_user_id)
      VALUES($1,$2,$3,$4,clock_timestamp()-interval '1 minute',clock_timestamp()+interval '5 minutes',clock_timestamp(),$5)`,
    [x.pairA, x.usersA[0], randomUUID(), createHash('sha256').update(token).digest('hex'), x.usersA[1]]);
    server = await leaveHarness(x.f, { db: observedDatabase(x.f, async sql => {
      if (!stopped && sql.includes('FROM couples') && sql.includes('FOR UPDATE')) { stopped = true; await barrier.hook(); }
    }) });
    const closing = observeTask(server.request(await x.connections[0].getCookie(), x.command())); tasks.push(closing);
    await barrierOrCompletion(barrier.ready, closing);
    const acceptance = observeTask(x.raw(1, '/v1/pair-invitations/accept', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, accept: true }) })); tasks.push(acceptance);
    await waitForQueryLock(x.f, '%FROM users%FOR UPDATE%'); barrier.release();
    const results = await Promise.all(tasks); assert.deepEqual(results.map(r => r.status), [200, 409]);
    await assertClosed(x.f, x.pairA);
    assert.equal((await x.f.domainPool.query('SELECT count(*)::int n FROM couple_members WHERE couple_id=$1', [x.pairA])).rows[0].n, 2);
  } finally { barrier.release(); await settleBounded(tasks); await server?.close(); await x.f.close(); }
});

test('pair leave: official logout committed while domain lock waits denies mutation under current auth', async () => {
  const x = await leaveFixture(); let blocker; let server; const tasks = [];
  try {
    server = await leaveHarness(x.f);
    blocker = await x.f.domainPool.connect(); await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [[...x.usersA].sort()[0]]);
    const pending = observeTask(server.request(await x.connections[0].getCookie(), x.command())); tasks.push(pending);
    await waitForQueryLock(x.f, '%FROM users%FOR UPDATE%');
    assert.equal((await x.connections[0].auth.signOut()).error, null);
    await blocker.query('COMMIT'); blocker.release(); blocker = null;
    assert.equal((await pending).status, 401);
    assert.deepEqual(await pairState(x.f, x.pairA), { status: 'active', membership_epoch: 1, active: 2, events: 0 });
  } finally {
    if (blocker) { await blocker.query('ROLLBACK'); blocker.release(); }
    await settleBounded(tasks); await server?.close(); await x.f.close();
  }
});
