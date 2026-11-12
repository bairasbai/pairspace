import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mobile, closeMobile, password } from './mobile-invitations-fixture.mjs';
import { replyFixture, latch, tombstone } from './mobile-reply-fixture.mjs';

const openAccount = (f, i, options = {}) => mobile(f, i, { email: `reply-${i}@example.test`, signup: false, ...options });
const replyPosts = account => account.requests.filter(r => r.method === 'POST' && r.path.endsWith('/chat/replies'));

test('real PostgreSQL: reply source beyond 200 is explicitly reread without replacing the bounded window', async () => {
  const { f, pairA, rows, usersA } = await replyFixture(); const accounts = [];
  try {
    const a = await openAccount(f, 0); accounts.push(a);
    const b = await openAccount(f, 1); accounts.push(b);
    await a.controller.loadOldest();
    a.controller.setReplyTarget(rows[0].id);
    assert.equal(a.controller.getSnapshot().replyTarget.id, rows[0].id);
    a.controller.setDraft('Reply to the oldest partner message'); await a.controller.send();
    assert.equal(a.controller.getSnapshot().outgoing.status, 'sent');
    await a.controller.loadLatest();
    const reply = a.controller.getSnapshot().messages.at(-1);
    assert.equal(reply.replyToId, rows[0].id); assert.equal(reply.senderId, usersA[0]);
    const before = a.controller.getSnapshot().messages.map(m => m.id);
    a.controller.setDraft('Unsent draft survives source detail');
    await a.controller.openReplyTarget(reply.id);
    assert.equal(a.controller.getSnapshot().replyDetail.id, rows[0].id);
    assert.equal(a.controller.getSnapshot().replyDetail.body, rows[0].body);
    assert.deepEqual(a.controller.getSnapshot().messages.map(m => m.id), before);
    assert.equal(a.controller.getSnapshot().draft, 'Unsent draft survives source detail');
    assert.equal(before.includes(rows[0].id), false);
    await b.controller.loadLatest(); await b.controller.openReplyTarget(reply.id);
    assert.equal(b.controller.getSnapshot().replyDetail.id, rows[0].id);
    b.controller.setReplyTarget(rows[0].id); b.controller.setDraft('Self reply via canonical detail');
    await b.controller.send(); await b.controller.loadLatest();
    assert.equal(b.controller.getSnapshot().messages.at(-1).replyToId, rows[0].id);
    assert.equal(b.controller.getSnapshot().messages.at(-1).senderId, usersA[1]);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM chat_messages WHERE couple_id=$1', [pairA])).rows[0].n, 253);
    assert.equal(a.controller.getSnapshot().messages.length <= 50, true);
  } finally { await closeMobile(f, accounts); }
});

test('real PostgreSQL: committed delayed reply ACK preserves newer target, draft and old history window', async () => {
  const { f, pairA, rows } = await replyFixture(); const gate = latch(); let a, pending;
  try {
    a = await openAccount(f, 0, { afterResponse: async request => {
      if (request.method === 'POST' && request.path.endsWith('/chat/replies')) { gate.arrive(); await gate.gate; }
    } });
    await a.controller.loadOldest(); a.controller.setReplyTarget(rows[0].id);
    a.controller.setDraft('Committed reply A'); pending = a.controller.send(); await gate.reached;
    a.controller.setReplyTarget(rows[1].id); a.controller.setDraft('New draft B');
    const window = a.controller.getSnapshot().messages.map(m => m.id);
    gate.release(); await pending; pending = null;
    assert.equal(a.controller.getSnapshot().replyTarget.id, rows[1].id);
    assert.equal(a.controller.getSnapshot().draft, 'New draft B');
    assert.deepEqual(a.controller.getSnapshot().messages.map(m => m.id), window);
    const stored = (await f.domainPool.query('SELECT body,reply_to_id FROM chat_messages WHERE couple_id=$1 ORDER BY seq DESC LIMIT 1', [pairA])).rows[0];
    assert.equal(stored.reply_to_id, rows[0].id); assert.equal(stored.body, 'Committed reply A');
    assert.equal(replyPosts(a).length, 1);
  } finally { gate.release(); if (pending) await pending; await closeMobile(f, a ? [a] : []); }
});

test('real PostgreSQL: lost reply ACK retries exact target once even after a new target and internal source tombstone', async () => {
  const { f, pairA, rows } = await replyFixture(); let a, lose = true;
  try {
    a = await openAccount(f, 0, { afterResponse: async request => {
      if (lose && request.method === 'POST' && request.path.endsWith('/chat/replies')) { lose = false; throw new Error('synthetic lost ACK'); }
    } });
    await a.controller.loadOldest(); a.controller.setReplyTarget(rows[0].id);
    a.controller.setDraft('Original immutable retry'); await a.controller.send();
    assert.equal(a.controller.getSnapshot().outgoing.status, 'retry');
    a.controller.setReplyTarget(rows[1].id); a.controller.setDraft('Unsent replacement');
    await tombstone(f, rows[0].id); await a.controller.send();
    assert.equal(a.controller.getSnapshot().outgoing.status, 'sent');
    assert.equal(a.controller.getSnapshot().replyTarget.id, rows[1].id);
    assert.equal(a.controller.getSnapshot().draft, 'Unsent replacement');
    const stored = (await f.domainPool.query('SELECT body,reply_to_id FROM chat_messages WHERE couple_id=$1 AND reply_to_id IS NOT NULL', [pairA])).rows;
    assert.equal(stored.length, 1); assert.equal(stored[0].reply_to_id, rows[0].id);
    assert.equal(stored[0].body, 'Original immutable retry');
    await a.controller.loadLatest(); const reply = a.controller.getSnapshot().messages.at(-1);
    await a.controller.openReplyTarget(reply.id);
    assert.equal(a.controller.getSnapshot().replyDetail.body, null);
    assert.equal(typeof a.controller.getSnapshot().replyDetail.deletedAt, 'string');
    assert.equal(replyPosts(a).length, 2);
  } finally { await closeMobile(f, a ? [a] : []); }
});

test('real PostgreSQL: delayed live source detail cannot restore text after a newer tombstone detail', async () => {
  const { f, rows } = await replyFixture(); const gate = latch(); let a, pending, hold = false;
  try {
    a = await openAccount(f, 0, { afterResponse: async request => {
      if (hold && request.method === 'GET' && request.path.endsWith('/chat/message-detail')) {
        hold = false; gate.arrive(); await gate.gate;
      }
    } });
    await a.controller.loadOldest(); a.controller.setReplyTarget(rows[0].id);
    a.controller.setDraft('Reply before internal tombstone'); await a.controller.send();
    await a.controller.loadLatest(); const reply = a.controller.getSnapshot().messages.at(-1);
    hold = true; pending = a.controller.openReplyTarget(reply.id); await gate.reached;
    a.controller.closeReplyDetail(); await tombstone(f, rows[0].id);
    await a.controller.openReplyTarget(reply.id);
    assert.equal(a.controller.getSnapshot().replyDetail.body, null);
    const deletedVersion = a.controller.getSnapshot().replyDetail.version;
    gate.release(); await pending; pending = null;
    assert.equal(a.controller.getSnapshot().replyDetail.body, null);
    assert.equal(a.controller.getSnapshot().replyDetail.version, deletedVersion);
    a.controller.setReplyTarget(rows[0].id);
    assert.notEqual(a.controller.getSnapshot().replyTarget?.id, rows[0].id, 'deleted original cannot become a new reply target');
    assert.equal(a.controller.getSnapshot().messages.some(m => m.id === rows[0].id && m.body !== null), false);
  } finally { gate.release(); if (pending) await pending; await closeMobile(f, a ? [a] : []); }
});

test('real PostgreSQL: old-account reply ACK cannot publish into a different pair, foreign detail is unavailable', async () => {
  const { f, pairA, pairB, rows } = await replyFixture(); const gate = latch(); let a, pending;
  try {
    a = await openAccount(f, 0, { afterResponse: async request => {
      if (request.method === 'POST' && request.path.endsWith('/chat/replies')) { gate.arrive(); await gate.gate; }
    } });
    await a.controller.loadOldest(); a.controller.setReplyTarget(rows[0].id);
    a.controller.setDraft('Old account reply'); pending = a.controller.send(); await gate.reached;
    await a.controller.signOut(); await a.controller.signIn('reply-2@example.test', password);
    a.controller.setDraft('New account private draft');
    const view = a.controller.getSnapshot(); assert.equal(view.messages.every(m => m.coupleId === pairB), true);
    gate.release(); await pending; pending = null;
    assert.equal(a.controller.getSnapshot().draft, 'New account private draft');
    assert.equal(a.controller.getSnapshot().messages.some(m => m.coupleId === pairA), false);
    assert.equal(a.controller.getSnapshot().replyTarget == null, true);
    assert.equal(a.controller.getSnapshot().replyDetail == null, true);
    const url = new URL(`/v1/couples/${pairB}/chat/message-detail`, f.baseURL);
    url.searchParams.set('membership_epoch', '1'); url.searchParams.set('message_id', rows[0].id);
    url.searchParams.set('read_id', '12345678-1234-4234-8234-123456789abc');
    const foreign = await fetch(url, { headers: { cookie: await a.connection.getCookie(), origin: f.baseURL } });
    assert.equal(foreign.status, 409);
    const payload = await foreign.json(); assert.equal(payload.ok, false);
    assert.equal(JSON.stringify(payload).includes(rows[0].body), false);
    url.searchParams.set('message_id', 'ffffffff-ffff-4fff-8fff-ffffffffffff');
    const absent = await fetch(url, { headers: { cookie: await a.connection.getCookie(), origin: f.baseURL } });
    assert.equal(absent.status, foreign.status);
    assert.deepEqual(await absent.json(), payload, 'missing and foreign targets have identical error shape');
  } finally { gate.release(); if (pending) await pending; await closeMobile(f, a ? [a] : []); }
});


test('real PostgreSQL: observed own reply tombstone dominates its delayed live send ACK', async () => {
  const { f, pairA, rows } = await replyFixture(); const gate = latch(); let a, pending;
  const sentBody = 'Synthetic own reply becomes a tombstone';
  try {
    a = await openAccount(f, 0, { afterResponse: async request => {
      if (request.method === 'POST' && request.path.endsWith('/chat/replies')) { gate.arrive(); await gate.gate; }
    } });
    await a.controller.loadOldest(); a.controller.setReplyTarget(rows[0].id);
    a.controller.setDraft(sentBody); pending = a.controller.send(); await gate.reached;
    const committed = (await f.domainPool.query('SELECT id FROM chat_messages WHERE couple_id=$1 AND reply_to_id=$2', [pairA, rows[0].id])).rows;
    assert.equal(committed.length, 1);
    await tombstone(f, committed[0].id);
    a.controller.setDraft('A genuinely newer unrelated draft');
    await a.controller.loadLatest();
    const observed = a.controller.getSnapshot().messages.find(m => m.id === committed[0].id);
    assert.equal(observed.body, null); assert.equal(typeof observed.deletedAt, 'string');
    gate.release(); await pending; pending = null;
    const view = a.controller.getSnapshot();
    assert.equal(view.messages.find(m => m.id === committed[0].id).body, null);
    assert.equal(view.outgoing, undefined, 'deleted queued reply cannot regain its outgoing text');
    assert.equal(view.replyDetail == null || view.replyDetail.body !== sentBody, true);
    assert.equal(view.draft, 'A genuinely newer unrelated draft');
    assert.equal(JSON.stringify(view).includes(sentBody), false, 'no public controller state resurrects acknowledged tombstone text');
    const count = a.requests.length; await a.controller.send();
    assert.equal(a.requests.length > count, true, 'new independent draft remains sendable');
    const tombstoneRow = (await f.domainPool.query('SELECT body,version,deleted_at FROM chat_messages WHERE id=$1', [committed[0].id])).rows[0];
    assert.equal(tombstoneRow.body, null); assert.equal(tombstoneRow.version, 2);
  } finally { gate.release(); if (pending) await pending; await closeMobile(f, a ? [a] : []); }
});

test('real PostgreSQL: own tombstone immediately scrubs unchanged composer before delayed ACK', async () => {
  const { f, pairA, rows } = await replyFixture(); const gate = latch(); let a, pending;
  const sentBody = 'Synthetic unchanged composer must be scrubbed immediately';
  try {
    a = await openAccount(f, 0, { afterResponse: async request => {
      if (request.method === 'POST' && request.path.endsWith('/chat/replies')) { gate.arrive(); await gate.gate; }
    } });
    await a.controller.loadOldest(); a.controller.setReplyTarget(rows[0].id);
    a.controller.setDraft(sentBody); pending = a.controller.send(); await gate.reached;
    assert.equal(a.controller.getSnapshot().draft, sentBody, 'pending draft is visible before deletion is known');
    const committed = (await f.domainPool.query('SELECT id FROM chat_messages WHERE couple_id=$1 AND reply_to_id=$2', [pairA, rows[0].id])).rows;
    assert.equal(committed.length, 1); await tombstone(f, committed[0].id);
    await a.controller.loadLatest();
    const beforeAck = a.controller.getSnapshot();
    assert.equal(beforeAck.messages.find(m => m.id === committed[0].id).body, null);
    assert.equal(beforeAck.draft, '', 'unchanged submitted text clears as soon as its tombstone is observed');
    assert.equal(beforeAck.outgoing, undefined);
    assert.equal(JSON.stringify(beforeAck).includes(sentBody), false, 'no public text survives pending ACK after tombstone');
    gate.release(); await pending; pending = null;
    assert.equal(a.controller.getSnapshot().draft, '');
    assert.equal(a.controller.getSnapshot().outgoing, undefined);
    assert.equal(JSON.stringify(a.controller.getSnapshot()).includes(sentBody), false);
    assert.equal(replyPosts(a).length, 1);
  } finally { gate.release(); if (pending) await pending; await closeMobile(f, a ? [a] : []); }
});
