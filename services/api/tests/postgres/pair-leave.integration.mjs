import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { test } from 'node:test';
import { leaveFixture, leaveHarness, assertClosed, pairState, pairAgain } from './pair-leave-fixture.mjs';

const jsonPost = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
test('pair leave: current authority, explicit immutable scope, isolation, archive preservation and blocked scheduled bodies', async () => {
  const x = await leaveFixture(); const { f, pairA, pairB, usersA, connections } = x;
  try {
    const cmd = x.command();
    for (const index of [null, 2, 3]) assert.equal((await x.leave(index, cmd)).status, index === null ? 401 : 409);
    assert.equal((await x.leave(0, { ...cmd, coupleId: randomUUID() })).status, 409);
    assert.equal((await x.leave(0, { ...cmd, membershipEpoch: 2 })).status, 409);
    assert.equal((await x.leave(0, { ...cmd, confirm: false })).status, 400);
    const letter = await x.send(0, randomUUID(), 'Synthetic sealed only', pairA, 1,
      { release_at: new Date(Date.now() + 120000).toISOString(), release_timezone: 'UTC' });
    assert.equal(letter.status, 201); const letterId = (await letter.json()).value.letter.id;
    assert.equal((await connections[0].send(pairA, randomUUID())).status, 201);
    // A stray still-valid invite is revoked even though normal issuance only permits waiting pairs.
    const token = 'a'.repeat(43), inviteId = randomUUID();
    await f.domainPool.query(`INSERT INTO pair_invites(id,couple_id,issuer_user_id,command_id,token_hash,created_at,expires_at)
      VALUES($1,$2,$3,$4,$5,clock_timestamp(),clock_timestamp()+interval '5 minutes')`,
    [inviteId, pairA, usersA[0], randomUUID(), createHash('sha256').update(token).digest('hex')]);
    const response = await x.leave(1, cmd); assert.equal(response.status, 200);
    const value = (await response.json()).value;
    assert.deepEqual(Object.keys(value).sort(), ['state','sessionId','userId','coupleId','membershipEpoch','commandId','replayed'].sort());
    assert.equal(value.state, 'closed'); assert.equal(value.userId, usersA[1]); assert.equal(value.membershipEpoch, 1);
    await assertClosed(f, pairA);
    assert.deepEqual(await pairState(f, pairB), { status: 'active', membership_epoch: 1, active: 2, events: 0 });
    for (const index of [0, 1]) {
      assert.equal((await connections[index].history(pairA)).status, 403);
      assert.equal((await connections[index].send(pairA, randomUUID())).status, 403);
      assert.equal((await x.list(index)).status, 403);
      assert.equal((await x.open(index, letterId)).status, 403);
      assert.equal((await x.raw(index, `/v1/couples/${pairA}/care-signals?membership_epoch=1`)).status, 403);
      assert.equal((await x.raw(index, '/v1/spaces/waiting/invite')).status, 409);
      assert.equal((await (await x.raw(index, '/v1/session/context')).json()).value.state, 'no_active_pair');
    }
    assert.equal((await connections[2].send(pairB, randomUUID())).status, 201);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM letters WHERE couple_id=$1', [pairA])).rows[0].n, 1);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM chat_messages WHERE couple_id=$1', [pairA])).rows[0].n, 1);
    assert.ok((await f.domainPool.query('SELECT revoked_at FROM pair_invites WHERE id=$1', [inviteId])).rows[0].revoked_at);
  } finally { await f.close(); }
});

test('pair leave: lost committed acknowledgement and receipt replay cannot follow or mutate a new pair', async () => {
  const x = await leaveFixture(); let server;
  try {
    server = await leaveHarness(x.f, { drop: true }); const cmd = x.command(); const cookie = await x.connections[0].getCookie();
    await assert.rejects(server.request(cookie, cmd)); await assertClosed(x.f, x.pairA);
    const newPair = await pairAgain(x.f, x.usersA);
    const before = await pairState(x.f, newPair);
    const replay = await server.request(cookie, cmd); assert.equal(replay.status, 200);
    assert.deepEqual((await replay.json()).value, { state: 'closed', sessionId: (await x.principal(0)).sessionId,
      userId: x.usersA[0], coupleId: x.pairA, membershipEpoch: 1, commandId: cmd.commandId, replayed: true });
    assert.equal((await x.leave(0, { ...cmd, coupleId: newPair })).status, 409);
    assert.equal((await x.leave(0, { ...cmd, membershipEpoch: 2 })).status, 409);
    assert.equal((await x.leave(2, cmd)).status, 409);
    assert.deepEqual(await pairState(x.f, newPair), before);
    const context = (await (await x.raw(0, '/v1/session/context')).json()).value;
    assert.equal(context.coupleId, newPair); assert.equal(context.state, 'ready');
    await x.connections[0].auth.signOut(); assert.equal((await server.request(cookie, cmd)).status, 401);
    await assertClosed(x.f, x.pairA);
  } finally { await server?.close(); await x.f.close(); }
});

test('pair leave: closed membership invariant is deferred and rejects revival; waiting pair cannot be left', async () => {
  const x = await leaveFixture(); let conn;
  try {
    conn = await x.f.domainPool.connect(); await conn.query('BEGIN');
    await conn.query("UPDATE couples SET status='closed' WHERE id=$1", [x.pairA]);
    await assert.rejects(conn.query('COMMIT'), { code: '23514' }); await conn.query('ROLLBACK');
    assert.equal((await x.leave(0)).status, 200);
    await conn.query('BEGIN');
    await conn.query("UPDATE couple_members SET status='active' WHERE couple_id=$1 AND user_id=$2", [x.pairA, x.usersA[0]]);
    await assert.rejects(conn.query('COMMIT'), { code: '23514' }); await conn.query('ROLLBACK');
    const created = await x.raw(0, '/v1/spaces/waiting', jsonPost({})); assert.equal(created.status, 201);
    const waiting = (await created.json()).value;
    assert.equal((await x.leave(0, x.command(waiting.coupleId, waiting.membershipEpoch))).status, 409);
    assert.equal((await pairState(x.f, waiting.coupleId)).status, 'waiting_partner');
    await assertClosed(x.f, x.pairA);
  } finally { if (conn) { await conn.query('ROLLBACK'); conn.release(); } await x.f.close(); }
});

test('pair leave: each failed write rolls back closure, memberships, event and receipt without exposing SQL', async () => {
  const x = await leaveFixture();
  try {
    const before = await pairState(x.f, x.pairA); const command = x.command();
    await x.f.domainPool.query(`CREATE FUNCTION reject_leave_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic private leave SQL error'; END; $$`);
    for (const [table, operation] of [['couples','UPDATE'], ['couple_members','UPDATE'], ['pair_invites','UPDATE'],
      ['outbox_events','INSERT'], ['pair_leave_commands','INSERT']]) {
      await x.f.domainPool.query(`CREATE TRIGGER reject_leave_write AFTER ${operation} ON ${table}
        FOR EACH STATEMENT EXECUTE FUNCTION reject_leave_write()`);
      const response = await x.leave(0, command); assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { ok: false, error: 'temporarily_unavailable' });
      assert.deepEqual(await pairState(x.f, x.pairA), before);
      assert.equal((await x.f.domainPool.query('SELECT count(*)::int n FROM pair_leave_commands')).rows[0].n, 0);
      await x.f.domainPool.query(`DROP TRIGGER reject_leave_write ON ${table}`);
    }
    assert.equal((await x.leave(0, command)).status, 200); await assertClosed(x.f, x.pairA);
    assert.equal((await x.f.domainPool.query('SELECT count(*)::int n FROM pair_leave_commands')).rows[0].n, 1);
  } finally { await x.f.close(); }
});
