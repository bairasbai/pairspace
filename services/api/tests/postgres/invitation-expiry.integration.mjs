import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createFixture } from './fixture.mjs';
import { observeTask, settleBounded } from './async-bounds.mjs';
import { harness, invitationRows, issue, ownWaiting, request, revoke,
  waitForLock, waitUntilDatabaseTime } from './invitation-fixture.mjs';

const syntheticHash = () => createHash('sha256').update(randomUUID()).digest('hex');

test('expired metadata and same-command replay reveal no secret, and only a new command replaces atomically', async () => {
  const f = await createFixture(); let server;
  try {
    server = await harness(f); const a = await ownWaiting(f, server); const commandId = randomUUID();
    const original = (await (await issue(server, a.cookie, commandId)).json()).value.invitation;
    await f.domainPool.query(`UPDATE pair_invites SET created_at=clock_timestamp()-interval '11 minutes',
      expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1`, [original.id]);
    const metadata = (await (await request(server, a.cookie, { method: 'GET' })).json()).value.invitation;
    assert.equal(metadata.status, 'expired'); assert.equal(metadata.id, original.id);
    const replay = await issue(server, a.cookie, commandId); assert.equal(replay.status, 200);
    const replayed = (await replay.json()).value;
    assert.deepEqual(replayed, { state: 'replayed', invitation: metadata, token: null });
    assert.equal((await invitationRows(f))[0].revoked_at, null);
    const replacement = await issue(server, a.cookie, randomUUID()); assert.equal(replacement.status, 201);
    const newMetadata = (await replacement.json()).value.invitation;
    assert.notEqual(newMetadata.id, original.id); assert.equal(newMetadata.status, 'pending');
    const oldReplay = (await (await issue(server, a.cookie, commandId)).json()).value;
    assert.equal(oldReplay.token, null); assert.equal(oldReplay.invitation.status, 'revoked');
    const rows = await invitationRows(f); assert.equal(rows.length, 2);
    assert.equal(rows.filter(row => row.revoked_at === null && row.consumed_at === null).length, 1);
    assert.equal((await (await request(server, a.cookie, { method: 'GET' })).json()).value.invitation.id, newMetadata.id);
  } finally { try { await server?.close(); } finally { await f.close(); } }
});

test('invitation expiry and replacement TTL use the database clock after contended couple and invitation locks', async () => {
  for (const target of ['couple', 'invitation']) {
    const f = await createFixture(); let server; let pending; let blocker;
    try {
      server = await harness(f); const a = await ownWaiting(f, server);
      const original = (await (await issue(server, a.cookie, randomUUID())).json()).value.invitation;
      const expiry = (await f.domainPool.query(`UPDATE pair_invites
        SET expires_at=clock_timestamp()+interval '400 milliseconds' WHERE id=$1 RETURNING expires_at::text`, [original.id])).rows[0].expires_at;
      blocker = await f.domainPool.connect(); await blocker.query('BEGIN');
      await blocker.query(`SELECT id FROM ${target === 'couple' ? 'couples' : 'pair_invites'} WHERE id=$1 FOR UPDATE`,
        [target === 'couple' ? a.coupleId : original.id]);
      pending = observeTask(issue(server, a.cookie, randomUUID()));
      await waitForLock(f, pending, target === 'couple' ? '%FROM couples%FOR UPDATE%' : '%FROM pair_invites%FOR UPDATE%');
      await waitUntilDatabaseTime(f, expiry);
      const releasedAt = (await f.admin.query('SELECT clock_timestamp()::text AS now')).rows[0].now;
      await blocker.query('COMMIT'); blocker.release(); blocker = undefined;
      const result = await pending; assert.equal(result.status, 201);
      const metadata = (await result.json()).value.invitation;
      assert.equal(Date.parse(metadata.createdAt) >= Date.parse(releasedAt), true);
      assert.equal(Date.parse(metadata.expiresAt) - Date.parse(metadata.createdAt), 600000);
      const rows = await invitationRows(f); assert.equal(rows.length, 2);
      const previous = rows.find(row => row.id === original.id);
      assert.equal(previous.revoked_at !== null, true);
      assert.equal(previous.revoked_at.getTime() >= Date.parse(expiry), true);
      assert.equal(rows.filter(row => row.revoked_at === null && row.consumed_at === null).length, 1);
    } finally {
      if (blocker) { try { await blocker.query('ROLLBACK'); } finally { blocker.release(); } }
      try { await settleBounded([pending]); } finally { try { await server?.close(); } finally { await f.close(); } }
    }
  }
});

test('real PostgreSQL constraints reserve one open slot even when expired and reject invalid or duplicate invitation data', async () => {
  const f = await createFixture(); let server;
  try {
    server = await harness(f); const a = await ownWaiting(f, server);
    const commandId = randomUUID(); const original = (await (await issue(server, a.cookie, commandId)).json()).value.invitation;
    const insert = (command = randomUUID(), hash = syntheticHash()) => f.domainPool.query(`INSERT INTO pair_invites
      (couple_id,issuer_user_id,command_id,token_hash,created_at,expires_at)
      VALUES($1,$2,$3,$4,clock_timestamp(),clock_timestamp()+interval '10 minutes')`, [a.coupleId, a.userId, command, hash]);
    await assert.rejects(insert(), error => error.code === '23505' && error.constraint === 'one_current_pair_invite');
    await f.domainPool.query(`UPDATE pair_invites SET created_at=clock_timestamp()-interval '11 minutes',
      expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1`, [original.id]);
    await assert.rejects(insert(), error => error.code === '23505' && error.constraint === 'one_current_pair_invite');
    assert.equal((await revoke(server, a.cookie, original.id)).status, 200);
    await assert.rejects(insert(commandId), error => error.code === '23505');
    await assert.rejects(insert(randomUUID(), 'synthetic-not-a-hash'), error => error.code === '23514');
    await assert.rejects(f.domainPool.query(`UPDATE pair_invites SET expires_at=created_at WHERE id=$1`, [original.id]),
      error => error.code === '23514');
    assert.equal((await invitationRows(f)).length, 1);
    const replacement = await issue(server, a.cookie, randomUUID()); assert.equal(replacement.status, 201);
    assert.equal((await invitationRows(f)).length, 2);
  } finally { try { await server?.close(); } finally { await f.close(); } }
});
