import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createComposedFixture, client } from './composed-fixture.mjs';
import { mobile, password, closeMobile } from './mobile-invitations-fixture.mjs';

test('blind real PostgreSQL: mobile controllers → HTTP → DB, consent, lost ACK retry and symmetric reveal', async () => {
  const f = await createComposedFixture({ enableSyntheticBlindAnswers: true, enableSyntheticPairLeave: true });
  const accounts = [];
  try {
    const identities = [];
    for (let n = 0; n < 4; n++) {
      const connection = client(f.baseURL);
      const result = await connection.auth.signUp.email({ email: `blind-mobile-${n}@example.test`, password, name: 'Synthetic' });
      assert.equal(result.error, null); identities.push(result.data.user.id);
    }
    const pairA = randomUUID(), pairB = randomUUID();
    await f.provision(identities.slice(0, 2), pairA); await f.provision(identities.slice(2), pairB);
    let drop = true; const commands = [];
    accounts.push(await mobile(f, 0, { email: 'blind-mobile-0@example.test', signup: false,
      beforeRequest: async (record, request) => {
        if (record.path.endsWith('/answer') && record.method === 'POST') commands.push(await request.clone().json());
      }, afterResponse: async (record, response) => {
        if (record.path.endsWith('/answer') && record.method === 'POST' && drop) {
          assert.equal(response.status, 200); drop = false; throw new Error('Synthetic lost committed ACK');
        }
      } }));
    accounts.push(await mobile(f, 1, { email: 'blind-mobile-1@example.test', signup: false }));
    accounts.push(await mobile(f, 2, { email: 'blind-mobile-2@example.test', signup: false }));
    const [a, b, foreign] = accounts.map(item => item.controller);
    assert.ok(accounts.every(item => !item.requests.some(r => r.path.includes('blind-round'))), 'no automatic requests');
    await a.blind.open(); await b.blind.read(); await foreign.blind.read();
    assert.equal(foreign.blind.getSnapshot().round, null);
    const round = a.blind.getSnapshot().round; assert.ok(round);
    assert.equal(b.blind.getSnapshot().round.id, round.id);
    a.blind.setDraft('Synthetic A'); await a.blind.submit();
    assert.equal(commands.length, 0, 'no submission without consent');
    a.blind.setConsent(true); await a.blind.submit();
    assert.equal(a.blind.getSnapshot().status, 'retry');
    a.blind.setDraft('Synthetic attempted replacement');
    await a.blind.retry();
    assert.deepEqual(commands[0], commands[1], 'unknown ACK retry keeps command answer and consent');
    assert.equal(a.blind.getSnapshot().round.ownAnswer, 'Synthetic A');
    assert.equal(a.blind.getSnapshot().round.partnerAnswer, null);
    await b.blind.read(); assert.equal(b.blind.getSnapshot().round.partnerAnswer, null);
    assert.equal(b.blind.getSnapshot().round.revealed, false);
    b.blind.setDraft('Synthetic B'); b.blind.setConsent(true); await b.blind.submit();
    assert.equal(b.blind.getSnapshot().round.partnerAnswer, 'Synthetic A');
    await a.blind.read(); assert.equal(a.blind.getSnapshot().round.partnerAnswer, 'Synthetic B');
    assert.equal(a.blind.getSnapshot().round.revealed, true);
    await a.blind.open(); assert.equal(a.blind.getSnapshot().round.id, round.id);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM blind_rounds')).rows[0].n, 1);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM blind_answers')).rows[0].n, 2);
    const ownerCookie = await accounts[0].connection.getCookie();
    const left = await fetch(`${f.baseURL}/v1/pair/leave`, { method: 'POST',
      headers: { cookie: ownerCookie, origin: f.baseURL, 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: randomUUID(), coupleId: pairA, membershipEpoch: 1, confirm: true }) });
    assert.equal(left.status, 200);
    await a.blind.read(); assert.equal(a.blind.getSnapshot().available, false);
    assert.equal(a.blind.getSnapshot().round, null); assert.equal(a.blind.getSnapshot().draft, '');
    await b.refresh(); assert.equal(b.blind.getSnapshot().round, null);
    await foreign.signOut(); assert.equal(foreign.blind.getSnapshot().available, false);
  } finally { await closeMobile(f, accounts); }
});
