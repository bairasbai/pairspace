import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createFixture } from './fixture.mjs';
import { observeTask, barrierOrCompletion } from './async-bounds.mjs';
import { account, gate, signin } from './profile-fixture.mjs';
import { issue, observedDatabase, ownWaiting, request, revoke, waitForLock } from './invitation-fixture.mjs';
import { accept, assertAccepted, cleanup, harness, prepareCase, recipient, state } from './acceptance-fixture.mjs';

for (const scenario of ['two recipients', 'same recipient sessions', 'same recipient different couples']) {
  test(`serialized acceptance: ${scenario} never grants a third membership or increments epoch twice`, async () => {
    const f = await createFixture(); const barrier = gate();
    let server; let first; let second; let armed = false; let held = false;
    try {
      const db = observedDatabase(f, async sql => {
        if (armed && !held && sql.includes('FROM couples') && sql.includes('FOR UPDATE')) {
          held = true; await barrier.hook();
        }
      });
      server = await harness(f, { db }); const { owner, guest, invitation, token } = await prepareCase(f, server);
      let secondCookie; let secondToken = token; let otherInvite;
      if (scenario === 'two recipients') secondCookie = (await recipient(f, server, 2)).cookie;
      else if (scenario === 'same recipient sessions') secondCookie = (await signin(f, guest.email)).cookie;
      else {
        secondCookie = guest.cookie;
        const other = await ownWaiting(f, server, 2);
        const issued = await issue(server, other.cookie, randomUUID()); assert.equal(issued.status, 201);
        const value = (await issued.json()).value; secondToken = value.token; otherInvite = value.invitation.id;
      }
      armed = true; first = observeTask(accept(server, guest.cookie, token));
      await barrierOrCompletion(barrier.ready, first);
      second = observeTask(accept(server, secondCookie, secondToken));
      await waitForLock(f, second, '%FROM users%FOR UPDATE%'); barrier.release();
      const responses = await Promise.all([first, second]);
      assert.deepEqual(responses.map(response => response.status), [200, scenario === 'same recipient sessions' ? 200 : 409]);
      assert.equal((await responses[0].json()).value.replayed, false);
      if (scenario === 'same recipient sessions') assert.equal((await responses[1].json()).value.replayed, true);
      await assertAccepted(f, owner, guest, invitation.id);
      if (otherInvite) assert.equal((await f.domainPool.query('SELECT consumed_at FROM pair_invites WHERE id=$1', [otherInvite])).rows[0].consumed_at, null);
      assert.equal((await f.domainPool.query("SELECT count(*)::int n FROM couple_members WHERE user_id=$1 AND status='active'", [guest.userId])).rows[0].n, 1);
    } finally { barrier.release(); await cleanup(f, server, [first, second]); }
  });
}

test('accept versus owner revoke follows observed PostgreSQL lock order in both directions', async () => {
  for (const acceptFirst of [true, false]) {
    const f = await createFixture(); const barrier = gate();
    let server; let first; let second; let armed = false; let held = false;
    try {
      const db = observedDatabase(f, async sql => {
        if (armed && !held && sql.includes('FROM couples') && sql.includes('FOR UPDATE')) {
          held = true; await barrier.hook();
        }
      });
      server = await harness(f, { db }); const { owner, guest, invitation, token } = await prepareCase(f, server);
      armed = true;
      first = observeTask(acceptFirst ? accept(server, guest.cookie, token) : revoke(server, owner.cookie, invitation.id));
      await barrierOrCompletion(barrier.ready, first);
      second = observeTask(acceptFirst ? revoke(server, owner.cookie, invitation.id) : accept(server, guest.cookie, token));
      await waitForLock(f, second, '%FROM users%FOR UPDATE%'); barrier.release();
      const responses = await Promise.all([first, second]);
      assert.deepEqual(responses.map(response => response.status), [200, 409]);
      if (acceptFirst) await assertAccepted(f, owner, guest, invitation.id);
      else {
        const after = await state(f);
        assert.equal(after.invites[0].revoked_at !== null, true); assert.equal(after.invites[0].consumed_at, null);
        assert.equal(after.couples[0].status, 'waiting_partner'); assert.equal(after.couples[0].membership_epoch, 1);
        assert.equal(after.members.length, 1);
      }
    } finally { barrier.release(); await cleanup(f, server, [first, second]); }
  }
});

test('both lexical UUID orders lock both domain users before any provider, session, mapping or couple lock', async () => {
  for (const ownerFirst of [true, false]) {
    const f = await createFixture(); let server; let armed = false; const trace = [];
    try {
      const db = observedDatabase(f, async (sql, params) => {
        if (armed) trace.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      });
      server = await harness(f, { db }); const owner = await account(f, 0); const guest = await account(f, 1);
      const low = '10000000-0000-4000-8000-000000000001', high = '90000000-0000-4000-8000-000000000001';
      const ownerId = ownerFirst ? low : high, guestId = ownerFirst ? high : low;
      await f.domainPool.query('INSERT INTO users(id) VALUES($1),($2)', [ownerId, guestId]);
      await f.domainPool.query('INSERT INTO better_auth_identities VALUES($1,$2),($3,$4)', [owner.user.id, ownerId, guest.user.id, guestId]);
      const waiting = await request(server, owner.cookie, { path: '/v1/spaces/waiting' }); assert.equal(waiting.status, 201);
      const own = (await waiting.json()).value;
      const issued = await issue(server, owner.cookie, randomUUID()); assert.equal(issued.status, 201);
      const { invitation, token } = (await issued.json()).value;
      armed = true; assert.equal((await accept(server, guest.cookie, token)).status, 200);
      const locks = trace.filter(item => /FOR (SHARE|UPDATE)/.test(item.sql));
      assert.equal(locks[0].sql.includes('FROM users'), true); assert.equal(locks[1].sql.includes('FROM users'), true);
      assert.deepEqual(locks.slice(0, 2).map(item => item.params[0]), [low, high]);
      assert.equal(locks.slice(2).some(item => item.sql.includes('FROM "session"')), true);
      await assertAccepted(f, own, { userId: guestId }, invitation.id);
    } finally { await cleanup(f, server); }
  }
});

test('opposing invitation choices share UUID lock order and terminate without deadlock or membership bypass', async () => {
  const f = await createFixture(); const barrier = gate();
  let server; let first; let second; let armed = false; let held = false;
  try {
    const db = observedDatabase(f, async sql => {
      if (armed && !held && sql.includes('FROM users') && sql.includes('FOR UPDATE')) {
        held = true; await barrier.hook();
      }
    });
    server = await harness(f, { db }); const a = await ownWaiting(f, server, 0); const b = await ownWaiting(f, server, 1);
    const firstIssue = await issue(server, a.cookie, randomUUID()), secondIssue = await issue(server, b.cookie, randomUUID());
    assert.equal(firstIssue.status, 201); assert.equal(secondIssue.status, 201);
    const tokenA = (await firstIssue.json()).value.token, tokenB = (await secondIssue.json()).value.token;
    const before = await state(f); armed = true;
    first = observeTask(accept(server, a.cookie, tokenB)); await barrierOrCompletion(barrier.ready, first);
    second = observeTask(accept(server, b.cookie, tokenA));
    await waitForLock(f, second, '%FROM users%FOR UPDATE%'); barrier.release();
    assert.deepEqual((await Promise.all([first, second])).map(result => result.status), [409, 409]);
    assert.deepEqual(await state(f), before);
  } finally { barrier.release(); await cleanup(f, server, [first, second]); }
});
