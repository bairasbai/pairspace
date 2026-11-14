import assert from 'node:assert/strict';
import { test } from 'node:test';
import { replyFixture, latch } from './mobile-reply-fixture.mjs';
import { closeMobile, password } from './mobile-invitations-fixture.mjs';
import { outgoingAccount } from './mobile-outgoing-fixture.mjs';

const posts = a => a.requests.filter(r => r.method === 'POST' && /\/chat\/(messages|replies)$/.test(r.path));
function discard(controller) {
  controller.beginDiscardOutgoing();
  const confirmation = controller.getSnapshot().discardConfirmation;
  assert.notEqual(confirmation, undefined);
  controller.confirmDiscardOutgoing(confirmation.token);
  assert.equal(controller.getSnapshot().outgoingPending, undefined);
}

test('real mobile/HTTP/PostgreSQL: an explicitly discarded permanent rejection does not trap the next outgoing message', async () => {
  const { f, pairA } = await replyFixture(0); let a, reject = true;
  try {
    a = await outgoingAccount(f, 0, { transform: async request => {
      if (reject && request.method === 'POST' && new URL(request.url).pathname.endsWith('/chat/messages')) {
        reject = false; const body = await request.json();
        return new Request(request, { body: JSON.stringify({ ...body, body: '' }) });
      }
      return request;
    } });
    a.controller.setDraft('Synthetic permanently rejected attempt'); await a.controller.send();
    assert.equal(posts(a).length, 1); assert.equal(posts(a)[0].status >= 400, true);
    assert.equal(a.controller.getSnapshot().outgoingPending, true);
    a.controller.setDraft('New message after explicit discard'); discard(a.controller);
    await a.controller.send();
    assert.equal(a.controller.getSnapshot().outgoing.status, 'sent');
    assert.equal(posts(a).length, 2); assert.notEqual(posts(a)[0].body.client_message_id, posts(a)[1].body.client_message_id);
    const rows = (await f.domainPool.query('SELECT body FROM chat_messages WHERE couple_id=$1', [pairA])).rows;
    assert.deepEqual(rows, [{ body: 'New message after explicit discard' }]);
  } finally { await closeMobile(f, a ? [a] : []); }
});

test('real mobile/HTTP/PostgreSQL: discard of a held successful ACK releases a fresh send but does not delete the committed message', async () => {
  const { f, pairA } = await replyFixture(0); const gate = latch(); let a, oldSend, hold = true;
  try {
    a = await outgoingAccount(f, 0, { after: async record => {
      if (hold && record.method === 'POST' && record.path.endsWith('/chat/messages')) {
        hold = false; gate.arrive(); await gate.gate;
      }
    } });
    a.controller.setDraft('Old committed message with held ACK'); oldSend = a.controller.send(); await gate.reached;
    a.controller.setDraft('New message must stay independent'); discard(a.controller);
    await a.controller.send();
    assert.equal(a.controller.getSnapshot().outgoing.body, 'New message must stay independent');
    a.controller.setDraft('Unsent newer composer after new ACK');
    gate.release(); await oldSend; oldSend = null;
    assert.equal(a.controller.getSnapshot().outgoing.body, 'New message must stay independent');
    assert.equal(a.controller.getSnapshot().draft, 'Unsent newer composer after new ACK');
    assert.equal(posts(a).length, 2); assert.notEqual(posts(a)[0].body.client_message_id, posts(a)[1].body.client_message_id);
    await a.controller.loadLatest();
    assert.deepEqual(a.controller.getSnapshot().messages.map(m => m.body), ['Old committed message with held ACK', 'New message must stay independent']);
    assert.equal(a.requests.some(r => r.method === 'DELETE'), false);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM chat_messages WHERE couple_id=$1', [pairA])).rows[0].n, 2);
  } finally { gate.release(); if (oldSend) await oldSend; await closeMobile(f, a ? [a] : []); }
});

for (const kind of ['401', '403', 'stale_membership']) {
  test(`real mobile/HTTP/PostgreSQL: current-session delayed ${kind} still blocks after outgoing discard`, async () => {
    const { f, pairB } = await replyFixture(0); const gate = latch(); let a, oldSend, alter = true, hold = true;
    try {
      a = await outgoingAccount(f, 0, { transform: async request => {
        if (!alter || request.method !== 'POST' || !new URL(request.url).pathname.endsWith('/chat/messages')) return request;
        alter = false;
        if (kind === '401') { const headers = new Headers(request.headers); headers.set('cookie', 'synthetic_invalid=1'); return new Request(request, { headers }); }
        if (kind === '403') {
          const url = new URL(request.url); url.pathname = `/v1/couples/${pairB}/chat/messages`;
          return new Request(url, { method: request.method, headers: request.headers, body: await request.text() });
        }
        const body = await request.json(); return new Request(request, { body: JSON.stringify({ ...body, membership_epoch: 2 }) });
      }, after: async record => {
        if (hold && record.method === 'POST' && record.path.endsWith('/chat/messages')) {
          hold = false; gate.arrive(); await gate.gate;
        }
      } });
      a.controller.setDraft(`Synthetic delayed ${kind}`); oldSend = a.controller.send(); await gate.reached;
      assert.equal(posts(a)[0].status, kind === 'stale_membership' ? 409 : Number(kind));
      discard(a.controller); a.controller.setDraft('Fresh same-session send before denial arrives'); await a.controller.send();
      assert.equal(a.controller.getSnapshot().outgoing.status, 'sent');
      gate.release(); await oldSend; oldSend = null;
      assert.equal(a.controller.getSnapshot().phase, 'blocked');
      assert.equal(a.controller.getSnapshot().messages.length, 0); assert.equal(a.controller.getSnapshot().draft, '');
      assert.equal(a.controller.getSnapshot().outgoingPending, undefined);
    } finally { gate.release(); if (oldSend) await oldSend; await closeMobile(f, a ? [a] : []); }
  });
}

test('real mobile/HTTP/PostgreSQL: delayed denial from a previous account cannot block the newer account after discard', async () => {
  const { f, pairB } = await replyFixture(0); const gate = latch(); let a, oldSend, alter = true, hold = true;
  try {
    a = await outgoingAccount(f, 0, { transform: request => {
      if (alter && request.method === 'POST' && new URL(request.url).pathname.endsWith('/chat/messages')) {
        alter = false; const headers = new Headers(request.headers); headers.set('cookie', 'synthetic_invalid=1');
        return new Request(request, { headers });
      }
      return request;
    }, after: async record => {
      if (hold && record.method === 'POST' && record.path.endsWith('/chat/messages')) { hold = false; gate.arrive(); await gate.gate; }
    } });
    a.controller.setDraft('Previous account request'); oldSend = a.controller.send(); await gate.reached;
    assert.equal(posts(a)[0].status, 401); discard(a.controller);
    await a.controller.signOut(); await a.controller.signIn('reply-2@example.test', password);
    a.controller.setDraft('New account accepted message'); await a.controller.send();
    a.controller.setDraft('New account unsubmitted draft'); gate.release(); await oldSend; oldSend = null;
    assert.equal(a.controller.getSnapshot().phase, 'signed_in');
    assert.equal(a.controller.getSnapshot().draft, 'New account unsubmitted draft');
    assert.equal(a.controller.getSnapshot().outgoing.body, 'New account accepted message');
    await a.controller.loadLatest(); assert.equal(a.controller.getSnapshot().messages.every(m => m.coupleId === pairB), true);
  } finally { gate.release(); if (oldSend) await oldSend; await closeMobile(f, a ? [a] : []); }
});

test('real mobile/HTTP/PostgreSQL: queue compaction retains the immutable body and source of an unresolved reply retry', async () => {
  const { f, pairA, rows } = await replyFixture(2); let a, lose = true;
  try {
    a = await outgoingAccount(f, 0, { after: async record => {
      if (lose && record.method === 'POST' && record.path.endsWith('/chat/replies')) { lose = false; throw Error('Synthetic lost reply ACK'); }
    } });
    a.controller.setReplyTarget(rows[0].id); a.controller.setDraft('Original unresolved reply'); await a.controller.send();
    assert.equal(a.controller.getSnapshot().outgoingPending, true);
    a.controller.setReplyTarget(rows[1].id); a.controller.setDraft('New independent reply draft'); await a.controller.send();
    assert.equal(a.controller.getSnapshot().outgoing.status, 'sent');
    assert.equal(a.controller.getSnapshot().outgoingPending, undefined);
    assert.equal(a.controller.getSnapshot().draft, 'New independent reply draft');
    assert.equal(a.controller.getSnapshot().replyTarget.id, rows[1].id);
    assert.equal(posts(a).length, 2); assert.deepEqual(posts(a)[0].body, posts(a)[1].body);
    const replies = (await f.domainPool.query('SELECT body,reply_to_id FROM chat_messages WHERE couple_id=$1 AND reply_to_id IS NOT NULL', [pairA])).rows;
    assert.deepEqual(replies, [{ body: 'Original unresolved reply', reply_to_id: rows[0].id }]);
  } finally { await closeMobile(f, a ? [a] : []); }
});
