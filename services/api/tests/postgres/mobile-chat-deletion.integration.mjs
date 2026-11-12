import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mobile, closeMobile, password } from './mobile-invitations-fixture.mjs';
import { replyFixture, latch } from './mobile-reply-fixture.mjs';

const fixture = () => replyFixture(251, { enableSyntheticChatDeletion: true });
const openAccount = (f, i, options = {}) => mobile(f, i, { email: `reply-${i}@example.test`, signup: false, ...options });
const deletes = account => account.requests.filter(r => r.method === 'DELETE');
const token = controller => controller.getSnapshot().deleteState.confirmation.token;
async function remove(controller, id) {
  controller.beginDelete(id); await controller.confirmDelete(token(controller));
  assert.equal(controller.getSnapshot().deleteState.status, 'deleted');
}

// All deletion transitions below use the authenticated product DELETE endpoint.
// Seeded chat rows are synthetic; no raw SQL tombstone helper is used here.
test('real PostgreSQL: owner deletes a source outside the current page and both participants see its tombstone', async () => {
  const { f, rows } = await fixture(); const accounts = [];
  try {
    const a = await openAccount(f, 0); accounts.push(a);
    const b = await openAccount(f, 1); accounts.push(b);
    await a.controller.loadOldest(); a.controller.setReplyTarget(rows[1].id);
    a.controller.setDraft('Synthetic reply to my oldest source'); await a.controller.send();
    await a.controller.loadLatest(); const reply = a.controller.getSnapshot().messages.at(-1);
    assert.equal(a.controller.getSnapshot().messages.some(m => m.id === rows[1].id), false);
    await a.controller.openReplyTarget(reply.id);
    assert.equal(a.controller.getSnapshot().replyDetail.id, rows[1].id);
    await remove(a.controller, rows[1].id);
    assert.equal(a.controller.getSnapshot().replyDetail.body, null);
    await a.controller.loadOldest();
    assert.equal(a.controller.getSnapshot().messages.find(m => m.id === rows[1].id).body, null);
    await b.controller.loadLatest(); await b.controller.openReplyTarget(reply.id);
    assert.equal(b.controller.getSnapshot().replyDetail.body, null);
    await b.controller.loadOldest();
    const observed = b.controller.getSnapshot().messages.find(m => m.id === rows[1].id);
    assert.equal(observed.body, null); assert.equal(observed.version, 2);
    assert.equal(typeof observed.deletedAt, 'string'); assert.equal(deletes(a).length, 1);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM chat_messages WHERE id=$1', [rows[1].id])).rows[0].n, 1);
  } finally { await closeMobile(f, accounts); }
});

test('real PostgreSQL: cancel and stale confirmation tokens cannot delete another selected message', async () => {
  const { f, rows } = await fixture(); let a;
  try {
    a = await openAccount(f, 0); await a.controller.loadOldest();
    a.controller.beginDelete(rows[1].id); const cancelled = token(a.controller);
    a.controller.cancelDelete(); await a.controller.confirmDelete(cancelled);
    assert.equal(deletes(a).length, 0);
    a.controller.beginDelete(rows[1].id); const first = token(a.controller);
    a.controller.beginDelete(rows[3].id); const second = token(a.controller);
    assert.notEqual(first, second); await a.controller.confirmDelete(first);
    assert.equal(deletes(a).length, 0, 'old A confirmation cannot confirm B');
    await a.controller.confirmDelete(second);
    const states = (await f.domainPool.query('SELECT id,body,deleted_at FROM chat_messages WHERE id=ANY($1::uuid[])', [[rows[1].id, rows[3].id]])).rows;
    assert.equal(states.find(m => m.id === rows[1].id).body, rows[1].body);
    assert.equal(states.find(m => m.id === rows[3].id).body, null);
    assert.equal(deletes(a).length, 1);
  } finally { await closeMobile(f, a ? [a] : []); }
});

test('real PostgreSQL: held deletion ACK preserves a newer draft and reply selection', async () => {
  const { f, rows } = await fixture(); const gate = latch(); let a, pending;
  try {
    a = await openAccount(f, 0, { afterResponse: async request => {
      if (request.method === 'DELETE') { gate.arrive(); await gate.gate; }
    } });
    await a.controller.loadOldest(); a.controller.beginDelete(rows[1].id);
    pending = a.controller.confirmDelete(token(a.controller)); await gate.reached;
    a.controller.setReplyTarget(rows[0].id); a.controller.setDraft('New private draft while delete ACK waits');
    gate.release(); await pending; pending = null;
    const view = a.controller.getSnapshot();
    assert.equal(view.draft, 'New private draft while delete ACK waits');
    assert.equal(view.replyTarget.id, rows[0].id);
    assert.equal(view.messages.find(m => m.id === rows[1].id).body, null);
    assert.equal(view.deleteState.status, 'deleted');
  } finally { gate.release(); if (pending) await pending; await closeMobile(f, a ? [a] : []); }
});

test('real PostgreSQL: a previous account deletion ACK cannot change the new pair session', async () => {
  const { f, pairB, rows } = await fixture(); const gate = latch(); let a, pending;
  try {
    a = await openAccount(f, 0, { afterResponse: async request => {
      if (request.method === 'DELETE') { gate.arrive(); await gate.gate; }
    } });
    await a.controller.loadOldest(); a.controller.beginDelete(rows[1].id);
    pending = a.controller.confirmDelete(token(a.controller)); await gate.reached;
    await a.controller.signOut(); await a.controller.signIn('reply-2@example.test', password);
    a.controller.setDraft('Different account draft');
    gate.release(); await pending; pending = null;
    const view = a.controller.getSnapshot();
    assert.equal(view.phase, 'signed_in'); assert.equal(view.draft, 'Different account draft');
    assert.equal(view.messages.every(m => m.coupleId === pairB), true);
    assert.equal(view.deleteState?.pendingId == null, true);
    assert.equal(view.replyDetail == null, true);
  } finally { gate.release(); if (pending) await pending; await closeMobile(f, a ? [a] : []); }
});


test('real PostgreSQL: partner and missing targets are uniformly refused without changing the original', async () => {
  const { f, pairA, rows } = await fixture(); let a;
  try {
    a = await openAccount(f, 0); await a.controller.loadOldest();
    a.controller.beginDelete(rows[0].id);
    assert.equal(a.controller.getSnapshot().deleteState?.confirmation == null, true);
    assert.equal(deletes(a).length, 0, 'partner message cannot be selected by own-only UI');
    const request = async id => fetch(`${f.baseURL}/v1/couples/${pairA}/chat/messages/${id}`, {
      method: 'DELETE', headers: { cookie: await a.connection.getCookie(), origin: f.baseURL,
        'content-type': 'application/json', 'idempotency-key': '12345678-1234-4234-8234-123456789abc' },
      body: JSON.stringify({ command_id: '12345678-1234-4234-8234-123456789abc',
        membership_epoch: 1, expected_version: 1, scope: 'everyone' }),
    });
    const partner = await request(rows[0].id), missing = await request(randomUUID());
    assert.equal(partner.status, 409); assert.equal(missing.status, partner.status);
    assert.deepEqual(await partner.json(), await missing.json());
    const original = (await f.domainPool.query('SELECT body,version,deleted_at FROM chat_messages WHERE id=$1', [rows[0].id])).rows[0];
    assert.equal(original.body, rows[0].body); assert.equal(original.version, 1); assert.equal(original.deleted_at, null);
  } finally { await closeMobile(f, a ? [a] : []); }
});

test('real PostgreSQL: lost deletion ACK retries once without a new version, outbox event or resurrected create replay', async () => {
  const { f, pairA, rows } = await fixture(); let a, lose = true; const commands = [];
  const body = 'Synthetic reply deleted through product API';
  try {
    a = await openAccount(f, 0, { beforeRequest: async (record, request) => {
      if (record.method === 'DELETE') commands.push(await request.clone().json());
    }, afterResponse: async record => {
      if (record.method === 'DELETE' && lose) { lose = false; throw new Error('Synthetic lost DELETE ACK'); }
    } });
    await a.controller.loadOldest(); a.controller.setReplyTarget(rows[0].id);
    a.controller.setDraft(body); await a.controller.send(); await a.controller.loadLatest();
    const reply = a.controller.getSnapshot().messages.at(-1);
    const countOutbox = async () => (await f.domainPool.query('SELECT count(*)::int n FROM outbox_events WHERE couple_id=$1', [pairA])).rows[0].n;
    const beforeOutbox = await countOutbox();
    a.controller.beginDelete(reply.id); await a.controller.confirmDelete(token(a.controller));
    assert.equal(a.controller.getSnapshot().deleteState.status, 'unknown');
    a.controller.setDraft('New unsent draft must survive exact delete retry');
    await a.controller.retryDelete();
    assert.equal(a.controller.getSnapshot().deleteState.status, 'deleted');
    assert.equal(a.controller.getSnapshot().draft, 'New unsent draft must survive exact delete retry');
    assert.equal(commands.length, 2); assert.deepEqual(commands[0], commands[1]);
    const row = (await f.domainPool.query('SELECT body,version,deleted_at,client_message_id FROM chat_messages WHERE id=$1', [reply.id])).rows[0];
    assert.equal(row.body, null); assert.equal(row.version, 2); assert.notEqual(row.deleted_at, null);
    assert.equal(await countOutbox(), beforeOutbox, 'deletion does not generate unimplemented notification events');
    const headers = { cookie: await a.connection.getCookie(), origin: f.baseURL,
      'content-type': 'application/json', 'idempotency-key': row.client_message_id };
    const repeat = { client_message_id: row.client_message_id, membership_epoch: 1, body };
    for (const [path, payload] of [['replies', { ...repeat, reply_to_id: rows[0].id }], ['messages', repeat]]) {
      const response = await fetch(`${f.baseURL}/v1/couples/${pairA}/chat/${path}`, {
        method: 'POST', headers, body: JSON.stringify(payload),
      });
      assert.equal(response.ok, false); const result = await response.json();
      assert.equal(result.ok, false); assert.equal(JSON.stringify(result).includes(body), false);
    }
    assert.equal((await f.domainPool.query('SELECT body FROM chat_messages WHERE id=$1', [reply.id])).rows[0].body, null);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM chat_deletion_receipts WHERE message_id=$1', [reply.id])).rows[0].n, 1);
  } finally { await closeMobile(f, a ? [a] : []); }
});

test('real PostgreSQL: second-session deletion canonical immediately scrubs a stale confirmation without another receipt', async () => {
  const { f, pairA, rows } = await fixture(); const accounts = []; const responses = [];
  try {
    const a = await openAccount(f, 0, { afterResponse: async (record, response) => {
      if (record.method === 'DELETE') responses.push({ status: response.status, payload: await response.clone().json() });
    } }); accounts.push(a);
    await a.controller.loadOldest(); a.controller.setReplyTarget(rows[0].id);
    a.controller.setDraft('Synthetic source sent and later deleted by another session'); await a.controller.send();
    await a.controller.loadLatest(); const sent = a.controller.getSnapshot().messages.at(-1);
    assert.equal(a.controller.getSnapshot().outgoing.body, sent.body);
    // Create a reply to make the sent message available in canonical source detail too.
    a.controller.setReplyTarget(sent.id); a.controller.setDraft('Reply referencing the soon-deleted own source');
    await a.controller.send(); await a.controller.loadLatest();
    const referencing = a.controller.getSnapshot().messages.at(-1);
    await a.controller.openReplyTarget(referencing.id);
    assert.equal(a.controller.getSnapshot().replyDetail.id, sent.id);
    a.controller.beginDelete(sent.id); const staleToken = token(a.controller);
    a.controller.setDraft('New unrelated draft survives a stale deletion confirmation');
    const second = await openAccount(f, 0); accounts.push(second);
    await remove(second.controller, sent.id);
    await a.controller.confirmDelete(staleToken);
    assert.equal(responses.length, 1); assert.equal(responses[0].status, 409);
    const conflict = responses[0].payload;
    assert.equal(conflict.ok, false); assert.equal(conflict.error, 'message_deleted');
    assert.equal(conflict.value.message.id, sent.id); assert.equal(conflict.value.message.body, null);
    assert.equal(typeof conflict.value.commandId, 'string');
    const view = a.controller.getSnapshot();
    assert.equal(view.messages.find(m => m.id === sent.id).body, null);
    assert.equal(view.replyDetail.id, sent.id); assert.equal(view.replyDetail.body, null);
    assert.equal(view.draft, 'New unrelated draft survives a stale deletion confirmation');
    assert.equal(JSON.stringify(view).includes(sent.body), false, 'canonical conflict removes every displayed source copy');
    const state = (await f.domainPool.query('SELECT body,version FROM chat_messages WHERE couple_id=$1 AND id=$2', [pairA, sent.id])).rows[0];
    assert.equal(state.body, null); assert.equal(state.version, 2);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM chat_deletion_receipts WHERE message_id=$1', [sent.id])).rows[0].n, 1);
  } finally { await closeMobile(f, accounts); }
});
