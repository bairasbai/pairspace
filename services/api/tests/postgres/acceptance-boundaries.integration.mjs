import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createFixture } from './fixture.mjs';
import { observeTask } from './async-bounds.mjs';
import { account } from './profile-fixture.mjs';
import { waitForLock, waitUntilDatabaseTime } from './invitation-fixture.mjs';
import { accept, assertAccepted, cleanup, harness, prepareCase, preview, releaseBlocker, state } from './acceptance-fixture.mjs';

for (const kind of ['invitation', 'session']) {
  test(`${kind} expiry after real couple and invitation lock waits prevents activation using fresh database time`, async () => {
    for (const target of ['couple', 'invitation']) {
      const f = await createFixture(); let server; let pending; let blocker; let expiry; let armed = false;
      try {
        server = await harness(f, { getSession: async headers => {
          const resolved = await f.resolve(headers.get('cookie'));
          if (armed && kind === 'session') {
            expiry = (await f.authPool.query(`UPDATE "session" SET "expiresAt"=clock_timestamp()+interval '400 milliseconds'
              WHERE id=$1 RETURNING "expiresAt"::text AS expires_at`, [resolved.session.id])).rows[0].expires_at;
          }
          return resolved;
        } });
        const { owner, guest, invitation, token } = await prepareCase(f, server);
        assert.equal((await preview(server, guest.cookie, token)).status, 200);
        if (kind === 'invitation') expiry = (await f.domainPool.query(`UPDATE pair_invites
          SET expires_at=clock_timestamp()+interval '400 milliseconds' WHERE id=$1 RETURNING expires_at::text`, [invitation.id])).rows[0].expires_at;
        const before = await state(f);
        blocker = await f.domainPool.connect(); await blocker.query('BEGIN');
        await blocker.query(`SELECT id FROM ${target === 'couple' ? 'couples' : 'pair_invites'} WHERE id=$1 FOR UPDATE`,
          [target === 'couple' ? owner.coupleId : invitation.id]);
        armed = true; pending = observeTask(accept(server, guest.cookie, token));
        await waitForLock(f, pending, target === 'couple' ? '%FROM couples%FOR UPDATE%' : '%FROM pair_invites%FOR UPDATE%');
        await waitUntilDatabaseTime(f, expiry); await releaseBlocker(blocker); blocker = undefined;
        const response = await pending; assert.equal(response.status, kind === 'session' ? 401 : 409);
        assert.deepEqual(await response.json(), { ok: false, error: kind === 'session' ? 'unauthenticated' : 'invitation_unavailable' });
        assert.deepEqual(await state(f), before);
      } finally { await cleanup(f, server, [pending], blocker); }
    }
  });
}

for (const change of ['owner deleted', 'recipient deleted', 'owner provider removed', 'recipient signed out',
  'owner mapping replaced', 'recipient mapping replaced', 'owner membership revoked', 'owner slot changed']) {
  test(`acceptance rechecks ${change} committed during observed lock wait and grants nothing`, async () => {
    const f = await createFixture(); let server; let pending; let blocker;
    try {
      server = await harness(f); const { owner, guest, invitation, token } = await prepareCase(f, server);
      assert.equal((await preview(server, guest.cookie, token)).status, 200);
      const replacement = change === 'owner mapping replaced' ? await account(f, 2) : null;
      const membership = change.startsWith('owner membership') || change === 'owner slot changed';
      const recipientTarget = change.startsWith('recipient');
      blocker = await f.domainPool.connect(); await blocker.query('BEGIN');
      await blocker.query(`SELECT id FROM ${membership ? 'couples' : 'users'} WHERE id=$1 FOR UPDATE`,
        [membership ? owner.coupleId : recipientTarget ? guest.userId : owner.userId]);
      pending = observeTask(accept(server, guest.cookie, token));
      await waitForLock(f, pending, membership ? '%FROM couples%FOR UPDATE%' : '%FROM users%FOR UPDATE%');
      if (change.endsWith('deleted')) await blocker.query('UPDATE users SET deleted_at=clock_timestamp() WHERE id=$1',
        [recipientTarget ? guest.userId : owner.userId]);
      if (change === 'owner provider removed') await f.authPool.query('DELETE FROM "user" WHERE id=$1', [owner.user.id]);
      if (change === 'recipient signed out') assert.equal((await f.call('sign-out', {}, guest.cookie)).status, 200);
      if (change === 'owner mapping replaced') await blocker.query('UPDATE better_auth_identities SET auth_user_id=$1 WHERE user_id=$2',
        [replacement.user.id, owner.userId]);
      if (change === 'recipient mapping replaced') {
        const changed = randomUUID(); await blocker.query('INSERT INTO users(id) VALUES($1)', [changed]);
        await blocker.query('UPDATE better_auth_identities SET user_id=$1 WHERE auth_user_id=$2', [changed, guest.user.id]);
      }
      if (change === 'owner membership revoked') await blocker.query("UPDATE couple_members SET status='revoked' WHERE couple_id=$1", [owner.coupleId]);
      if (change === 'owner slot changed') await blocker.query('UPDATE couple_members SET slot=2 WHERE couple_id=$1', [owner.coupleId]);
      await releaseBlocker(blocker); blocker = undefined;
      const response = await pending; assert.equal(response.status, change === 'recipient signed out' ? 401 : 409);
      assert.deepEqual(await response.json(), { ok: false, error: change === 'recipient signed out' ? 'unauthenticated'
        : recipientTarget ? 'profile_unavailable' : 'invitation_unavailable' });
      const after = await state(f);
      assert.equal(after.invites.find(row => row.id === invitation.id).consumed_at, null);
      assert.equal(after.couples[0].status, 'waiting_partner'); assert.equal(after.couples[0].membership_epoch, 1);
      assert.equal(after.members.length, 1); assert.equal(after.outbox, 0); assert.equal(after.messages, 0);
    } finally { await cleanup(f, server, [pending], blocker); }
  });
}

test('each acceptance write rolls back the entire transaction on PostgreSQL failure and returns only a redacted error', async () => {
  const f = await createFixture(); let server;
  try {
    server = await harness(f); const { owner, guest, invitation, token } = await prepareCase(f, server);
    await f.domainPool.query(`CREATE FUNCTION reject_acceptance_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic private SQL failure'; END; $$`);
    for (const [table, operation] of [['couple_members', 'INSERT'], ['couples', 'UPDATE'], ['pair_invites', 'UPDATE']]) {
      const before = await state(f);
      await f.domainPool.query(`CREATE TRIGGER reject_acceptance_write AFTER ${operation} ON ${table}
        FOR EACH ROW EXECUTE FUNCTION reject_acceptance_write()`);
      const response = await accept(server, guest.cookie, token); assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { ok: false, error: 'temporarily_unavailable' });
      assert.deepEqual(await state(f), before, 'failed write cannot leave a member, activation, epoch change or consumption');
      await f.domainPool.query(`DROP TRIGGER reject_acceptance_write ON ${table}`);
    }
    assert.equal((await accept(server, guest.cookie, token)).status, 200);
    await assertAccepted(f, owner, guest, invitation.id);
  } finally { await cleanup(f, server); }
});
