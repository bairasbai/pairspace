import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { mobile, closeMobile, password } from './mobile-invitations-fixture.mjs';
import { latch } from './mobile-reply-fixture.mjs';
import { visibilityFixture, visibilityRequest as request, setVisibility, requireSuccess } from './chat-visibility-http-fixture.mjs';
const account = (f, i = 0, options = {}) => mobile(f, i, { email: `reply-${i}@example.test`, signup: false, ...options });

// Synthetic accounts only. All hiding/restoration uses product PUT; SQL is read-only evidence.
test('real HTTP/PostgreSQL: private hiding changes only its actor projection and reveals no source body', async () => {
  const { f, pairA, connections, rows } = await visibilityFixture();
  try {
    const query = { direction: 'oldest' }, readId = randomUUID();
    const before = await request(f, connections[1], pairA, 'reply-window', { query, readId }); requireSuccess(before);
    const events = (await f.domainPool.query('SELECT count(*)::int n FROM outbox_events')).rows[0].n;
    const hidden = await setVisibility(f, connections[0], pairA, rows[0].id, true); requireSuccess(hidden);
    assert.equal(hidden.revision, 1);
    const after = await request(f, connections[1], pairA, 'reply-window', { query, readId });
    assert.deepEqual(after, before, 'partner DTO and revision are unchanged by private hiding');
    const own = await request(f, connections[0], pairA, 'reply-window', { query });
    assert.equal(requireSuccess(own).messages.some(m => m.id === rows[0].id), false);
    assert.equal(own.revision, 1);
    const legacyWindow = requireSuccess(await request(f, connections[0], pairA, 'history-window', { query, opted: false }));
    assert.equal(legacyWindow.messages.some(m => m.id === rows[0].id), false);
    const legacy = await fetch(`${f.baseURL}/v1/couples/${pairA}/chat/messages?membership_epoch=1&limit=50&beforeSeq=7`,
      { headers: { cookie: await connections[0].getCookie(), origin: f.baseURL } });
    assert.equal(legacy.status, 200);
    const legacyBody = await legacy.json();
    assert.equal(legacyBody.value.messages.some(m => m.id === rows[0].id), false);
    assert.equal(JSON.stringify(legacyBody).includes(rows[0].body), false);
    const detail = await request(f, connections[0], pairA, 'message-detail', { query: { message_id: rows[0].id } });
    assert.equal(detail.status, 409); assert.equal(JSON.stringify(detail.payload).includes(rows[0].body), false);
    const metadata = await request(f, connections[0], pairA, `messages/${rows[0].id}/visibility`);
    assert.deepEqual(requireSuccess(metadata).visibility, { messageId: rows[0].id, hidden: true, version: 1 });
    const history = requireSuccess(await request(f, connections[0], pairA, 'hidden-window', { query: { direction: 'latest' } }));
    assert.equal(history.messages.length, 1); assert.equal(history.messages[0].id, rows[0].id);
    assert.equal(Object.hasOwn(history.messages[0], 'body'), false);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM outbox_events')).rows[0].n, events);
    assert.equal((await f.domainPool.query('SELECT body FROM chat_messages WHERE id=$1', [rows[0].id])).rows[0].body, rows[0].body);
  } finally { await f.close(); }
});

test('real HTTP/PostgreSQL: 61 hidden metadata entries navigate completely and stale anchors refuse changed visibility', async () => {
  const { f, pairA, connections, rows } = await visibilityFixture();
  try {
    for (const row of rows.slice(0, 61)) requireSuccess(await setVisibility(f, connections[0], pairA, row.id, true));
    const first = await request(f, connections[0], pairA, 'hidden-window', { query: { direction: 'oldest' } });
    const a = requireSuccess(first); assert.equal(a.messages.length, 50); assert.equal(first.revision, 61);
    const next = await request(f, connections[0], pairA, 'hidden-window', { query: { direction: 'after',
      anchor_id: a.newerCursor.id, anchor_seq: a.newerCursor.seq, visibility_revision: first.revision } });
    const b = requireSuccess(next); assert.equal(b.messages.length, 11);
    const ids = [...a.messages, ...b.messages].map(m => m.id);
    assert.deepEqual(ids, rows.slice(0, 61).map(m => m.id)); assert.equal(new Set(ids).size, 61);
    assert.equal(JSON.stringify([...a.messages, ...b.messages]).includes('Synthetic source'), false);
    const previous = requireSuccess(await request(f, connections[0], pairA, 'hidden-window', { query: { direction: 'before',
      anchor_id: b.olderCursor.id, anchor_seq: b.olderCursor.seq, visibility_revision: next.revision } }));
    assert.deepEqual(previous.messages.map(m => m.id), a.messages.map(m => m.id));
    requireSuccess(await setVisibility(f, connections[0], pairA, rows[60].id, false, 1));
    const stale = await request(f, connections[0], pairA, 'hidden-window', { query: { direction: 'after',
      anchor_id: a.newerCursor.id, anchor_seq: a.newerCursor.seq, visibility_revision: first.revision } });
    assert.equal(stale.status, 409); assert.equal(stale.payload.error, 'visibility_changed');
  } finally { await f.close(); }
});

test('real HTTP/PostgreSQL: visibility receipts replay current state while stale second-session CAS cannot overwrite it', async () => {
  const { f, pairA, connections, rows } = await visibilityFixture(); let second;
  try {
    second = await account(f); const command = randomUUID();
    const hidden = await setVisibility(f, connections[0], pairA, rows[0].id, true, 0, command);
    assert.equal(requireSuccess(hidden).visibility.version, 1);
    const conflict = await setVisibility(f, second.connection, pairA, rows[0].id, false, 0);
    assert.equal(conflict.status, 409); assert.equal(conflict.payload.error, 'version_conflict');
    const metadata = requireSuccess(await request(f, second.connection, pairA, `messages/${rows[0].id}/visibility`));
    requireSuccess(await setVisibility(f, second.connection, pairA, rows[0].id, false, metadata.visibility.version));
    const replay = await setVisibility(f, connections[0], pairA, rows[0].id, true, 0, command);
    const value = requireSuccess(replay); assert.equal(value.replay, true);
    assert.deepEqual(value.visibility, { messageId: rows[0].id, hidden: false, version: 2 });
    assert.equal(replay.revision, 2);
    const altered = await setVisibility(f, connections[0], pairA, rows[0].id, false, 0, command);
    assert.equal(altered.status, 409); assert.equal(altered.payload.error, 'idempotency_conflict');
  } finally { await closeMobile(f, second ? [second] : []); }
});

test('real HTTP/PostgreSQL: restoration reads current edited text and never reverses a terminal deletion', async () => {
  const { f, pairA, connections, rows } = await visibilityFixture();
  try {
    const source = rows[0]; // Owned by account 1; account 0 hides its own projection only.
    requireSuccess(await setVisibility(f, connections[0], pairA, source.id, true));
    const changed = 'Synthetic canonical text changed while privately hidden';
    requireSuccess(await request(f, connections[1], pairA, `messages/${source.id}`, { method: 'PATCH', body: {
      membership_epoch: 1, command_id: randomUUID(), expected_version: 1, body: changed,
    } }));
    requireSuccess(await setVisibility(f, connections[0], pairA, source.id, false, 1));
    const restored = requireSuccess(await request(f, connections[0], pairA, 'message-detail', { query: { message_id: source.id } })).message;
    assert.equal(restored.body, changed); assert.equal(restored.version, 2);
    requireSuccess(await setVisibility(f, connections[0], pairA, source.id, true, 2));
    requireSuccess(await request(f, connections[1], pairA, `messages/${source.id}`, { method: 'DELETE', body: {
      membership_epoch: 1, command_id: randomUUID(), expected_version: 2, scope: 'everyone',
    } }));
    requireSuccess(await setVisibility(f, connections[0], pairA, source.id, false, 3));
    const terminal = requireSuccess(await request(f, connections[0], pairA, 'message-detail', { query: { message_id: source.id } })).message;
    assert.equal(terminal.body, null); assert.equal(terminal.version, 3); assert.equal(typeof terminal.deletedAt, 'string');
  } finally { await f.close(); }
});

test('real HTTP/PostgreSQL: a held pre-hide response retains its old revision and a later read returns the new projection', async () => {
  const { f, pairA, connections, rows } = await visibilityFixture(); const gate = latch(); let pending;
  try {
    pending = (async () => {
      const result = await request(f, connections[0], pairA, 'reply-window', { query: { direction: 'oldest' } });
      gate.arrive(); await gate.gate; return result;
    })();
    await gate.reached;
    requireSuccess(await setVisibility(f, connections[0], pairA, rows[0].id, true));
    const after = await request(f, connections[0], pairA, 'reply-window', { query: { direction: 'oldest' } });
    assert.equal(requireSuccess(after).messages.some(m => m.id === rows[0].id), false); assert.equal(after.revision, 1);
    gate.release(); const old = await pending; pending = null;
    assert.equal(old.revision, 0); assert.equal(requireSuccess(old).messages.some(m => m.id === rows[0].id && m.body === rows[0].body), true);
    assert.notEqual(old.revision, after.revision, 'old body cannot be labelled with the post-hide revision');
  } finally { gate.release(); if (pending) await pending; await f.close(); }
});

test('real mobile/HTTP/PostgreSQL: a held old-revision body read cannot republish a privately hidden message', async () => {
  const { f, rows } = await visibilityFixture(); const gate = latch(); let a, pending, hold = false;
  try {
    a = await account(f, 0, { afterResponse: async record => {
      if (hold && record.method === 'GET' && record.path.endsWith('/chat/reply-window')) {
        hold = false; gate.arrive(); await gate.gate;
      }
    } });
    const target = rows.at(-1); assert.equal(a.controller.getSnapshot().messages.some(m => m.id === target.id), true);
    a.controller.setDraft('Unrelated draft must survive private hiding'); a.controller.setReplyTarget(target.id);
    hold = true; pending = a.controller.loadLatest(); await gate.reached;
    await a.controller.visibility.beginHide(target.id);
    const confirmation = a.controller.visibility.getSnapshot().confirmation;
    assert.equal(confirmation.messageId, target.id); assert.equal(confirmation.hidden, true);
    await a.controller.visibility.confirm(confirmation.token);
    gate.release(); await pending; pending = null;
    let view = a.controller.getSnapshot();
    assert.equal(view.messages.some(m => m.id === target.id), false);
    assert.equal(view.replyTarget?.id === target.id, false);
    assert.equal(view.draft, 'Unrelated draft must survive private hiding');
    assert.equal(JSON.stringify(view).includes(target.body), false);
    await a.controller.loadLatest(); view = a.controller.getSnapshot();
    assert.equal(view.messages.length, 50); assert.equal(view.messages.some(m => m.id === target.id), false);
    await a.controller.visibility.loadLatest();
    assert.equal(a.controller.visibility.getSnapshot().history.messages[0].id, target.id);
  } finally { gate.release(); if (pending) await pending; await closeMobile(f, a ? [a] : []); }
});

test('real mobile/HTTP/PostgreSQL: lost visibility ACK retries immutable command and adopts newer restored state', async () => {
  const { f, pairA, connections, rows } = await visibilityFixture(); let a, lose = true; const commands = [];
  try {
    a = await account(f, 0, { beforeRequest: async (record, req) => {
      if (record.method === 'PUT' && record.path.endsWith('/hidden')) commands.push(await req.clone().json());
    }, afterResponse: async record => {
      if (lose && record.method === 'PUT' && record.path.endsWith('/hidden')) { lose = false; throw Error('Synthetic lost visibility ACK'); }
    } });
    const target = rows.at(-1); await a.controller.visibility.beginHide(target.id);
    await a.controller.visibility.confirm(a.controller.visibility.getSnapshot().confirmation.token);
    assert.equal(a.controller.visibility.getSnapshot().pendingId != null, true);
    a.controller.setDraft('New draft survives exact hide retry after remote restore');
    requireSuccess(await setVisibility(f, connections[0], pairA, target.id, false, 1));
    await a.controller.visibility.retry();
    assert.equal(commands.length, 2); assert.deepEqual(commands[0], commands[1]);
    assert.equal(a.controller.visibility.getSnapshot().pendingId == null, true);
    assert.equal(a.controller.getSnapshot().draft, 'New draft survives exact hide retry after remote restore');
    await a.controller.loadLatest();
    assert.equal(a.controller.getSnapshot().messages.find(m => m.id === target.id).body, target.body);
    const metadata = requireSuccess(await request(f, connections[0], pairA, `messages/${target.id}/visibility`));
    assert.deepEqual(metadata.visibility, { messageId: target.id, hidden: false, version: 2 });
  } finally { await closeMobile(f, a ? [a] : []); }
});

test('real mobile/HTTP/PostgreSQL: old-session visibility ACK does not clear a newly signed-in pair draft', async () => {
  const { f, pairB, rows } = await visibilityFixture(); const gate = latch(); let a, pending;
  try {
    a = await account(f, 0, { afterResponse: async record => {
      if (record.method === 'PUT' && record.path.endsWith('/hidden')) { gate.arrive(); await gate.gate; }
    } });
    await a.controller.visibility.beginHide(rows.at(-1).id);
    pending = a.controller.visibility.confirm(a.controller.visibility.getSnapshot().confirmation.token); await gate.reached;
    await a.controller.signOut(); await a.controller.signIn('reply-2@example.test', password);
    a.controller.setDraft('Different account private composer');
    gate.release(); await pending; pending = null;
    const view = a.controller.getSnapshot();
    assert.equal(view.phase, 'signed_in'); assert.equal(view.draft, 'Different account private composer');
    assert.equal(view.messages.length, 50); assert.equal(view.messages.every(m => m.coupleId === pairB), true);
    assert.equal(a.controller.visibility.getSnapshot().pendingId == null, true);
  } finally { gate.release(); if (pending) await pending; await closeMobile(f, a ? [a] : []); }
});

test('real mobile/HTTP/PostgreSQL: hidden committed create retries resolve without a body or a duplicate message', async () => {
  const { f, pairA, connections, rows } = await visibilityFixture(); let a, losePath = null; const commands = [];
  try {
    a = await account(f, 0, { beforeRequest: async (record, req) => {
      if (record.method === 'POST' && /\/chat\/(messages|replies)$/.test(record.path)) commands.push(await req.clone().json());
    }, afterResponse: async record => {
      if (record.method === 'POST' && record.path === losePath) { losePath = null; throw Error('Synthetic create ACK lost'); }
    } });
    for (const kind of ['messages', 'replies']) {
      await a.controller.loadOldest(); a.controller.cancelReply();
      if (kind === 'replies') a.controller.setReplyTarget(rows[0].id);
      const privateText = `Synthetic hidden committed ${kind}`, start = commands.length;
      a.controller.setDraft(privateText); losePath = `/v1/couples/${pairA}/chat/${kind}`;
      await a.controller.send(); assert.equal(a.controller.getSnapshot().outgoing.status, 'retry');
      const command = commands[start];
      const committed = (await f.domainPool.query('SELECT id FROM chat_messages WHERE couple_id=$1 AND client_message_id=$2', [pairA, command.client_message_id])).rows;
      assert.equal(committed.length, 1); requireSuccess(await setVisibility(f, connections[0], pairA, committed[0].id, true));
      a.controller.setDraft(`Unrelated newer ${kind} draft`); await a.controller.send();
      const view = a.controller.getSnapshot();
      assert.equal(view.draft, `Unrelated newer ${kind} draft`);
      assert.equal(view.outgoing == null || view.outgoing.body == null, true, 'hidden successful ACK exposes no outgoing body');
      assert.equal(JSON.stringify(view).includes(privateText), false);
      assert.equal(commands.length, start + 2); assert.deepEqual(commands[start + 1], command);
      assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM chat_messages WHERE couple_id=$1 AND client_message_id=$2', [pairA, command.client_message_id])).rows[0].n, 1);
      const legacy = await request(f, connections[0], pairA, kind, { method: 'POST', opted: false, body: command });
      assert.equal(legacy.status >= 400, true); assert.equal(JSON.stringify(legacy.payload).includes(privateText), false);
    }
  } finally { await closeMobile(f, a ? [a] : []); }
});

test('real mobile/HTTP/PostgreSQL: hidden deleted create replay remains terminal after restoration and a delayed live page', async () => {
  const { f, pairA, connections } = await visibilityFixture(); const gate = latch();
  let a, pendingRead, replayAck, loseCreate = true, holdRead = false; const posts = [];
  const oldBody = 'Synthetic hidden deleted original must not return';
  try {
    a = await account(f, 0, { beforeRequest: async (record, req) => {
      if (record.method === 'POST' && record.path.endsWith('/chat/messages')) posts.push(await req.clone().json());
    }, afterResponse: async (record, response) => {
      if (loseCreate && record.method === 'POST' && record.path.endsWith('/chat/messages')) {
        loseCreate = false; throw Error('Synthetic lost original create ACK');
      }
      if (record.method === 'POST' && record.path.endsWith('/chat/messages')) replayAck = await response.clone().json();
      if (holdRead && record.method === 'GET' && record.path.endsWith('/chat/reply-window')) {
        holdRead = false; gate.arrive(); await gate.gate;
      }
    } });
    a.controller.setDraft(oldBody); await a.controller.send();
    assert.equal(a.controller.getSnapshot().outgoing.status, 'retry');
    const command = posts[0];
    const committed = (await f.domainPool.query('SELECT id FROM chat_messages WHERE couple_id=$1 AND client_message_id=$2', [pairA, command.client_message_id])).rows[0];
    holdRead = true; pendingRead = a.controller.loadLatest(); await gate.reached;
    // Fresh mutations require visible targets: delete first, then hide the retained tombstone.
    requireSuccess(await request(f, connections[0], pairA, `messages/${committed.id}`, { method: 'DELETE', body: {
      membership_epoch: 1, command_id: randomUUID(), expected_version: 1, scope: 'everyone',
    } }));
    requireSuccess(await setVisibility(f, connections[0], pairA, committed.id, true));
    a.controller.setDraft('Unrelated draft survives terminal hidden ACK'); await a.controller.send();
    assert.equal(posts.length, 2); assert.deepEqual(posts[1], command);
    assert.equal(replayAck.ok, true); assert.equal(replayAck.value.replay, true);
    assert.equal(replayAck.value.hiddenMessage.id, committed.id);
    assert.equal(replayAck.value.hiddenMessage.version, 2);
    assert.equal(typeof replayAck.value.hiddenMessage.deletedAt, 'string');
    assert.equal(Object.hasOwn(replayAck.value.hiddenMessage, 'body'), false);
    assert.equal(a.controller.getSnapshot().hiddenAcknowledged, undefined,
      'terminal deletion cleanup takes precedence over the live hidden-success notice');
    assert.equal(a.controller.getSnapshot().outgoing, undefined);
    assert.equal(JSON.stringify(a.controller.getSnapshot()).includes(oldBody), false);
    requireSuccess(await setVisibility(f, connections[0], pairA, committed.id, false, 1));
    // The first body read discovering a higher revision is intentionally discarded.
    await a.controller.loadLatest(); await a.controller.loadLatest();
    const restored = a.controller.getSnapshot().messages.find(m => m.id === committed.id);
    assert.equal(restored.body, null); assert.equal(restored.version, 2); assert.equal(typeof restored.deletedAt, 'string');
    gate.release(); await pendingRead; pendingRead = null;
    const final = a.controller.getSnapshot();
    assert.equal(final.messages.find(m => m.id === committed.id).body, null);
    assert.equal(final.draft, 'Unrelated draft survives terminal hidden ACK');
    assert.equal(JSON.stringify(final).includes(oldBody), false);
  } finally { gate.release(); if (pendingRead) await pendingRead; await closeMobile(f, a ? [a] : []); }
});

test('real HTTP/PostgreSQL: hiding boundaries and an entire middle page leaves complete visible-window traversal and restoration', async () => {
  const { f, pairA, connections, rows } = await visibilityFixture();
  const walk = async connection => {
    const messages = [], revisions = [];
    let query = { direction: 'latest' };
    for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
      const response = await request(f, connection, pairA, 'reply-window', { query });
      const page = requireSuccess(response); revisions.push(response.revision);
      assert.equal(page.messages.length > 0 && page.messages.length <= 50, true, 'filtered pages cannot create an empty false end');
      if (pageNumber === 0) assert.equal(page.hasNewer, false);
      else assert.equal(page.hasNewer, true);
      messages.push(...page.messages);
      if (!page.hasOlder) {
        assert.equal(page.olderCursor, null);
        assert.equal(new Set(messages.map(m => m.id)).size, messages.length, 'no duplicate visible message across windows');
        return { messages: messages.sort((a, b) => a.seq - b.seq), revisions };
      }
      assert.notEqual(page.olderCursor, null);
      query = { direction: 'before', anchor_id: page.olderCursor.id, anchor_seq: page.olderCursor.seq };
    }
    assert.fail('bounded fixture traversal did not terminate');
  };
  try {
    const partnerBefore = await walk(connections[1]);
    // Boundaries of the original first/last windows plus all 50 rows of a middle window.
    const hidden = [rows[0], rows[49], ...rows.slice(100, 150), rows[250]];
    const hiddenIds = new Set(hidden.map(m => m.id));
    for (const row of hidden) requireSuccess(await setVisibility(f, connections[0], pairA, row.id, true));
    const ownHidden = await walk(connections[0]);
    assert.deepEqual(ownHidden.messages.map(m => m.id), rows.filter(m => !hiddenIds.has(m.id)).map(m => m.id));
    assert.equal(ownHidden.revisions.every(r => r === hidden.length), true);
    assert.deepEqual(await walk(connections[1]), partnerBefore, 'partner keeps every row and unchanged private revision');
    for (const row of hidden) requireSuccess(await setVisibility(f, connections[0], pairA, row.id, false, 1));
    const restored = await walk(connections[0]);
    assert.deepEqual(restored.messages.map(m => m.id), rows.map(m => m.id));
    assert.equal(restored.revisions.every(r => r === hidden.length * 2), true);
    const deleted = rows[101]; // Own source in the middle window, currently visible.
    requireSuccess(await request(f, connections[0], pairA, `messages/${deleted.id}`, { method: 'DELETE', body: {
      membership_epoch: 1, command_id: randomUUID(), expected_version: 1, scope: 'everyone',
    } }));
    requireSuccess(await setVisibility(f, connections[0], pairA, deleted.id, true, 2));
    requireSuccess(await setVisibility(f, connections[0], pairA, deleted.id, false, 3));
    const afterDeleteRestore = await walk(connections[0]);
    assert.deepEqual(afterDeleteRestore.messages.map(m => m.id), rows.map(m => m.id));
    const terminal = afterDeleteRestore.messages.find(m => m.id === deleted.id);
    assert.equal(terminal.body, null); assert.equal(terminal.version, 2); assert.equal(typeof terminal.deletedAt, 'string');
  } finally { await f.close(); }
});
