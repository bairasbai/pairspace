import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { mobile, closeMobile, password } from './mobile-invitations-fixture.mjs';
import { replyFixture, latch } from './mobile-reply-fixture.mjs';

const fixture = () => replyFixture(251, { enableSyntheticChatEditing: true, enableSyntheticChatDeletion: true });
const account = (f, i = 0, options = {}) => mobile(f, i, { email: `reply-${i}@example.test`, signup: false, ...options });
const patches = a => a.requests.filter(r => r.method === 'PATCH');
async function edit(controller, id, text) {
  controller.beginEdit(id); controller.setEditDraft(text); await controller.saveEdit();
  assert.equal(controller.getSnapshot().editState.status, 'saved');
}
async function remove(controller, id) {
  controller.beginDelete(id); await controller.confirmDelete(controller.getSnapshot().deleteState.confirmation.token);
  assert.equal(controller.getSnapshot().deleteState.status, 'deleted');
}

test('real PostgreSQL: own edits through a window and old-source detail become visible to the partner after refresh', async () => {
  const { f, rows } = await fixture(); const accounts = [];
  try {
    const a = await account(f); accounts.push(a); const b = await account(f, 1); accounts.push(b);
    await a.controller.loadOldest(); await edit(a.controller, rows[1].id, 'Synthetic first revision\nSecond paragraph');
    await b.controller.loadOldest();
    assert.equal(b.controller.getSnapshot().messages.find(m => m.id === rows[1].id).body, 'Synthetic first revision\nSecond paragraph');
    a.controller.setReplyTarget(rows[1].id); a.controller.setDraft('Reference to the old own source');
    await a.controller.send(); await a.controller.loadLatest(); const reply = a.controller.getSnapshot().messages.at(-1);
    assert.equal(a.controller.getSnapshot().messages.some(m => m.id === rows[1].id), false);
    await a.controller.openReplyTarget(reply.id); await edit(a.controller, rows[1].id, 'Revised through canonical detail');
    assert.equal(a.controller.getSnapshot().replyDetail.body, 'Revised through canonical detail');
    assert.equal(a.controller.getSnapshot().replyDetail.version, 3);
    await b.controller.loadLatest(); await b.controller.openReplyTarget(reply.id);
    assert.equal(b.controller.getSnapshot().replyDetail.body, 'Revised through canonical detail');
    assert.equal(b.controller.getSnapshot().messages.length <= 50, true);
  } finally { await closeMobile(f, accounts); }
});

test('real PostgreSQL: edit cancellation sends no PATCH and another owner session CAS conflict preserves the unsaved draft', async () => {
  const { f, rows } = await fixture(); const accounts = [];
  try {
    const a = await account(f); accounts.push(a); const second = await account(f); accounts.push(second);
    await a.controller.loadOldest(); await second.controller.loadOldest();
    a.controller.beginEdit(rows[1].id); a.controller.setEditDraft('Cancelled draft'); a.controller.cancelEdit();
    assert.equal(patches(a).length, 0);
    a.controller.beginEdit(rows[1].id); a.controller.setEditDraft('My protected conflicting draft');
    await edit(second.controller, rows[1].id, 'Other device canonical change');
    await a.controller.saveEdit();
    const conflict = a.controller.getSnapshot().editState;
    assert.equal(conflict.status, 'conflict'); assert.equal(conflict.needsReload, true);
    assert.equal(conflict.draft, 'My protected conflicting draft');
    assert.equal(a.controller.getSnapshot().messages.find(m => m.id === rows[1].id).body, rows[1].body, 'conflict without canonical requires an explicit refresh');
    await a.controller.saveEdit(); assert.equal(patches(a).length, 1, 'no implicit overwrite after CAS conflict');
    await a.controller.reloadEdit();
    assert.equal(a.controller.getSnapshot().editState.draft, 'My protected conflicting draft');
    assert.equal(a.controller.getSnapshot().editState.version, 2);
    assert.equal(a.controller.getSnapshot().messages.find(m => m.id === rows[1].id).body, 'Other device canonical change');
    assert.equal(patches(a).length, 1, 'explicit reload is a read, not a retry write');
    assert.equal((await f.domainPool.query('SELECT version FROM chat_messages WHERE id=$1', [rows[1].id])).rows[0].version, 2);
  } finally { await closeMobile(f, accounts); }
});

test('real PostgreSQL: lost edit ACK retries immutable text once while protecting a newer edit draft', async () => {
  const { f, rows } = await fixture(); let a, lose = true; const commands = [];
  try {
    a = await account(f, 0, { beforeRequest: async (record, request) => {
      if (record.method === 'PATCH') commands.push(await request.clone().json());
    }, afterResponse: async record => {
      if (record.method === 'PATCH' && lose) { lose = false; throw Error('Synthetic lost edit ACK'); }
    } });
    await a.controller.loadOldest(); a.controller.beginEdit(rows[1].id);
    a.controller.setEditDraft('Exact committed edit'); await a.controller.saveEdit();
    assert.equal(a.controller.getSnapshot().editState.status, 'unknown');
    a.controller.setEditDraft('Newer unsubmitted edit draft');
    a.controller.beginEdit(rows[3].id);
    assert.equal(a.controller.getSnapshot().editState.targetId, rows[1].id, 'unknown edit cannot silently change target');
    await a.controller.retryEdit();
    assert.equal(a.controller.getSnapshot().editState.draft, 'Newer unsubmitted edit draft');
    assert.equal(commands.length, 2); assert.deepEqual(commands[0], commands[1]);
    const stored = (await f.domainPool.query('SELECT body,version FROM chat_messages WHERE id=$1', [rows[1].id])).rows[0];
    assert.equal(stored.body, 'Exact committed edit'); assert.equal(stored.version, 2);
  } finally { await closeMobile(f, a ? [a] : []); }
});

test('real PostgreSQL: a live edit ACK held before deletion cannot restore tombstoned text or replace a newer draft', async () => {
  const { f, rows } = await fixture(); const gate = latch(); const accounts = []; let pending;
  const edited = 'Synthetic edited text must never return after deletion';
  try {
    const a = await account(f, 0, { afterResponse: async record => {
      if (record.method === 'PATCH') { gate.arrive(); await gate.gate; }
    } }); accounts.push(a); const second = await account(f); accounts.push(second);
    await a.controller.loadOldest(); a.controller.beginEdit(rows[1].id); a.controller.setEditDraft(edited);
    pending = a.controller.saveEdit(); await gate.reached;
    await second.controller.loadOldest(); await remove(second.controller, rows[1].id);
    a.controller.setDraft('New normal chat draft'); a.controller.setReplyTarget(rows[0].id);
    await a.controller.loadOldest();
    assert.equal(a.controller.getSnapshot().messages.find(m => m.id === rows[1].id).body, null);
    gate.release(); await pending; pending = null;
    const view = a.controller.getSnapshot();
    assert.equal(view.messages.find(m => m.id === rows[1].id).body, null);
    assert.equal(view.draft, 'New normal chat draft'); assert.equal(view.replyTarget.id, rows[0].id);
    assert.equal(JSON.stringify(view).includes(edited), false);
    assert.equal((await f.domainPool.query('SELECT version FROM chat_messages WHERE id=$1', [rows[1].id])).rows[0].version, 3);
  } finally { gate.release(); if (pending) await pending; await closeMobile(f, accounts); }
});

test('real PostgreSQL: old-account edit ACK cannot publish into a different account and pair', async () => {
  const { f, pairB, rows } = await fixture(); const gate = latch(); let a, pending;
  try {
    a = await account(f, 0, { afterResponse: async record => {
      if (record.method === 'PATCH') { gate.arrive(); await gate.gate; }
    } });
    await a.controller.loadOldest(); a.controller.beginEdit(rows[1].id); a.controller.setEditDraft('Old account edited message');
    pending = a.controller.saveEdit(); await gate.reached;
    await a.controller.signOut(); await a.controller.signIn('reply-2@example.test', password);
    a.controller.setDraft('New account private draft'); gate.release(); await pending; pending = null;
    const view = a.controller.getSnapshot();
    assert.equal(view.messages.every(m => m.coupleId === pairB), true);
    assert.equal(view.draft, 'New account private draft'); assert.equal(view.editState, undefined, 'new account has no retained edit state');
    assert.equal(JSON.stringify(view).includes('Old account edited message'), false);
  } finally { gate.release(); if (pending) await pending; await closeMobile(f, a ? [a] : []); }
});

test('real PostgreSQL: original send and reply retries after edits return current text without target or command retargeting', async () => {
  const { f, pairA, rows } = await fixture(); let a; const edits = [];
  const originalPlain = 'Original synthetic plain text', originalReply = 'Original synthetic reply text';
  try {
    a = await account(f, 0, { beforeRequest: async (record, request) => {
      if (record.method === 'PATCH') edits.push({ path: new URL(request.url).pathname, body: await request.clone().json() });
    } });
    a.controller.setDraft(originalPlain); await a.controller.send(); await a.controller.loadLatest();
    const plain = a.controller.getSnapshot().messages.at(-1);
    a.controller.setReplyTarget(plain.id); a.controller.setDraft(originalReply); await a.controller.send();
    await a.controller.loadLatest(); const reply = a.controller.getSnapshot().messages.at(-1);
    await edit(a.controller, plain.id, 'Current edited plain text');
    await edit(a.controller, reply.id, 'Current edited reply text');
    const request = async (path, body, method = 'POST') => fetch(`${f.baseURL}${path}`, {
      method, headers: { cookie: await a.connection.getCookie(), origin: f.baseURL,
        'content-type': 'application/json', 'idempotency-key': body.client_message_id ?? body.command_id },
      body: JSON.stringify(body),
    });
    const original = (message, body) => ({ membership_epoch: 1, client_message_id: message.clientId, body });
    for (const [route, payload, expected] of [
      ['messages', original(plain, originalPlain), 'Current edited plain text'],
      ['replies', { ...original(reply, originalReply), reply_to_id: plain.id }, 'Current edited reply text'],
    ]) {
      const response = await request(`/v1/couples/${pairA}/chat/${route}`, payload);
      assert.equal(response.status, 200); const result = await response.json();
      assert.equal(result.value.replay, true); assert.equal(result.value.message.body, expected);
      assert.equal(result.value.message.version, 2);
    }
    for (const [route, payload] of [
      ['replies', { ...original(reply, originalReply), reply_to_id: rows[1].id }],
      ['messages', original(reply, originalReply)],
      ['replies', { ...original(plain, originalPlain), reply_to_id: rows[1].id }],
    ]) {
      const response = await request(`/v1/couples/${pairA}/chat/${route}`, payload);
      assert.equal(response.status, 409); assert.equal((await response.json()).error, 'idempotency_conflict');
    }
    assert.equal(edits.length, 2);
    const reused = await request(`/v1/couples/${pairA}/chat/messages/${plain.id}`, edits[1].body, 'PATCH');
    assert.equal(reused.status, 409); assert.equal((await reused.json()).error, 'idempotency_conflict');
    const state = (await f.domainPool.query('SELECT version FROM chat_messages WHERE id=ANY($1::uuid[])', [[plain.id, reply.id]])).rows;
    assert.deepEqual(state.map(m => m.version), [2, 2]);
  } finally { await closeMobile(f, a ? [a] : []); }
});

test('real PostgreSQL: missing, foreign-pair and partner edit targets are uniformly unavailable', async () => {
  const { f, pairA, pairB, rows } = await fixture(); let a;
  try {
    a = await account(f); await a.controller.loadOldest(); a.controller.beginEdit(rows[0].id);
    assert.equal(a.controller.getSnapshot().editState, undefined, 'non-owner selection creates no edit state');
    assert.equal(patches(a).length, 0);
    const foreign = (await f.domainPool.query('SELECT id FROM chat_messages WHERE couple_id=$1 ORDER BY seq LIMIT 1', [pairB])).rows[0].id;
    const command = randomUUID(), results = [];
    for (const id of [rows[0].id, foreign, randomUUID()]) {
      const response = await fetch(`${f.baseURL}/v1/couples/${pairA}/chat/messages/${id}`, {
        method: 'PATCH', headers: { cookie: await a.connection.getCookie(), origin: f.baseURL,
          'content-type': 'application/json', 'idempotency-key': command },
        body: JSON.stringify({ membership_epoch: 1, command_id: command, expected_version: 1, body: 'Unauthorized synthetic change' }),
      });
      assert.equal(response.status, 409); results.push(await response.json());
    }
    assert.deepEqual(results[0], results[1]); assert.deepEqual(results[1], results[2]);
    assert.equal(results[0].error, 'message_unavailable');
    assert.equal((await f.domainPool.query('SELECT body FROM chat_messages WHERE id=$1', [rows[0].id])).rows[0].body, rows[0].body);
  } finally { await closeMobile(f, a ? [a] : []); }
});

test('real PostgreSQL: deleted-message edit conflict publishes its canonical tombstone without restoring draft text', async () => {
  const { f, rows } = await fixture(); const accounts = []; const responses = [];
  try {
    const a = await account(f, 0, { afterResponse: async (record, response) => {
      if (record.method === 'PATCH') responses.push({ status: response.status, value: await response.clone().json() });
    } }); accounts.push(a); const second = await account(f); accounts.push(second);
    await a.controller.loadOldest(); await second.controller.loadOldest();
    a.controller.beginEdit(rows[1].id); a.controller.setEditDraft('Stale edit attempt after remote deletion');
    a.controller.setDraft('Unrelated compose draft');
    await remove(second.controller, rows[1].id); await a.controller.saveEdit();
    assert.equal(responses.length, 1); assert.equal(responses[0].status, 409);
    assert.equal(responses[0].value.error, 'message_deleted');
    assert.equal(responses[0].value.value.message.body, null);
    const view = a.controller.getSnapshot();
    assert.equal(view.messages.find(m => m.id === rows[1].id).body, null);
    assert.equal(view.editState.status, 'deleted'); assert.equal(view.draft, 'Unrelated compose draft');
    assert.equal((await f.domainPool.query('SELECT version FROM chat_messages WHERE id=$1', [rows[1].id])).rows[0].version, 2);
  } finally { await closeMobile(f, accounts); }
});

test('real PostgreSQL: lost original create ACK replays current edited canonical through the real controller queue', async () => {
  const { f, pairA, rows } = await fixture(); const accounts = [];
  let losePath = null; const commands = [];
  try {
    const a = await account(f, 0, { beforeRequest: async (record, request) => {
      if (record.method === 'POST' && /\/chat\/(messages|replies)$/.test(record.path)) {
        commands.push({ path: record.path, body: await request.clone().json() });
      }
    }, afterResponse: async record => {
      if (record.method === 'POST' && record.path === losePath) {
        losePath = null; throw Error('Synthetic original create ACK lost after commit');
      }
    } }); accounts.push(a);
    const second = await account(f); accounts.push(second);
    for (const kind of ['messages', 'replies']) {
      await a.controller.loadOldest(); a.controller.cancelReply();
      if (kind === 'replies') a.controller.setReplyTarget(rows[0].id);
      const original = `Original lost-ACK ${kind} body`, edited = `Current canonical ${kind} after another device edit`;
      losePath = `/v1/couples/${pairA}/chat/${kind}`;
      const start = commands.length;
      a.controller.setDraft(original); await a.controller.send();
      assert.equal(a.controller.getSnapshot().outgoing.status, 'retry');
      assert.equal(commands.length, start + 1);
      const sentCommand = commands[start];
      await second.controller.loadLatest(); const committed = second.controller.getSnapshot().messages.at(-1);
      assert.equal(committed.body, original); assert.equal(committed.clientId, sentCommand.body.client_message_id);
      await edit(second.controller, committed.id, edited);
      a.controller.setReplyTarget(rows[3].id); a.controller.setDraft(`Newer ${kind} composer draft`);
      await a.controller.send();
      const view = a.controller.getSnapshot();
      assert.equal(view.outgoing.status, 'sent'); assert.equal(view.outgoing.body, edited);
      assert.equal(view.draft, `Newer ${kind} composer draft`); assert.equal(view.replyTarget.id, rows[3].id);
      assert.equal(commands.length, start + 2); assert.deepEqual(commands[start + 1], sentCommand);
      const stored = (await f.domainPool.query('SELECT body,version,reply_to_id FROM chat_messages WHERE couple_id=$1 AND client_message_id=$2',
        [pairA, sentCommand.body.client_message_id])).rows;
      assert.equal(stored.length, 1); assert.equal(stored[0].body, edited); assert.equal(stored[0].version, 2);
      assert.equal(stored[0].reply_to_id, kind === 'replies' ? rows[0].id : null);
      const changedPayload = await fetch(`${f.baseURL}${sentCommand.path}`, {
        method: 'POST', headers: { cookie: await a.connection.getCookie(), origin: f.baseURL,
          'content-type': 'application/json', 'idempotency-key': sentCommand.body.client_message_id },
        body: JSON.stringify({ ...sentCommand.body, body: edited }),
      });
      assert.equal(changedPayload.status, 409);
      assert.equal((await changedPayload.json()).error, 'idempotency_conflict', 'current body is not the immutable original create payload');
    }
  } finally { await closeMobile(f, accounts); }
});

test('real PostgreSQL: normalized no-op leaves fresh messages unmarked and true edits keep canonical quote previews current', async () => {
  const { f, pairA } = await fixture(); const accounts = [];
  const original = 'Synthetic café\nOriginal second line', changed = 'Synthetic revised café\nChanged second line';
  try {
    const a = await account(f); accounts.push(a); const b = await account(f, 1); accounts.push(b);
    a.controller.setDraft(original); await a.controller.send(); await a.controller.loadLatest();
    const source = a.controller.getSnapshot().messages.at(-1);
    a.controller.setReplyTarget(source.id); a.controller.setDraft('Reference remains linked, not copied');
    await a.controller.send(); await a.controller.loadLatest(); const reference = a.controller.getSnapshot().messages.at(-1);
    await a.controller.openReplyTarget(reference.id); a.controller.setReplyTarget(source.id);
    const outboxBefore = (await f.domainPool.query('SELECT count(*)::int n FROM outbox_events WHERE couple_id=$1', [pairA])).rows[0].n;
    const verify = async (body, version) => {
      await b.controller.loadLatest(); await b.controller.openReplyTarget(reference.id);
      for (const current of [a, b]) {
        assert.equal(current.controller.getSnapshot().messages.find(m => m.id === source.id).body, body);
        assert.equal(current.controller.getSnapshot().messages.find(m => m.id === source.id).version, version);
        assert.equal(current.controller.getSnapshot().replyDetail.body, body);
        assert.equal(current.controller.getSnapshot().replyDetail.version, version);
        // The UI's edited label is derived from live canonical version > 1.
        assert.equal(current.controller.getSnapshot().replyDetail.version > 1, version > 1);
      }
      assert.equal(a.controller.getSnapshot().replyTarget.id, source.id);
      assert.equal(a.controller.getSnapshot().replyTarget.preview, body);
      const stored = (await f.domainPool.query('SELECT body,version FROM chat_messages WHERE id=$1', [source.id])).rows[0];
      assert.equal(stored.body, body); assert.equal(stored.version, version);
    };
    await edit(a.controller, source.id, original.replace('é', 'e\u0301').replace('\n', '\r\n'));
    await verify(original, 1);
    await edit(a.controller, source.id, changed); await verify(changed, 2);
    await edit(a.controller, source.id, changed.replace('é', 'e\u0301').replace('\n', '\r\n'));
    await verify(changed, 2);
    await edit(a.controller, source.id, original); await verify(original, 3);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM outbox_events WHERE couple_id=$1', [pairA])).rows[0].n, outboxBefore,
      'edits and no-ops do not add notification/outbox events; previously delivered notifications are outside this feature');
    const linked = (await f.domainPool.query('SELECT body,reply_to_id FROM chat_messages WHERE id=$1', [reference.id])).rows[0];
    assert.equal(linked.body, 'Reference remains linked, not copied'); assert.equal(linked.reply_to_id, source.id);
  } finally { await closeMobile(f, accounts); }
});
