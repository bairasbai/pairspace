import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { lettersFixture } from './letters-fixture.mjs';
import { mobile, closeMobile } from './mobile-invitations-fixture.mjs';

test('real PostgreSQL: composed mobile wishes consent, unknown ACK, canonical status, newer draft and former members', async () => {
  const x = await lettersFixture({ enableSyntheticSharedWishes: true, enableSyntheticPairLeave: true });
  const accounts = []; const commands = []; let dropCreate = true, dropChange = true;
  try {
    accounts.push(await mobile(x.f, 0, { signup: false, email: 'letters-0@example.test',
      beforeRequest: async (record, request) => {
        if (record.path.includes('/wishes') && record.method === 'POST') {
          const command = await request.clone().json(); commands.push(command);
          assert.equal(request.headers.get('idempotency-key'), command.command_id);
          assert.equal(request.url.includes(command.title), false);
        }
      }, afterResponse: async (record, response) => {
        if (record.path.endsWith('/wishes') && record.method === 'POST' && dropCreate) {
          assert.equal(response.status, 201); dropCreate = false; throw Error('Synthetic lost committed create ACK');
        }
        if (record.path.includes('/wishes/') && record.method === 'POST' && dropChange) {
          assert.equal(response.status, 200); dropChange = false; throw Error('Synthetic lost committed status ACK');
        }
      } }));
    accounts.push(await mobile(x.f, 1, { signup: false, email: 'letters-1@example.test' }));
    const [a, b] = accounts.map(account => account.controller);
    assert.ok(accounts.every(account => !account.requests.some(r => r.path.includes('/wishes'))));
    a.wishes.setDraft('Synthetic shared wish'); a.wishes.setExplanation('Synthetic optional reason');
    await a.wishes.create(); assert.equal(commands.length, 0);
    await b.wishes.list(); assert.deepEqual(b.wishes.getSnapshot().wishes, []);
    a.wishes.setConsent(true); await a.wishes.create(); assert.equal(a.wishes.getSnapshot().status, 'retry');
    a.wishes.setDraft('Synthetic newer draft'); a.wishes.setExplanation('Synthetic new private draft');
    await a.wishes.retry(); assert.equal(a.wishes.getSnapshot().status, 'saved');
    assert.deepEqual(commands[0], commands[1]); assert.equal(a.wishes.getSnapshot().draft, 'Synthetic newer draft');
    assert.equal(a.wishes.getSnapshot().explanation, 'Synthetic new private draft');
    const wish = a.wishes.getSnapshot().wishes[0]; assert.equal(wish.creatorId, x.usersA[0]); assert.equal(wish.state, 'open');
    await b.wishes.list(); assert.deepEqual(b.wishes.getSnapshot().wishes, [wish]);
    await a.wishes.fulfill(wish.id); assert.equal(a.wishes.getSnapshot().status, 'retry');
    await b.wishes.list(); assert.equal(b.wishes.getSnapshot().wishes[0].version, 2);
    await b.wishes.reopen(wish.id); assert.equal(b.wishes.getSnapshot().wishes[0].version, 3);
    await a.wishes.retry(); assert.deepEqual(commands[2], commands[3]);
    assert.equal(a.wishes.getSnapshot().wishes[0].state, 'open'); assert.equal(a.wishes.getSnapshot().wishes[0].version, 3);
    assert.equal(a.wishes.getSnapshot().draft, 'Synthetic newer draft');
    const path = `/v1/couples/${x.pairA}/wishes`;
    const post = (index, route, body) => x.raw(index, route, { method: 'POST', headers: {
      'content-type': 'application/json', 'idempotency-key': body.command_id }, body: JSON.stringify(body) });
    assert.equal((await x.raw(null, path + '?membership_epoch=1')).status, 401);
    for (const actor of [2, 3]) {
      assert.equal((await x.raw(actor, path + '?membership_epoch=1')).status, 403);
      assert.equal((await post(actor, path, { ...commands[0], command_id: randomUUID() })).status, 403);
      assert.equal((await post(actor, path + '/' + wish.id, { ...commands[2], command_id: randomUUID(), expected_version: 3 })).status, 403);
    }
    assert.equal((await x.raw(0, path + '?membership_epoch=2')).status, 409);
    const historical = await post(0, path, commands[0]); assert.equal(historical.status, 200);
    assert.equal((await historical.json()).value.wish.version, 3);
    assert.equal((await post(0, path, { ...commands[0], explanation: 'Changed' })).status, 409);
    await b.wishes.fulfill(wish.id); await a.wishes.fulfill(wish.id);
    assert.equal(a.wishes.getSnapshot().status, 'conflict'); assert.equal(a.wishes.getSnapshot().requiresRefresh, true);
    assert.equal(a.wishes.getSnapshot().draft, 'Synthetic newer draft');
    await a.wishes.list(); assert.equal(a.wishes.getSnapshot().wishes[0].version, 4);
    a.wishes.cancel(); a.wishes.setDraft('Synthetic wish without explanation'); a.wishes.setConsent(true); await a.wishes.create();
    assert.equal(a.wishes.getSnapshot().status, 'saved'); assert.equal(a.wishes.getSnapshot().wishes[0].explanation, '');
    assert.equal((await x.f.domainPool.query('SELECT count(*)::int n FROM shared_tasks')).rows[0].n, 0);
    assert.equal((await x.f.domainPool.query('SELECT count(*)::int n FROM outbox_events')).rows[0].n, 0);
    const leave = await x.raw(1, '/v1/pair/leave', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: randomUUID(), coupleId: x.pairA, membershipEpoch: 1, confirm: true }) });
    assert.equal(leave.status, 200);
    assert.equal((await post(0, path, commands[0])).status, 403);
    await a.wishes.list(); assert.equal(a.wishes.getSnapshot().available, false);
    assert.deepEqual(a.wishes.getSnapshot().wishes, []); assert.equal(a.wishes.getSnapshot().draft, '');
    await b.refresh(); assert.deepEqual(b.wishes.getSnapshot().wishes, []);
    assert.equal((await x.f.domainPool.query('SELECT count(*)::int n FROM shared_wishes')).rows[0].n, 2);
  } finally { await closeMobile(x.f, accounts); }
});
