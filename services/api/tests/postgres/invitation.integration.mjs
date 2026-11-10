import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createFixture } from './fixture.mjs';
import { createComposedFixture, client } from './composed-fixture.mjs';
import { counts, password } from './profile-fixture.mjs';
import { assertMetadata, flags, harness, invitationRows, issue, ownWaiting,
  prepareWaiting, request, revoke, signup } from './invitation-fixture.mjs';

const emptyCounts = { users: 0, mappings: 0, couples: 0, members: 0, messages: 0, outbox: 0 };

test('invitation routes are independently default-off and never provision a profile or waiting space', async () => {
  for (const options of [{}, { enableSyntheticProfileProvisioning: true, enableSyntheticWaitingSpaceCreation: true },
    { enableSyntheticPairInvitations: true }]) {
    const f = await createComposedFixture(options);
    try {
      const connection = client(f.baseURL); await signup(connection, 0);
      for (const method of ['GET', 'POST', 'DELETE']) {
        const body = JSON.stringify(method === 'POST' ? { commandId: randomUUID() } : { inviteId: randomUUID() });
        const response = await request(f, connection, { method, body });
        assert.equal(response.status, options.enableSyntheticPairInvitations ? 409 : 404);
        assert.deepEqual(await response.json(), { ok: false,
          error: options.enableSyntheticPairInvitations ? 'profile_unavailable' : 'not_found' });
      }
      assert.deepEqual(await counts(f), emptyCounts);
      assert.equal((await invitationRows(f)).length, 0);
    } finally { await f.close(); }
  }
});

test('official auth to profile to waiting to issue/replay/revoke stores a hash only and never grants chat authority', async () => {
  const f = await createComposedFixture(flags);
  try {
    const connection = client(f.baseURL); const a = await signup(connection, 1);
    const space = await prepareWaiting(f, connection);
    const initial = await request(f, connection, { method: 'GET' });
    assert.deepEqual(await initial.json(), { ok: true, value: { state: 'current', invitation: null } });
    const commandId = randomUUID(); const response = await issue(f, connection, commandId);
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    const { value } = await response.json(); const { invitation, token } = value;
    assert.equal(value.state, 'issued'); assertMetadata(invitation);
    assert.equal(invitation.commandId, commandId); assert.equal(invitation.status, 'pending');
    assert.equal(invitation.revokedAt, null); assert.equal(invitation.consumedAt, null);
    assert.equal(typeof token, 'string'); assert.equal(/^[A-Za-z0-9_-]{43}$/.test(token), true);
    assert.equal(Buffer.from(token, 'base64url').length, 32);
    assert.equal(Date.parse(invitation.expiresAt) - Date.parse(invitation.createdAt), 600000);
    const rows = await invitationRows(f); assert.equal(rows.length, 1);
    assert.equal(rows[0].couple_id, space.coupleId); assert.equal(rows[0].issuer_user_id, space.userId);
    assert.equal(rows[0].token_hash === createHash('sha256').update(token).digest('hex'), true);
    assert.equal(JSON.stringify(rows).includes(token), false, 'raw invitation token must not appear in stored data');
    const columns = (await f.domainPool.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema=$1 AND table_name='pair_invites'`, [f.schema])).rows.map(row => row.column_name);
    assert.equal(columns.some(name => ['token', 'raw_token', 'secret'].includes(name)), false);
    const read = await request(f, connection, { method: 'GET' });
    assert.deepEqual(await read.json(), { ok: true, value: { state: 'current', invitation } });
    const replay = await issue(f, connection, commandId); assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), { ok: true, value: { state: 'replayed', invitation, token: null } });
    const conflict = await issue(f, connection, randomUUID()); assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), { ok: false, error: 'invitation_exists' });
    const relogin = client(f.baseURL);
    assert.equal((await relogin.auth.signIn.email({ email: a.email, password })).error, null);
    const secondSession = await issue(f, relogin, commandId);
    assert.equal(secondSession.status, 200); assert.equal((await secondSession.json()).value.token, null);
    assert.equal((await revoke(f, relogin, invitation.id)).status, 200);
    assert.deepEqual(await (await revoke(f, connection, invitation.id)).json(),
      { ok: true, value: { state: 'revoked', revoked: false } });
    const oldCommand = await issue(f, connection, commandId); assert.equal(oldCommand.status, 200);
    const oldValue = (await oldCommand.json()).value;
    assert.equal(oldValue.token, null); assert.equal(oldValue.invitation.status, 'revoked');
    const replacement = await issue(f, connection, randomUUID()); assert.equal(replacement.status, 201);
    const replacementValue = (await replacement.json()).value;
    assert.equal(replacementValue.token !== token, true, 'replacement must use fresh randomness');
    assert.equal((await invitationRows(f)).length, 2);
    const context = await request(f, connection, { method: 'GET', path: '/v1/session/context' });
    assert.deepEqual((await context.json()).value, { state: 'waiting_partner', sessionId: space.sessionId,
      userId: space.userId, coupleId: space.coupleId, membershipEpoch: 1 });
    assert.equal((await connection.send(space.coupleId, randomUUID())).status, 403);
    assert.equal((await connection.history(space.coupleId)).status, 403);
    assert.deepEqual(await counts(f), { ...emptyCounts, users: 1, mappings: 1, couples: 1, members: 1 });
    assert.equal((await f.domainPool.query('SELECT next_chat_seq::int FROM couples')).rows[0].next_chat_seq, 1);
    for (const path of ['/v1/invites/accept', '/v1/spaces/waiting/invite/accept']) {
      assert.equal((await request(f, connection, { path })).status, 404);
    }
  } finally { await f.close(); }
});

test('lost committed issuance acknowledgement never recovers the secret; metadata, targeted revoke and a fresh command recover safely', async () => {
  const f = await createFixture(); let server;
  try {
    server = await harness(f, { dropFirstCreatedResponse: true });
    const a = await ownWaiting(f, server); const commandId = randomUUID();
    await assert.rejects(issue(server, a.cookie, commandId), /fetch failed/);
    assert.equal((await invitationRows(f)).length, 1);
    const retry = await issue(server, a.cookie, commandId); assert.equal(retry.status, 200);
    const value = (await retry.json()).value;
    assert.equal(value.state, 'replayed'); assert.equal(value.token, null);
    const current = (await (await request(server, a.cookie, { method: 'GET' })).json()).value;
    assert.deepEqual(current, { state: 'current', invitation: value.invitation });
    assert.equal((await revoke(server, a.cookie, value.invitation.id)).status, 200);
    const fresh = await issue(server, a.cookie, randomUUID()); assert.equal(fresh.status, 201);
    const freshId = (await fresh.json()).value.invitation.id;
    assert.deepEqual(await (await revoke(server, a.cookie, value.invitation.id)).json(),
      { ok: true, value: { state: 'revoked', revoked: false } });
    const afterRetry = (await (await request(server, a.cookie, { method: 'GET' })).json()).value;
    assert.equal(afterRetry.invitation.id, freshId); assert.equal(afterRetry.invitation.status, 'pending');
    assert.equal((await invitationRows(f)).filter(row => row.revoked_at === null).length, 1);
  } finally { try { await server?.close(); } finally { await f.close(); } }
});

test('two waiting pairs cannot read or revoke each other, spoof caller IDs, or reuse malformed requests to write', async () => {
  const f = await createComposedFixture(flags);
  try {
    const connections = [client(f.baseURL), client(f.baseURL)]; const spaces = [];
    for (const [index, connection] of connections.entries()) {
      await signup(connection, index + 10); spaces.push(await prepareWaiting(f, connection));
    }
    const commandId = randomUUID(); const invites = [];
    for (const connection of connections) {
      const result = await issue(f, connection, commandId); assert.equal(result.status, 201);
      invites.push((await result.json()).value.invitation);
    }
    assert.notEqual(invites[0].id, invites[1].id);
    for (const [index, connection] of connections.entries()) {
      const other = 1 - index;
      const current = await request(f, connection, { method: 'GET' });
      assert.deepEqual((await current.json()).value.invitation, invites[index]);
      for (const id of [invites[other].id, randomUUID()]) {
        const denied = await revoke(f, connection, id); assert.equal(denied.status, 409);
        assert.deepEqual(await denied.json(), { ok: false, error: 'invitation_unavailable' });
      }
      for (const body of ['[]', 'null', 'true', '1', '{', '', '{}', '{"commandId":"not-a-uuid"}',
        JSON.stringify({ commandId, userId: spaces[other].userId }),
        JSON.stringify({ commandId, coupleId: spaces[other].coupleId }),
        JSON.stringify({ commandId, sessionId: spaces[other].sessionId })]) {
        assert.equal((await request(f, connection, { body })).status, 400);
      }
      for (const body of ['{}', 'null', '{', JSON.stringify({ inviteId: invites[index].id, coupleId: spaces[other].coupleId })]) {
        assert.equal((await request(f, connection, { method: 'DELETE', body })).status, 400);
      }
      for (const method of ['GET', 'POST', 'DELETE']) {
        assert.equal((await request(f, connection, { method, suffix: '?coupleId=' + spaces[other].coupleId })).status, 400);
      }
      for (const method of ['PUT', 'PATCH']) {
        const result = await request(f, connection, { method }); assert.equal(result.status, 405);
        assert.equal(result.headers.get('allow'), 'GET, POST, DELETE');
      }
      const body = JSON.stringify({ commandId });
      assert.equal((await request(f, connection, { body, headers: { 'content-type': 'text/plain' } })).status, 415);
      assert.equal((await request(f, connection, { body: ' '.repeat(65537) })).status, 413);
      assert.equal((await request(f, connection, { body, headers: { cookie: '' } })).status, 401);
      assert.equal((await request(f, connection, { body, headers: { authorization: 'Bearer synthetic-spoof' } })).status, 401);
      assert.equal((await request(f, connection, { body, headers: { origin: 'https://attacker.invalid', 'expo-origin': f.baseURL } })).status, 403);
      assert.equal((await connection.history(spaces[other].coupleId)).status, 403);
    }
    assert.equal((await invitationRows(f)).length, 2);
    assert.equal((await invitationRows(f)).every(row => row.revoked_at === null && row.consumed_at === null), true);
  } finally { await f.close(); }
});

test('active, closed, malformed and deleted-owner spaces fail closed without minting or revoking invitations', async () => {
  const f = await createComposedFixture(flags);
  try {
    const connection = client(f.baseURL); await signup(connection, 20); const own = await prepareWaiting(f, connection);
    const issued = (await (await issue(f, connection, randomUUID())).json()).value.invitation;
    const other = randomUUID(); await f.domainPool.query('INSERT INTO users(id) VALUES($1)', [other]);
    for (const state of ['wrong_slot', 'two_members', 'active', 'closed', 'deleted_user']) {
      if (state === 'wrong_slot') await f.domainPool.query('UPDATE couple_members SET slot=2 WHERE user_id=$1', [own.userId]);
      if (state === 'two_members') {
        await f.domainPool.query('UPDATE couple_members SET slot=1 WHERE user_id=$1', [own.userId]);
        await f.domainPool.query("INSERT INTO couple_members VALUES($1,$2,2,'active')", [own.coupleId, other]);
      }
      if (state === 'active') await f.domainPool.query('UPDATE couples SET status=$1 WHERE id=$2', [state, own.coupleId]);
      if (state === 'closed') await f.domainPool.query("WITH closed AS (UPDATE couples SET status='closed' WHERE id=$1 RETURNING id) UPDATE couple_members SET status='revoked' WHERE couple_id IN (SELECT id FROM closed)", [own.coupleId]);
      if (state === 'deleted_user') await f.domainPool.query('UPDATE users SET deleted_at=clock_timestamp() WHERE id=$1', [own.userId]);
      for (const operation of [() => issue(f, connection, randomUUID()), () => revoke(f, connection, issued.id),
        () => request(f, connection, { method: 'GET' })]) {
        const denied = await operation(); assert.equal(denied.status, 409);
        assert.deepEqual(await denied.json(), { ok: false,
          error: state === 'deleted_user' ? 'profile_unavailable' : 'space_unavailable' });
      }
    }
    const rows = await invitationRows(f); assert.equal(rows.length, 1); assert.equal(rows[0].revoked_at, null);
  } finally { await f.close(); }
});

test('failed replacement INSERT rolls back expired-row revocation and exposes no SQL details', async () => {
  const f = await createComposedFixture(flags);
  try {
    const connection = client(f.baseURL); await signup(connection, 30); await prepareWaiting(f, connection);
    const original = (await (await issue(f, connection, randomUUID())).json()).value.invitation;
    await f.domainPool.query(`UPDATE pair_invites SET created_at=clock_timestamp()-interval '11 minutes',
      expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1`, [original.id]);
    await f.domainPool.query(`CREATE FUNCTION reject_invitation_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic private SQL failure'; END; $$;
      CREATE TRIGGER reject_invitation_insert BEFORE INSERT ON pair_invites FOR EACH ROW EXECUTE FUNCTION reject_invitation_insert()`);
    const commandId = randomUUID(); const result = await issue(f, connection, commandId);
    assert.equal(result.status, 503); assert.deepEqual(await result.json(), { ok: false, error: 'temporarily_unavailable' });
    let rows = await invitationRows(f); assert.equal(rows.length, 1); assert.equal(rows[0].revoked_at, null);
    await f.domainPool.query('DROP TRIGGER reject_invitation_insert ON pair_invites');
    assert.equal((await issue(f, connection, commandId)).status, 201);
    rows = await invitationRows(f); assert.equal(rows.length, 2);
    assert.equal(rows.filter(row => row.revoked_at === null && row.consumed_at === null).length, 1);
    assert.equal(rows.find(row => row.id === original.id).revoked_at !== null, true);
  } finally { await f.close(); }
});
