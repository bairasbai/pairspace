import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createFixture } from './fixture.mjs';
import { observeTask, barrierOrCompletion, settleBounded } from './async-bounds.mjs';
import { gate, signin } from './profile-fixture.mjs';
import { harness, invitationRows, issue, observedDatabase, ownWaiting, request, revoke,
  waitForLock, waitUntilDatabaseTime } from './invitation-fixture.mjs';

async function releaseBlocker(blocker) {
  await blocker.query('COMMIT'); blocker.release();
}
async function cleanup(f, server, tasks, blocker) {
  if (blocker) { try { await blocker.query('ROLLBACK'); } finally { blocker.release(); } }
  try { await settleBounded(tasks); } finally { try { await server?.close(); } finally { await f.close(); } }
}

test('distinct official sessions serialize same and different invitation commands on the domain user', async () => {
  for (const sameCommand of [true, false]) {
    const f = await createFixture(); const barrier = gate();
    let server; let first; let second; let held = false;
    try {
      const db = observedDatabase(f, async sql => {
        if (!held && sql.includes('FROM users') && sql.includes('FOR UPDATE')) {
          held = true; await barrier.hook();
        }
      });
      server = await harness(f, { db });
      const a = await ownWaiting(f, server); const b = await signin(f, a.email);
      assert.notEqual((await f.resolve(a.cookie)).session.id, (await f.resolve(b.cookie)).session.id);
      const commandId = randomUUID(); first = observeTask(issue(server, a.cookie, commandId));
      await barrierOrCompletion(barrier.ready, first);
      second = observeTask(issue(server, b.cookie, sameCommand ? commandId : randomUUID()));
      await waitForLock(f, second, '%FROM users%FOR UPDATE%'); barrier.release();
      const responses = await Promise.all([first, second]);
      assert.deepEqual(responses.map(result => result.status), [201, sameCommand ? 200 : 409]);
      const value = (await responses[0].json()).value;
      const secondPayload = await responses[1].json();
      if (sameCommand) {
        assert.equal(secondPayload.value.state, 'replayed'); assert.equal(secondPayload.value.token, null);
        assert.deepEqual(secondPayload.value.invitation, value.invitation);
      } else assert.deepEqual(secondPayload, { ok: false, error: 'invitation_exists' });
      assert.equal((await invitationRows(f)).length, 1);
      assert.equal((await invitationRows(f))[0].command_id, commandId);
    } finally { barrier.release(); await cleanup(f, server, [first, second]); }
  }
});

test('concurrent targeted revocations acknowledge exactly one mutation and never touch a replacement', async () => {
  const f = await createFixture(); const barrier = gate();
  let server; let first; let second; let armed = false; let held = false;
  try {
    const db = observedDatabase(f, async sql => {
      if (armed && !held && sql.includes('FROM users') && sql.includes('FOR UPDATE')) {
        held = true; await barrier.hook();
      }
    });
    server = await harness(f, { db }); const a = await ownWaiting(f, server); const b = await signin(f, a.email);
    const original = (await (await issue(server, a.cookie, randomUUID())).json()).value.invitation;
    armed = true; first = observeTask(revoke(server, a.cookie, original.id));
    await barrierOrCompletion(barrier.ready, first);
    second = observeTask(revoke(server, b.cookie, original.id));
    await waitForLock(f, second, '%FROM users%FOR UPDATE%'); barrier.release();
    const responses = await Promise.all([first, second]);
    assert.deepEqual(responses.map(response => response.status), [200, 200]);
    assert.deepEqual(await Promise.all(responses.map(async response => (await response.json()).value.revoked)), [true, false]);
    const replacement = await issue(server, b.cookie, randomUUID()); assert.equal(replacement.status, 201);
    const replacementId = (await replacement.json()).value.invitation.id;
    assert.equal((await (await revoke(server, a.cookie, original.id)).json()).value.revoked, false);
    assert.equal((await invitationRows(f)).find(row => row.id === replacementId).revoked_at, null);
  } finally { barrier.release(); await cleanup(f, server, [first, second]); }
});

test('issue versus revoke follows observed lock order: revoke-first permits replacement and issue-first conflicts', async () => {
  for (const revokeFirst of [true, false]) {
    const f = await createFixture(); const barrier = gate();
    let server; let first; let second; let armed = false; let held = false;
    try {
      const db = observedDatabase(f, async sql => {
        if (armed && !held && sql.includes('FROM users') && sql.includes('FOR UPDATE')) {
          held = true; await barrier.hook();
        }
      });
      server = await harness(f, { db }); const a = await ownWaiting(f, server); const b = await signin(f, a.email);
      const original = (await (await issue(server, a.cookie, randomUUID())).json()).value.invitation;
      const commandId = randomUUID(); armed = true;
      first = observeTask(revokeFirst ? revoke(server, a.cookie, original.id) : issue(server, a.cookie, commandId));
      await barrierOrCompletion(barrier.ready, first);
      second = observeTask(revokeFirst ? issue(server, b.cookie, commandId) : revoke(server, b.cookie, original.id));
      await waitForLock(f, second, '%FROM users%FOR UPDATE%'); barrier.release();
      const responses = await Promise.all([first, second]);
      assert.deepEqual(responses.map(response => response.status), revokeFirst ? [200, 201] : [409, 200]);
      const rows = await invitationRows(f);
      assert.equal(rows.length, revokeFirst ? 2 : 1);
      assert.equal(rows.filter(row => row.revoked_at === null && row.consumed_at === null).length, revokeFirst ? 1 : 0);
    } finally { barrier.release(); await cleanup(f, server, [first, second]); }
  }
});

test('official sign-out committed before invitation authority locks denies read, issue and revoke without mutation', async () => {
  for (const method of ['GET', 'POST', 'DELETE']) {
    const f = await createFixture(); let server; let pending; let blocker;
    try {
      server = await harness(f); const a = await ownWaiting(f, server);
      const original = (await (await issue(server, a.cookie, randomUUID())).json()).value.invitation;
      blocker = await f.domainPool.connect(); await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [a.userId]);
      pending = observeTask(request(server, a.cookie, { method,
        body: JSON.stringify(method === 'POST' ? { commandId: randomUUID() } : { inviteId: original.id }) }));
      await waitForLock(f, pending, '%FROM users%FOR UPDATE%');
      assert.equal((await f.call('sign-out', {}, a.cookie)).status, 200);
      await releaseBlocker(blocker); blocker = undefined;
      const result = await pending; assert.equal(result.status, 401);
      assert.deepEqual(await result.json(), { ok: false, error: 'unauthenticated' });
      const rows = await invitationRows(f); assert.equal(rows.length, 1); assert.equal(rows[0].revoked_at, null);
    } finally { await cleanup(f, server, [pending], blocker); }
  }
});

test('issuance and revocation holding authoritative session lock finish before waiting official sign-out', async () => {
  for (const method of ['POST', 'DELETE']) {
    const f = await createFixture(); const barrier = gate();
    let server; let pending; let signout; let armed = false; let held = false;
    try {
      const db = observedDatabase(f, async sql => {
        if (armed && !held && sql.includes('FROM "session"') && sql.includes('FOR SHARE')) {
          held = true; await barrier.hook();
        }
      });
      server = await harness(f, { db }); const a = await ownWaiting(f, server);
      const original = method === 'DELETE' ? (await (await issue(server, a.cookie, randomUUID())).json()).value.invitation : null;
      armed = true;
      pending = observeTask(method === 'POST' ? issue(server, a.cookie, randomUUID()) : revoke(server, a.cookie, original.id));
      await barrierOrCompletion(barrier.ready, pending);
      signout = observeTask(f.call('sign-out', {}, a.cookie));
      await barrierOrCompletion(f.waitForAuthDeleteLock(), signout); barrier.release();
      assert.equal((await pending).status, method === 'POST' ? 201 : 200);
      assert.equal((await signout).status, 200);
      assert.equal((await request(server, a.cookie, { method: 'GET' })).status, 401);
      const rows = await invitationRows(f); assert.equal(rows.length, 1);
      assert.equal(rows[0].revoked_at !== null, method === 'DELETE');
    } finally { barrier.release(); await cleanup(f, server, [pending, signout]); }
  }
});

test('authoritative session expiry during invitation lock waits denies metadata, issuance and revocation', async () => {
  for (const method of ['GET', 'POST', 'DELETE']) {
    const f = await createFixture(); let server; let pending; let blocker; let armed = false; let expiry;
    try {
      server = await harness(f, { getSession: async headers => {
        const resolved = await f.resolve(headers.get('cookie'));
        if (armed) {
          const result = await f.authPool.query(`UPDATE "session" SET "expiresAt"=clock_timestamp()+interval '400 milliseconds'
            WHERE id=$1 RETURNING "expiresAt"::text AS expires_at`, [resolved.session.id]);
          expiry = result.rows[0].expires_at;
        }
        return resolved;
      } });
      const a = await ownWaiting(f, server);
      const original = (await (await issue(server, a.cookie, randomUUID())).json()).value.invitation;
      blocker = await f.domainPool.connect(); await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM pair_invites WHERE id=$1 FOR UPDATE', [original.id]);
      armed = true;
      pending = observeTask(request(server, a.cookie, { method,
        body: JSON.stringify(method === 'POST' ? { commandId: randomUUID() } : { inviteId: original.id }) }));
      await waitForLock(f, pending, '%FROM pair_invites%FOR UPDATE%');
      await waitUntilDatabaseTime(f, expiry);
      await releaseBlocker(blocker); blocker = undefined;
      const result = await pending; assert.equal(result.status, 401);
      assert.deepEqual(await result.json(), { ok: false, error: 'unauthenticated' });
      const rows = await invitationRows(f); assert.equal(rows.length, 1); assert.equal(rows[0].revoked_at, null);
    } finally { await cleanup(f, server, [pending], blocker); }
  }
});

test('couple closure and membership revocation committed during a lock wait cannot mint into stale waiting state', async () => {
  const f = await createFixture(); let server; let pending; let blocker;
  try {
    server = await harness(f); const a = await ownWaiting(f, server);
    blocker = await f.domainPool.connect(); await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM couples WHERE id=$1 FOR UPDATE', [a.coupleId]);
    pending = observeTask(issue(server, a.cookie, randomUUID()));
    await waitForLock(f, pending, '%FROM couples%FOR UPDATE%');
    await blocker.query("UPDATE couples SET status='closed',membership_epoch=2 WHERE id=$1", [a.coupleId]);
    await blocker.query("UPDATE couple_members SET status='revoked' WHERE couple_id=$1", [a.coupleId]);
    await releaseBlocker(blocker); blocker = undefined;
    const result = await pending; assert.equal(result.status, 409);
    assert.deepEqual(await result.json(), { ok: false, error: 'space_unavailable' });
    assert.equal((await invitationRows(f)).length, 0);
  } finally { await cleanup(f, server, [pending], blocker); }
});
