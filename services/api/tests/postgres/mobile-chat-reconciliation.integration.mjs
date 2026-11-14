import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { outgoingAccount } from './mobile-outgoing-fixture.mjs';
import { replyFixture, latch } from './mobile-reply-fixture.mjs';
import { mobile, closeMobile, password } from './mobile-invitations-fixture.mjs';
import { visibilityRequest, setVisibility, requireSuccess } from './chat-visibility-http-fixture.mjs';

const fixture = () => replyFixture(267, { enableSyntheticChatReconciliation: true });
const account = (f, index = 0, options = {}) => mobile(f, index, { email: `reply-${index}@example.test`, signup: false, ...options });
const reconcile = (f, connection, pair, ids, detail, replyTarget) => visibilityRequest(f, connection, pair, 'reconcile', {
  query: { message_ids: ids.join(','), ...(detail ? { detail_id: detail } : {}), ...(replyTarget ? { reply_target_id: replyTarget } : {}) },
});
async function edit(f, connection, pair, id, body, version = 1) {
  return requireSuccess(await visibilityRequest(f, connection, pair, `messages/${id}`, { method: 'PATCH', body: {
    membership_epoch: 1, command_id: randomUUID(), expected_version: version, body,
  } }));
}
async function remove(f, connection, pair, id, version = 1) {
  return requireSuccess(await visibilityRequest(f, connection, pair, `messages/${id}`, { method: 'DELETE', body: {
    membership_epoch: 1, command_id: randomUUID(), expected_version: version, scope: 'everyone',
  } }));
}

test('real HTTP/PG reconciliation: 267-row old window plus separate detail returns current revisions without writes or a latest-window graft', async () => {
  const { f, rows, pairA, connections } = await fixture();
  try {
    const ids = rows.slice(0, 50).map(r => r.id), detail = rows[201];
    await edit(f, connections[0], pairA, rows[1].id, 'Changed old-window message');
    await edit(f, connections[0], pairA, detail.id, 'Changed outside-window original');
    await remove(f, connections[1], pairA, rows[2].id);
    const before = await f.domainPool.query('SELECT count(*)::int n FROM outbox_events');
    const result = await reconcile(f, connections[1], pairA, ids, detail.id);
    const value = requireSuccess(result);
    assert.deepEqual(value.messages.map(m => m.id), ids);
    assert.equal(value.messages[1].body, 'Changed old-window message'); assert.equal(value.messages[1].version, 2);
    assert.equal(value.messages[2].body, null); assert.equal(value.messages[2].version, 2);
    assert.equal(value.detail.id, detail.id); assert.equal(value.detail.message.body, 'Changed outside-window original');
    assert.deepEqual(value.latestVisible, { id: rows.at(-1).id, seq: rows.at(-1).seq });
    assert.deepEqual(value.unavailableIds, []); assert.equal(value.messages.length, 50);
    assert.deepEqual((await f.domainPool.query('SELECT count(*)::int n FROM outbox_events')).rows, before.rows);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM chat_messages WHERE couple_id=$1', [pairA])).rows[0].n, 267);
  } finally { await f.close(); }
});

test('real HTTP/PG reconciliation: foreign, missing and private-hidden targets share unavailable projection; partner remains unchanged', async () => {
  const { f, rows, pairA, pairB, connections } = await fixture();
  try {
    const foreign = (await f.domainPool.query('SELECT id FROM chat_messages WHERE couple_id=$1 LIMIT 1', [pairB])).rows[0].id;
    const missing = randomUUID(), hidden = rows.at(-1).id;
    requireSuccess(await setVisibility(f, connections[0], pairA, hidden, true));
    const ids = [foreign, hidden, missing];
    for (const detail of ids) {
      const result = await reconcile(f, connections[0], pairA, ids, detail);
      const value = requireSuccess(result);
      assert.deepEqual(value.messages, []); assert.deepEqual(value.unavailableIds, ids);
      assert.deepEqual(value.detail, { id: detail, message: null });
      assert.deepEqual(value.latestVisible, { id: rows.at(-2).id, seq: rows.at(-2).seq });
      assert.equal(result.revision, 1);
      assert.equal(JSON.stringify(value).includes(rows.at(-1).body), false);
    }
    const partner = await reconcile(f, connections[1], pairA, [hidden], hidden);
    assert.equal(partner.revision, 0); assert.equal(requireSuccess(partner).messages[0].body, rows.at(-1).body);
    assert.equal(partner.payload.value.detail.message.body, rows.at(-1).body);
  } finally { await f.close(); }
});

test('real controller reconciliation: old window and external reply detail update in place while composer and edit draft survive', async () => {
  const { f, rows, pairA, connections } = await fixture(); const accounts = [];
  try {
    const a = await account(f); accounts.push(a);
    await a.controller.loadOldest(); a.controller.setReplyTarget(rows[1].id);
    a.controller.setDraft('Link to an old original'); await a.controller.send(); await a.controller.loadLatest();
    const reply = a.controller.getSnapshot().messages.at(-1);
    await a.controller.openReplyTarget(reply.id);
    const ids = a.controller.getSnapshot().messages.map(m => m.id);
    a.controller.setDraft('Protected composer'); a.controller.beginEdit(rows[1].id);
    a.controller.setEditDraft('Protected unpublished edit');
    await edit(f, connections[0], pairA, rows[1].id, 'Other device edited old original');
    await edit(f, connections[0], pairA, rows[265].id, 'Other device edited current window');
    await a.controller.reconciliation.check();
    let view = a.controller.getSnapshot();
    assert.deepEqual(view.messages.map(m => m.id), ids);
    assert.equal(view.messages.find(m => m.id === rows[265].id).body, 'Other device edited current window');
    assert.equal(view.replyDetail.body, 'Other device edited old original');
    assert.equal(view.draft, 'Protected composer'); assert.equal(view.editState.draft, 'Protected unpublished edit');
    await remove(f, connections[0], pairA, rows[1].id, 2);
    await a.controller.reconciliation.check(); view = a.controller.getSnapshot();
    assert.equal(view.replyDetail.body, null); assert.equal(view.replyDetail.version, 3);
    assert.equal(view.draft, 'Protected composer');
    assert.equal(JSON.stringify(view).includes('Other device edited old original'), false);
  } finally { await closeMobile(f, accounts); }
});

test('real controller focus reconciliation is single-flight, read-only and reports latest without moving a 267-message old window', async () => {
  const { f } = await fixture(); const accounts = []; const gate = latch(); let pending;
  try {
    const a = await account(f, 0, { afterResponse: async record => {
      if (record.path.endsWith('/chat/reconcile')) { gate.arrive(); await gate.gate; }
    } }); accounts.push(a);
    await a.controller.loadOldest(); const ids = a.controller.getSnapshot().messages.map(m => m.id);
    const beforeWrites = a.requests.filter(r => r.method !== 'GET').length;
    a.controller.reconciliation.appStateChanged('active');
    assert.equal(a.requests.filter(r => r.path.endsWith('/chat/reconcile')).length, 0);
    a.controller.reconciliation.appStateChanged('background');
    pending = a.controller.reconciliation.appStateChanged('active'); await gate.reached;
    a.controller.reconciliation.appStateChanged('inactive'); a.controller.reconciliation.appStateChanged('active');
    const duplicate = a.controller.reconciliation.check();
    assert.equal(a.requests.filter(r => r.path.endsWith('/chat/reconcile')).length, 1);
    a.controller.setDraft('Focus did not submit this'); gate.release(); await pending; await duplicate; pending = null;
    assert.deepEqual(a.controller.getSnapshot().messages.map(m => m.id), ids);
    assert.equal(a.controller.getSnapshot().draft, 'Focus did not submit this');
    assert.equal(a.controller.reconciliation.getSnapshot().hasNewMessages, true);
    assert.equal(a.requests.filter(r => r.method !== 'GET').length, beforeWrites);
    await a.controller.loadLatest(); assert.notDeepEqual(a.controller.getSnapshot().messages.map(m => m.id), ids);
  } finally { gate.release(); if (pending) await pending; await closeMobile(f, accounts); }
});

test('real controller held reconciliation snapshot cannot restore text after a newer private-hide revision', async () => {
  const { f, rows, pairA, connections } = await fixture(); const accounts = []; const gate = latch(); let pending, hold = true;
  try {
    const a = await account(f, 0, { afterResponse: async record => {
      if (hold && record.path.endsWith('/chat/reconcile')) { hold = false; gate.arrive(); await gate.gate; }
    } }); accounts.push(a);
    await a.controller.loadOldest(); pending = a.controller.reconciliation.check(); await gate.reached;
    requireSuccess(await setVisibility(f, connections[0], pairA, rows[1].id, true));
    await a.controller.visibility.loadLatest();
    a.controller.setDraft('New draft after hide'); gate.release(); await pending; pending = null;
    assert.equal(a.controller.getSnapshot().messages.some(m => m.id === rows[1].id), false);
    assert.equal(JSON.stringify(a.controller.getSnapshot()).includes(rows[1].body), false);
    assert.equal(a.controller.getSnapshot().draft, 'New draft after hide');
    await a.controller.loadOldest();
    assert.equal(a.controller.getSnapshot().messages.some(m => m.id === rows[1].id), false);
  } finally { gate.release(); if (pending) await pending; await closeMobile(f, accounts); }
});

test('real controller held old-account reconciliation cannot replace a new account window or private draft', async () => {
  const { f, pairB } = await fixture(); const accounts = []; const gate = latch(); let pending, hold = true;
  try {
    const a = await account(f, 0, { afterResponse: async record => {
      if (hold && record.path.endsWith('/chat/reconcile')) { hold = false; gate.arrive(); await gate.gate; }
    } }); accounts.push(a);
    pending = a.controller.reconciliation.check(); await gate.reached;
    await a.controller.signOut(); await a.controller.signIn('reply-2@example.test', password);
    a.controller.setDraft('Other account private draft'); const ids = a.controller.getSnapshot().messages.map(m => m.id);
    gate.release(); await pending; pending = null;
    assert.deepEqual(a.controller.getSnapshot().messages.map(m => m.id), ids);
    assert.equal(a.controller.getSnapshot().messages.every(m => m.coupleId === pairB), true);
    assert.equal(a.controller.getSnapshot().draft, 'Other account private draft');
  } finally { gate.release(); if (pending) await pending; await closeMobile(f, accounts); }
});

test('real controller reconciliation during a committed send with held ACK preserves pending command and newer draft', async () => {
  const { f, rows, pairA, connections } = await fixture(); const accounts = []; const gate = latch(); let sending;
  try {
    const a = await account(f, 0, { afterResponse: async record => {
      if (record.method === 'POST' && record.path.endsWith('/chat/messages')) { gate.arrive(); await gate.gate; }
    } }); accounts.push(a);
    await a.controller.loadOldest(); const ids = a.controller.getSnapshot().messages.map(m => m.id);
    a.controller.setDraft('Exact unknown outcome message'); sending = a.controller.send(); await gate.reached;
    a.controller.setDraft('New composer while ACK waits'); a.controller.setReplyTarget(rows[0].id);
    await edit(f, connections[0], pairA, rows[1].id, 'Canonical edit during send');
    await a.controller.reconciliation.check();
    assert.equal(a.controller.getSnapshot().outgoingPending, true);
    assert.equal(a.controller.getSnapshot().draft, 'New composer while ACK waits');
    assert.deepEqual(a.controller.getSnapshot().messages.map(m => m.id), ids);
    gate.release(); await sending; sending = null;
    const view = a.controller.getSnapshot();
    assert.equal(view.outgoingPending, undefined); assert.equal(view.draft, 'New composer while ACK waits');
    assert.equal(view.replyTarget.id, rows[0].id); assert.deepEqual(view.messages.map(m => m.id), ids);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM chat_messages WHERE couple_id=$1 AND body=$2',
      [pairA, 'Exact unknown outcome message'])).rows[0].n, 1);
  } finally { gate.release(); if (sending) await sending; await closeMobile(f, accounts); }
});

for (const switchAccount of [false, true]) {
  test(`real controller reconciliation actual stale-epoch denial ${switchAccount ? 'from old account is ignored' : 'blocks current account even after navigation'}`, async () => {
    const { f, pairB } = await fixture(); const gate = latch(); let a, pending;
    try {
      // Deliberately malformed epoch reaches the real disposable server. This proves
      // transport denial precedence, not a claim of real network-triggered revocation.
      a = await outgoingAccount(f, 0, { transform: request => {
        if (!new URL(request.url).pathname.endsWith('/chat/reconcile')) return request;
        const url = new URL(request.url); url.searchParams.set('membership_epoch', '999');
        return new Request(url, request);
      }, after: async record => {
        if (record.path.endsWith('/chat/reconcile')) { assert.equal(record.status, 409); gate.arrive(); await gate.gate; }
      } });
      pending = a.controller.reconciliation.check(); await gate.reached;
      if (switchAccount) {
        await a.controller.signOut(); await a.controller.signIn('reply-2@example.test', password);
        a.controller.setDraft('New account draft must survive old denial');
      } else await a.controller.loadOldest();
      gate.release(); await pending; pending = null;
      const view = a.controller.getSnapshot();
      if (switchAccount) {
        assert.equal(view.phase, 'signed_in'); assert.equal(view.messages.every(m => m.coupleId === pairB), true);
        assert.equal(view.draft, 'New account draft must survive old denial');
      } else {
        assert.notEqual(view.phase, 'signed_in'); assert.deepEqual(view.messages, []);
      }
    } finally { gate.release(); if (pending) await pending; if (a) await a.controller.signOut(); await f.close(); }
  });
}


test('real controller reconciliation covers distinct off-window detail and selected reply target alongside fifty visible rows', async () => {
  const { f, rows, pairA, connections } = await fixture(); const accounts = [];
  try {
    const a = await account(f); accounts.push(a);
    await a.controller.loadOldest();
    a.controller.setReplyTarget(rows[1].id); a.controller.setDraft('Reference to detail A');
    await a.controller.send(); await a.controller.loadLatest();
    const replyA = a.controller.getSnapshot().messages.at(-1);
    await a.controller.loadOldest(); a.controller.setReplyTarget(rows[3].id);
    a.controller.setDraft('Reference to selection B'); await a.controller.send(); await a.controller.loadLatest();
    const replyB = a.controller.getSnapshot().messages.at(-1);
    await a.controller.openReplyTarget(replyB.id); a.controller.setReplyTarget(rows[3].id);
    await a.controller.openReplyTarget(replyA.id);
    a.controller.setDraft('Draft retains a different off-window selected target');
    const before = a.controller.getSnapshot();
    assert.equal(before.replyDetail.id, rows[1].id); assert.equal(before.replyTarget.id, rows[3].id);
    assert.equal(before.messages.length, 50);
    assert.equal(before.messages.some(m => [rows[1].id, rows[3].id].includes(m.id)), false);
    await edit(f, connections[0], pairA, rows[1].id, 'Updated separate detail A');
    await edit(f, connections[0], pairA, rows[3].id, 'Updated selected target B');
    await a.controller.reconciliation.check();
    const view = a.controller.getSnapshot();
    assert.deepEqual(view.messages.map(m => m.id), before.messages.map(m => m.id));
    assert.equal(view.replyDetail.body, 'Updated separate detail A');
    assert.equal(view.replyTarget.preview, 'Updated selected target B');
    assert.equal(view.draft, 'Draft retains a different off-window selected target');
    const request = await reconcile(f, connections[0], pairA, before.messages.map(m => m.id), rows[1].id, rows[3].id);
    const value = requireSuccess(request);
    assert.equal(value.messages.length, 50); assert.equal(value.detail.message.id, rows[1].id);
    assert.equal(value.replyTarget.message.id, rows[3].id); assert.equal(value.replyTarget.message.body, 'Updated selected target B');
    requireSuccess(await setVisibility(f, connections[0], pairA, rows[3].id, true));
    const hidden = requireSuccess(await reconcile(f, connections[0], pairA, [], rows[1].id, rows[3].id));
    assert.equal(hidden.detail.message.body, 'Updated separate detail A');
    assert.deepEqual(hidden.replyTarget, { id: rows[3].id, message: null });
  } finally { await closeMobile(f, accounts); }
});
