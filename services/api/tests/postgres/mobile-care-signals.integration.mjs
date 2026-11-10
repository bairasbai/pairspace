import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createComposedFixture, client } from './composed-fixture.mjs';
import { mobile, password, closeMobile } from './mobile-invitations-fixture.mjs';

test('real PostgreSQL: mobile explicit care, lost ACK replay, two-pair isolation and epoch reset', async () => {
  const f = await createComposedFixture({ enableSyntheticCareSignals: true });
  const accounts = [];
  try {
    const identities = [];
    for (let n = 0; n < 4; n++) {
      const connection = client(f.baseURL);
      const result = await connection.auth.signUp.email({ email: `care-mobile-${n}@example.test`, password, name: 'Synthetic' });
      assert.equal(result.error === null, true, 'synthetic signup'); identities.push(result.data.user.id);
    }
    const pairA = randomUUID(), pairB = randomUUID();
    const usersA = await f.provision(identities.slice(0, 2), pairA);
    await f.provision(identities.slice(2), pairB);
    let loseAck = true; const commands = [];
    accounts.push(await mobile(f, 0, { email: 'care-mobile-0@example.test', signup: false,
      beforeRequest: async (record, request) => {
        if (record.path.endsWith('/care-signals') && request.method === 'POST') {
          commands.push((await request.clone().json()).client_signal_id);
          assert.equal(request.headers.get('idempotency-key'), commands.at(-1));
        }
      },
      afterResponse: async (record, response) => {
        if (record.path.endsWith('/care-signals') && record.method === 'POST' && loseAck) {
          assert.equal(response.status, 201); loseAck = false; throw new Error('Synthetic lost committed ACK');
        }
      } }));
    accounts.push(await mobile(f, 1, { email: 'care-mobile-1@example.test', signup: false }));
    accounts.push(await mobile(f, 2, { email: 'care-mobile-2@example.test', signup: false }));
    const [sender, receiver, foreign] = accounts.map(a => a.controller);
    assert.equal(accounts.every(a => !a.requests.some(r => r.path.endsWith('/care-signals'))), true, 'no implicit care I/O');
    await sender.care.send(); assert.equal(sender.care.getSnapshot().status, 'retry');
    await sender.care.send(); assert.equal(sender.care.getSnapshot().status, 'sent');
    assert.equal(commands.length, 2); assert.equal(commands[0], commands[1]);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM care_signals')).rows[0].n, 1);
    await sender.care.read(); assert.equal(sender.care.getSnapshot().incoming, null, 'no self effect');
    await receiver.care.read(); assert.equal(receiver.care.getSnapshot().incoming.senderId, usersA[0]);
    await foreign.care.read(); assert.equal(foreign.care.getSnapshot().incoming, null);
    const cookie = await accounts[2].connection.getCookie();
    assert.equal((await fetch(`${f.baseURL}/v1/couples/${pairA}/care-signals?membership_epoch=1`,
      { headers: { cookie, origin: f.baseURL } })).status, 403);
    await sender.care.send(); assert.equal(sender.care.getSnapshot().status, 'cooldown');
    assert.notEqual(commands[2], commands[1], 'new confirmed tap uses new command');
    await f.domainPool.query('UPDATE couples SET membership_epoch=2 WHERE id=$1', [pairA]);
    const posts = commands.length; await sender.care.send();
    assert.equal(commands.length, posts, 'scope change prevents old-context mutation');
    assert.equal(sender.care.getSnapshot().status, 'idle');
    await receiver.refresh(); assert.equal(receiver.care.getSnapshot().incoming, null, 'new epoch clears old visible signal');
    await receiver.care.read(); assert.equal(receiver.care.getSnapshot().incoming, null);
    await sender.signOut(); assert.equal(sender.care.getSnapshot().available, false);
  } finally { await closeMobile(f, accounts); }
});
