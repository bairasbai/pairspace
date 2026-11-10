import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { client, createComposedFixture } from './composed-fixture.mjs';
import { createFixture } from './fixture.mjs';
import { counts, password, signin } from './profile-fixture.mjs';
import { flags, issue, prepareWaiting, request, signup } from './invitation-fixture.mjs';
import { accept, acceptPath, acceptanceFlags, assertAccepted, cleanup, harness,
  prepareCase, preview, previewPath, recipient, state } from './acceptance-fixture.mjs';

async function provision(f, connection) {
  const response = await request(f, connection, { path: '/v1/profile' });
  assert.equal(response.status, 201); return (await response.json()).value;
}
const context = async (f, connection) => (await (await request(f, connection,
  { method: 'GET', path: '/v1/session/context' })).json()).value;

// This path uses the actual composition, official Better Auth client and HTTP product chat.
test('official signup → explicit profiles → waiting → preview → accept → epoch-2 contexts and real chat', async () => {
  const f = await createComposedFixture(acceptanceFlags);
  try {
    const owner = client(f.baseURL), guest = client(f.baseURL), outsider = client(f.baseURL);
    await signup(owner, 100); const guestAccount = await signup(guest, 101); await signup(outsider, 102);
    const own = await prepareWaiting(f, owner); const guestProfile = await provision(f, guest);
    await provision(f, outsider);
    const issued = await issue(f, owner, randomUUID()); assert.equal(issued.status, 201);
    const { invitation, token } = (await issued.json()).value;
    const before = await state(f); const beforeCounts = await counts(f);
    for (const connection of [guest, outsider, guest]) {
      const response = await preview(f, connection, token); assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.deepEqual(await response.json(), { ok: true, value: { state: 'available', expiresAt: invitation.expiresAt } });
    }
    assert.deepEqual(await state(f), before, 'preview must not reserve, consume or mutate anything');
    assert.deepEqual(await counts(f), beforeCounts);
    assert.equal((await guest.history(own.coupleId)).status, 403);
    const accepted = await accept(f, guest, token); assert.equal(accepted.status, 200);
    const value = (await accepted.json()).value;
    assert.deepEqual(value, { state: 'accepted', sessionId: guestProfile.sessionId, userId: guestProfile.userId,
      coupleId: own.coupleId, membershipEpoch: 2, replayed: false });
    await assertAccepted(f, own, guestProfile, invitation.id);
    assert.deepEqual(await context(f, owner), { state: 'ready', sessionId: own.sessionId,
      userId: own.userId, coupleId: own.coupleId, membershipEpoch: 2 });
    assert.deepEqual(await context(f, guest), { state: 'ready', sessionId: guestProfile.sessionId,
      userId: guestProfile.userId, coupleId: own.coupleId, membershipEpoch: 2 });
    const staleSend = await owner.send(own.coupleId, randomUUID());
    assert.equal(staleSend.status, 409, 'epoch 1 cannot survive activation');
    assert.deepEqual(await staleSend.json(), { ok: false, error: 'stale_membership' });
    const staleHistory = await guest.history(own.coupleId); assert.equal(staleHistory.status, 409);
    assert.deepEqual(await staleHistory.json(), { ok: false, error: 'stale_membership' });
    const messageId = randomUUID();
    const sent = await request(f, owner, { path: `/v1/couples/${own.coupleId}/chat/messages`,
      headers: { 'idempotency-key': messageId }, body: JSON.stringify({ client_message_id: messageId,
        membership_epoch: 2, body: 'Synthetic accepted-pair message' }) });
    assert.equal(sent.status, 201);
    const history = await request(f, guest, { method: 'GET', path: `/v1/couples/${own.coupleId}/chat/messages`,
      suffix: '?membership_epoch=2&limit=50' });
    assert.equal(history.status, 200); assert.equal((await history.json()).value.messages[0].senderId, own.userId);
    assert.equal((await request(f, outsider, { method: 'GET', path: `/v1/couples/${own.coupleId}/chat/messages`,
      suffix: '?membership_epoch=2&limit=50' })).status, 403);
    assert.equal((await request(f, guest, { method: 'GET', path: `/v1/couples/${randomUUID()}/chat/messages`,
      suffix: '?membership_epoch=2&limit=50' })).status, 403);
    const replay = await accept(f, guest, token); assert.equal(replay.status, 200);
    assert.equal((await replay.json()).value.replayed, true);
    assert.equal((await accept(f, outsider, token)).status, 409);
    assert.equal((await preview(f, outsider, token)).status, 409);
    const another = client(f.baseURL);
    assert.equal((await another.auth.signIn.email({ email: guestAccount.email, password })).error, null);
    const alternate = (await (await accept(f, another, token)).json()).value;
    assert.equal(alternate.replayed, true); assert.notEqual(alternate.sessionId, guestProfile.sessionId);
    assert.equal(alternate.userId, guestProfile.userId); assert.equal(alternate.membershipEpoch, 2);
    assert.equal((await counts(f)).members, 2); assert.equal((await counts(f)).outbox, 1, 'only the chat creates an outbox event');
  } finally { await f.close(); }
});

test('acceptance is independently disabled and strict JSON-only HTTP rejects spoofing without consuming', async () => {
  const disabled = await createComposedFixture(flags);
  try {
    for (const path of [previewPath, acceptPath]) assert.equal((await request(disabled, '', { path })).status, 404);
  } finally { await disabled.close(); }
  const f = await createComposedFixture(acceptanceFlags);
  try {
    const owner = client(f.baseURL), guest = client(f.baseURL);
    await signup(owner, 110); await signup(guest, 111); await prepareWaiting(f, owner); await provision(f, guest);
    const issued = await issue(f, owner, randomUUID()); assert.equal(issued.status, 201);
    const { token } = (await issued.json()).value; const before = await state(f);
    const noncanonical = `${'A'.repeat(42)}B`;
    for (const path of [previewPath, acceptPath]) {
      const valid = path === previewPath ? { token } : { token, accept: true };
      for (const body of ['{}', 'null', '[]', '{', JSON.stringify({ ...valid, userId: randomUUID() }),
        JSON.stringify({ ...valid, coupleId: randomUUID() }), JSON.stringify({ ...valid, membershipEpoch: 2 }),
        ...['', 'x', token + '=', token + ' ', noncanonical].map(value => JSON.stringify({ ...valid, token: value }))]) {
        assert.equal((await request(f, guest, { path, body })).status, 400);
      }
      for (const method of ['GET', 'PUT', 'DELETE']) {
        const response = await request(f, guest, { path, method }); assert.equal(response.status, 405);
        assert.equal(response.headers.get('allow'), 'POST');
      }
      const body = JSON.stringify(valid);
      assert.equal((await request(f, guest, { path, body, suffix: '?token=synthetic-disallowed-query' })).status, 400);
      assert.equal((await request(f, guest, { path, body, headers: { 'content-type': 'text/plain' } })).status, 415);
      assert.equal((await request(f, guest, { path, body: ' '.repeat(65537) })).status, 413);
      assert.equal((await request(f, guest, { path, body, headers: { cookie: '' } })).status, 401);
      assert.equal((await request(f, guest, { path, body, headers: { authorization: 'Bearer synthetic-spoof' } })).status, 401);
      assert.equal((await request(f, guest, { path, body, headers: { origin: 'https://attacker.invalid', 'expo-origin': f.baseURL } })).status, 403);
    }
    for (const body of [{ token }, { token, accept: false }, { token, accept: 'true' }]) {
      assert.equal((await request(f, guest, { path: acceptPath, body: JSON.stringify(body) })).status, 400);
    }
    const unknown = randomBytes(32).toString('base64url');
    for (const operation of [preview, accept]) assert.equal((await operation(f, guest, unknown)).status, 409);
    assert.deepEqual(await state(f), before);
  } finally { await f.close(); }
});

test('self-join, an own waiting space or an active pair cannot grant another membership', async () => {
  const f = await createFixture(); let server;
  try {
    server = await harness(f); const { owner, guest, invitation, token } = await prepareCase(f, server);
    for (const operation of [preview, accept]) assert.equal((await operation(server, owner.cookie, token)).status, 409);
    const ownGuest = await request(server, guest.cookie, { path: '/v1/spaces/waiting' }); assert.equal(ownGuest.status, 201);
    for (const operation of [preview, accept]) assert.equal((await operation(server, guest.cookie, token)).status, 409);
    const guestSpace = (await ownGuest.json()).value; const partner = await recipient(f, server, 2);
    await f.domainPool.query("INSERT INTO couple_members VALUES($1,$2,2,'active')", [guestSpace.coupleId, partner.userId]);
    await f.domainPool.query("UPDATE couples SET status='active' WHERE id=$1", [guestSpace.coupleId]);
    for (const operation of [preview, accept]) assert.equal((await operation(server, guest.cookie, token)).status, 409);
    const unchanged = (await f.domainPool.query('SELECT consumed_at FROM pair_invites WHERE id=$1', [invitation.id])).rows[0];
    assert.equal(unchanged.consumed_at, null); assert.equal((await counts(f)).members, 3);
  } finally { await cleanup(f, server); }
});

test('lost accepted HTTP acknowledgement and expired consumed token replay are idempotent, but closed/deleted pairs never resurrect', async () => {
  const f = await createFixture(); let server;
  try {
    server = await harness(f, { dropFirstAcceptedResponse: true });
    const { owner, guest, invitation, token } = await prepareCase(f, server);
    await assert.rejects(accept(server, guest.cookie, token), /fetch failed/);
    await assertAccepted(f, owner, guest, invitation.id);
    const alternate = await signin(f, guest.email);
    const replay = await accept(server, alternate.cookie, token); assert.equal(replay.status, 200);
    assert.equal((await replay.json()).value.replayed, true);
    await f.domainPool.query(`UPDATE pair_invites SET created_at=clock_timestamp()-interval '20 minutes',
      consumed_at=clock_timestamp()-interval '15 minutes',expires_at=clock_timestamp()-interval '10 minutes' WHERE id=$1`, [invitation.id]);
    const expiredReplay = await accept(server, guest.cookie, token); assert.equal(expiredReplay.status, 200);
    assert.equal((await expiredReplay.json()).value.replayed, true);
    await f.domainPool.query('UPDATE users SET deleted_at=clock_timestamp() WHERE id=$1', [owner.userId]);
    assert.equal((await accept(server, guest.cookie, token)).status, 409);
    await f.domainPool.query('UPDATE users SET deleted_at=NULL WHERE id=$1', [owner.userId]);
    await f.domainPool.query('UPDATE users SET deleted_at=clock_timestamp() WHERE id=$1', [guest.userId]);
    assert.equal((await accept(server, guest.cookie, token)).status, 409);
    await f.domainPool.query('UPDATE users SET deleted_at=NULL WHERE id=$1', [guest.userId]);
    await f.domainPool.query("UPDATE couples SET status='closed',membership_epoch=3 WHERE id=$1", [owner.coupleId]);
    const before = await state(f);
    assert.equal((await accept(server, guest.cookie, token)).status, 409);
    assert.deepEqual(await state(f), before);
  } finally { await cleanup(f, server); }
});

test('issuer logout alone preserves a valid invitation; a recipient never needs the issuer login session', async () => {
  const f = await createFixture(); let server;
  try {
    server = await harness(f); const { owner, guest, invitation, token } = await prepareCase(f, server);
    assert.equal((await f.call('sign-out', {}, owner.cookie)).status, 200);
    assert.equal((await preview(server, guest.cookie, token)).status, 200);
    assert.equal((await accept(server, guest.cookie, token)).status, 200);
    await assertAccepted(f, owner, guest, invitation.id);
  } finally { await cleanup(f, server); }
});
