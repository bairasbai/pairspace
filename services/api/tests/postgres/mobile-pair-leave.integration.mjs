import assert from 'node:assert/strict';
import { test } from 'node:test';
import { leaveFixture, assertClosed, pairState } from './pair-leave-fixture.mjs';
import { mobile, closeMobile } from './mobile-invitations-fixture.mjs';

for (const lostAck of [false, true]) {
  test(`real mobile pair leave: confirmation, content scrub, cookie retention and ${lostAck ? 'lost ACK immutable replay' : 'verified closed result'}`, async () => {
    const x = await leaveFixture(); const accounts = []; const commands = []; let drop = lostAck;
    try {
      accounts.push(await mobile(x.f, 0, { email: 'letters-0@example.test', signup: false,
        beforeRequest: async (record, request) => {
          if (record.path === '/v1/pair/leave') commands.push(await request.clone().json());
        }, afterResponse: async (record, response) => {
          if (record.path === '/v1/pair/leave' && drop) {
            drop = false; assert.equal(response.status, 200); throw new Error('Synthetic committed leave ACK lost');
          }
        } }));
      accounts.push(await mobile(x.f, 1, { email: 'letters-1@example.test', signup: false }));
      const [actor, partner] = accounts.map(a => a.controller);
      actor.setDraft('Synthetic chat before leave'); actor.letters.setDraft('Synthetic private draft before leave');
      actor.leave.begin(); assert.equal(actor.leave.getSnapshot().status, 'confirming');
      assert.equal(commands.length, 0);
      actor.leave.cancel(); assert.equal(commands.length, 0);
      assert.equal((await pairState(x.f, x.pairA)).status, 'active');
      actor.leave.begin(); await actor.leave.confirm();
      assert.equal(actor.getSnapshot().draft, ''); assert.deepEqual(actor.getSnapshot().messages, []);
      assert.equal(actor.letters.getSnapshot().draft, ''); assert.deepEqual(actor.letters.getSnapshot().letters, []);
      assert.equal(actor.letters.getSnapshot().opened, null); await assertClosed(x.f, x.pairA);
      if (lostAck) {
        assert.equal(actor.leave.getSnapshot().status, 'retry');
        await actor.leave.confirm(); assert.equal(commands.length, 2); assert.deepEqual(commands[0], commands[1]);
      } else assert.equal(commands.length, 1);
      assert.equal(actor.leave.getSnapshot().status, 'closed');
      await actor.refresh(); assert.equal(actor.getSnapshot().error, 'context_no_active_pair');
      await partner.refresh(); assert.equal(partner.getSnapshot().error, 'context_no_active_pair');
      assert.equal((await pairState(x.f, x.pairB)).status, 'active');
      assert.equal((await x.f.domainPool.query('SELECT count(*)::int n FROM "session" WHERE "userId"=$1', [x.identities[0]])).rows[0].n >= 1, true);
    } finally { await closeMobile(x.f, accounts); }
  });
}
