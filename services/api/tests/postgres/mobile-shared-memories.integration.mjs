import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createComposedFixture, client } from './composed-fixture.mjs';
import { mobile, password, closeMobile } from './mobile-invitations-fixture.mjs';

test('real PostgreSQL: shared-memory mobile immutable unknown ACK, separate new draft, explicit sharing and closure', async () => {
  const f = await createComposedFixture({ enableSyntheticSharedMemories: true, enableSyntheticPairLeave: true });
  const accounts = [];
  try {
    const identities = [];
    for (let n = 0; n < 4; n++) {
      const connection = client(f.baseURL);
      const result = await connection.auth.signUp.email({ email: `memory-mobile-${n}@example.test`, password, name: 'Synthetic' });
      assert.equal(result.error === null, true); identities.push(result.data.user.id);
    }
    const pairA = randomUUID(), pairB = randomUUID();
    await f.provision(identities.slice(0, 2), pairA); await f.provision(identities.slice(2), pairB);
    let drop = true; const commands = [];
    accounts.push(await mobile(f, 0, { email: 'memory-mobile-0@example.test', signup: false,
      beforeRequest: async (record, request) => {
        if (record.path.includes('/memories') && record.method === 'POST') {
          const body = await request.clone().json(); commands.push(body);
          assert.equal(request.headers.get('idempotency-key'), body.command_id);
          assert.equal(request.url.includes(body.title), false);
        }
      },
      afterResponse: async (record, response) => {
        if (record.path.includes('/memories') && record.method === 'POST' && drop) {
          assert.equal(response.status, 201); drop = false; throw new Error('Synthetic lost committed ACK');
        }
      } }));
    accounts.push(await mobile(f, 1, { email: 'memory-mobile-1@example.test', signup: false }));
    accounts.push(await mobile(f, 2, { email: 'memory-mobile-2@example.test', signup: false }));
    const [a, b, foreign] = accounts.map(account => account.controller);
    assert.equal(accounts.every(account => !account.requests.some(r => r.path.includes('/memories'))), true);
    a.memories.setDraft('Synthetic shared memory'); a.memories.setLocalDate('2028-02-29'); a.memories.setBody('Synthetic shared body');
    await a.memories.create(); assert.equal(commands.length, 0, 'explicit sharing consent required');
    a.memories.setConsent(true);
    await b.memories.list(); assert.equal(b.memories.getSnapshot().memories.length, 0, 'private RAM draft not auto-shared');
    await a.memories.create(); assert.equal(a.memories.getSnapshot().status, 'retry');
    a.memories.setDraft('Synthetic new draft'); a.memories.setLocalDate('2029-03-01'); a.memories.setBody('Synthetic new body');
    await a.memories.retry(); assert.equal(a.memories.getSnapshot().status, 'saved');
    assert.equal(a.memories.getSnapshot().draft, 'Synthetic new draft');
    assert.equal(a.memories.getSnapshot().localDate, '2029-03-01'); assert.equal(a.memories.getSnapshot().body, 'Synthetic new body');
    assert.deepEqual(commands[0], commands[1]);
    const memory = a.memories.getSnapshot().memories[0]; assert.equal(memory.localDate, '2028-02-29'); assert.equal(memory.body, 'Synthetic shared body');
    await b.memories.list(); assert.deepEqual(b.memories.getSnapshot().memories, [memory]);
    await foreign.memories.list(); assert.equal(foreign.memories.getSnapshot().memories.length, 0);
    const cookie = await accounts[2].connection.getCookie();
    assert.equal((await fetch(`${f.baseURL}/v1/couples/${pairA}/memories?membership_epoch=1`,
      { headers: { cookie, origin: f.baseURL } })).status, 403);
    const persisted = (await f.domainPool.query('SELECT local_date::text,body,title FROM shared_memories')).rows;
    assert.deepEqual(persisted, [{ local_date: '2028-02-29', body: 'Synthetic shared body', title: 'Synthetic shared memory' }]);
    const ownerCookie = await accounts[0].connection.getCookie();
    const leave = await fetch(`${f.baseURL}/v1/pair/leave`, { method: 'POST',
      headers: { cookie: ownerCookie, origin: f.baseURL, 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: randomUUID(), coupleId: pairA, membershipEpoch: 1, confirm: true }) });
    assert.equal(leave.status, 200);
    await a.memories.list(); assert.equal(a.memories.getSnapshot().available, false);
    assert.deepEqual(a.memories.getSnapshot().memories, []); assert.equal(a.memories.getSnapshot().draft, '');
    await b.refresh(); assert.deepEqual(b.memories.getSnapshot().memories, []);
    await foreign.memories.list(); assert.equal(foreign.memories.getSnapshot().available, true);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM shared_memories')).rows[0].n, 1, 'rows retained without deciding archive or retention policy');
  } finally { await closeMobile(f, accounts); }
});
