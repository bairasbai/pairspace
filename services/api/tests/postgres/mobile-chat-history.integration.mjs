import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createComposedFixture, client } from './composed-fixture.mjs';
import { mobile, password, closeMobile } from './mobile-invitations-fixture.mjs';

async function fixture(count = 125) {
  const f = await createComposedFixture({ enableSyntheticChatHistoryWindow: true });
  try {
    const identities = []; const connections = [];
    for (let index = 0; index < 4; index++) {
      const connection = client(f.baseURL);
      const result = await connection.auth.signUp.email({
        email: `chat-history-${index}@example.test`, password, name: 'Synthetic',
      });
      assert.equal(result.error === null, true, 'synthetic account created');
      identities.push(result.data.user.id); connections.push(connection);
    }
    const pairA = randomUUID(); const pairB = randomUUID();
    const usersA = await f.provision(identities.slice(0, 2), pairA);
    const usersB = await f.provision(identities.slice(2), pairB);
    async function seed(pair, sender, start, end) {
      // Deliberate gaps: sequence numbers are not row counts. Only disposable synthetic rows.
      await f.domainPool.query(`INSERT INTO chat_messages
        (couple_id,sender_id,client_message_id,seq,body)
        SELECT $1,$2,gen_random_uuid(),CASE n WHEN 4 THEN 10 WHEN 34 THEN 100 ELSE n*3 END,'Synthetic history ' || n
        FROM generate_series($3::integer,$4::integer) n`, [pair, sender, start, end]);
      await f.domainPool.query('UPDATE couples SET next_chat_seq=$2 WHERE id=$1', [pair, end * 3 + 1]);
    }
    await seed(pairA, usersA[0], 1, count); await seed(pairB, usersB[0], 1, 80);
    return { f, connections, pairA, pairB, usersA, seed };
  } catch (error) { await f.close(); throw error; }
}
async function history(f, connection, pair, { beforeSeq, epoch = 1 } = {}) {
  const url = new URL(`/v1/couples/${pair}/chat/messages`, f.baseURL);
  url.searchParams.set('membership_epoch', String(epoch)); url.searchParams.set('limit', '50');
  if (beforeSeq !== undefined) url.searchParams.set('beforeSeq', String(beforeSeq));
  const cookie = connection ? await connection.getCookie() : '';
  return fetch(url, { headers: { cookie, origin: f.baseURL } });
}
const sequence = n => n === 4 ? 10 : n === 34 ? 100 : n * 3;
const sequences = (start, end) => Array.from({ length: end - start + 1 }, (_, n) => sequence(n + start));

test('real PostgreSQL: mobile navigates beyond 200 with bounded windows, gaps and preserved draft', async () => {
  const { f, pairA, pairB, usersA, seed } = await fixture(251); let account;
  try {
    account = await mobile(f, 0, { email: 'chat-history-0@example.test', signup: false });
    const controller = account.controller;
    assert.deepEqual(controller.getSnapshot().messages.map(m => m.seq), sequences(202, 251));
    controller.setDraft('Synthetic draft must survive every window');
    const visited = [...controller.getSnapshot().messages];
    for (let page = 0; page < 5; page++) {
      await controller.loadOlder();
      assert.ok(controller.getSnapshot().messages.length <= 50);
      visited.push(...controller.getSnapshot().messages);
    }
    assert.deepEqual(visited.map(m => m.seq).sort((a,b) => a-b), sequences(1, 251));
    assert.equal(new Set(visited.map(m => m.id)).size, 251);
    const count = account.requests.length; await controller.loadOlder();
    assert.equal(account.requests.length, count, 'oldest edge performs no I/O');
    await controller.loadNewer();
    assert.deepEqual(controller.getSnapshot().messages.map(m => m.seq), sequences(2, 51));
    await controller.loadOldest();
    assert.deepEqual(controller.getSnapshot().messages.map(m => m.seq), sequences(1, 50));
    await controller.loadNewer();
    assert.deepEqual(controller.getSnapshot().messages.map(m => m.seq), sequences(51, 100));
    await seed(pairA, usersA[0], 252, 321);
    await controller.loadOlder();
    assert.deepEqual(controller.getSnapshot().messages.map(m => m.seq), sequences(1, 50));
    await controller.loadLatest();
    assert.deepEqual(controller.getSnapshot().messages.map(m => m.seq), sequences(272, 321));
    assert.equal(controller.getSnapshot().draft, 'Synthetic draft must survive every window');
    assert.equal(controller.getSnapshot().messages.every(m => m.coupleId === pairA && m.coupleId !== pairB), true);
    assert.ok(account.requests.some(request => request.path.endsWith('/chat/reply-window')), 'connected reader uses the reply-aware window');
    for (let index = 0; index < account.requests.length; index++) {
      const request = account.requests[index];
      if (request.path.endsWith('/chat/reply-window')) {
        assert.equal(request.method, 'GET');
        assert.equal(account.requests[index - 1]?.path, '/v1/session/context');
        assert.equal(request.cookieDigest, account.requests[index - 1].cookieDigest);
      }
    }
  } finally { await closeMobile(f, account ? [account] : []); }
});

test('real PostgreSQL: history isolates pairs and rejects missing, stale and former-member authority', async () => {
  const { f, connections, pairA, pairB, usersA } = await fixture();
  try {
    const first = await history(f, connections[0], pairA); assert.equal(first.status, 200);
    const latest = (await first.json()).value;
    assert.deepEqual(latest.messages.map(m => m.seq), sequences(76, 125));
    assert.equal(latest.nextBeforeSeq, 228);
    const older = (await (await history(f, connections[0], pairA, { beforeSeq: 228 })).json()).value;
    assert.deepEqual(older.messages.map(m => m.seq), sequences(26, 75));
    assert.equal(older.nextBeforeSeq, 78);
    const last = (await (await history(f, connections[0], pairA, { beforeSeq: 78 })).json()).value;
    assert.deepEqual(last.messages.map(m => m.seq), sequences(1, 25)); assert.equal(last.nextBeforeSeq, null);
    const pageB = (await (await history(f, connections[2], pairB)).json()).value;
    assert.deepEqual(pageB.messages.map(m => m.seq), sequences(31, 80));
    assert.equal(pageB.messages.every(m => m.coupleId === pairB), true);
    assert.equal((await history(f, null, pairA, { beforeSeq: 228 })).status, 401);
    assert.equal((await history(f, connections[2], pairA, { beforeSeq: 228 })).status, 403);
    assert.equal((await history(f, connections[0], pairB, { beforeSeq: 228 })).status, 403);
    assert.equal((await history(f, connections[0], pairA, { beforeSeq: 228, epoch: 2 })).status, 409);
    await f.domainPool.query("WITH closed AS (UPDATE couples SET status='closed',membership_epoch=2 WHERE id=$1 RETURNING id) UPDATE couple_members SET status='revoked' WHERE couple_id IN (SELECT id FROM closed)", [pairA]);
    await f.domainPool.query("UPDATE couple_members SET status='revoked' WHERE couple_id=$1 AND user_id=$2", [pairA, usersA[0]]);
    assert.equal((await history(f, connections[0], pairA, { beforeSeq: 228, epoch: 2 })).status, 403);
  } finally { await f.close(); }
});

test('real PostgreSQL: delayed send ACK preserves old window and newer draft, explicit latest retrieves it once', async () => {
  const { f, pairA } = await fixture(251); let account, pending, entered, release;
  const reached = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  try {
    account = await mobile(f, 0, { email: 'chat-history-0@example.test', signup: false,
      afterResponse: async request => {
        if (request.method === 'POST' && request.path.endsWith('/chat/messages')) { entered(); await gate; }
      } });
    const controller = account.controller;
    controller.setDraft('Synthetic committed while browsing');
    pending = controller.send(); await reached;
    await controller.loadOldest();
    assert.deepEqual(controller.getSnapshot().messages.map(m => m.seq), sequences(1, 50));
    controller.setDraft('A newer unsent draft'); release(); await pending; pending = null;
    assert.equal(controller.getSnapshot().outgoing.status, 'sent');
    assert.equal(controller.getSnapshot().draft, 'A newer unsent draft');
    assert.deepEqual(controller.getSnapshot().messages.map(m => m.seq), sequences(1, 50));
    await controller.loadLatest();
    assert.equal(controller.getSnapshot().messages.at(-1).body, 'Synthetic committed while browsing');
    assert.equal(controller.getSnapshot().draft, 'A newer unsent draft');
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM chat_messages WHERE couple_id=$1', [pairA])).rows[0].n, 252);
    assert.equal(account.requests.filter(r => r.method === 'POST' && r.path.endsWith('/chat/messages')).length, 1);
  } finally { release?.(); if (pending) await pending; await closeMobile(f, account ? [account] : []); }
});
