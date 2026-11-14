import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { replyFixture } from './mobile-reply-fixture.mjs';
import { closeMobile } from './mobile-invitations-fixture.mjs';
import { outgoingAccount } from './mobile-outgoing-fixture.mjs';

let fixture, account;
before(async () => { fixture = await replyFixture(0); account = await outgoingAccount(fixture.f); });
after(async () => { if (fixture) await closeMobile(fixture.f, account ? [account] : []); });

// Same real controller and pair across all three sequential top-level tests. The split
// retains the unchanged per-test 30s bound; no messages are inserted directly by SQL.
for (const [start, end] of [[1, 200], [201, 400], [401, 501]]) {
  test(`real mobile/HTTP/PostgreSQL: successful outgoing messages ${start}-${end} continue beyond the old 500-record lifetime stop`, async () => {
    for (let n = start; n <= end; n++) {
      const body = `Synthetic continuous send ${n}`;
      account.controller.setDraft(body); await account.controller.send();
      assert.equal(account.controller.getSnapshot().outgoing?.status, 'sent', `send ${n} acknowledged`);
      assert.equal(account.controller.getSnapshot().draft, '');
      assert.equal(account.controller.getSnapshot().outgoingPending, undefined);
    }
    const posts = account.requests.filter(r => r.method === 'POST' && r.path.endsWith('/chat/messages'));
    assert.equal(posts.length, end); assert.equal(posts.every(p => p.status === 201), true);
    assert.equal(new Set(posts.map(p => p.body.client_message_id)).size, end);
    const rows = (await fixture.f.domainPool.query('SELECT client_message_id,body,seq::int FROM chat_messages WHERE couple_id=$1 ORDER BY seq', [fixture.pairA])).rows;
    assert.equal(rows.length, end);
    assert.deepEqual(rows.map(r => r.seq), Array.from({ length: end }, (_, n) => n + 1));
    assert.deepEqual(rows.map(r => r.body), Array.from({ length: end }, (_, n) => `Synthetic continuous send ${n + 1}`));
    assert.equal((await fixture.f.domainPool.query("SELECT count(*)::int n FROM outbox_events WHERE couple_id=$1 AND type='chat.message_created'", [fixture.pairA])).rows[0].n, end);
    if (end === 501) {
      await account.controller.loadLatest();
      assert.equal(account.controller.getSnapshot().messages.length, 50);
      assert.equal(account.controller.getSnapshot().messages.at(-1).body, 'Synthetic continuous send 501');
    }
  });
}
