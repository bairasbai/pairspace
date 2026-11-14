import assert from 'node:assert/strict';
import { test } from 'node:test';
import { latch } from './mobile-reply-fixture.mjs';
import { closeMobile, password } from './mobile-invitations-fixture.mjs';
import { morningsFixture, morningRequest as request, morningValue as value, morningCommand as command,
  setMorningPreference, futureDate, morningAccount } from './mobile-mornings-fixture.mjs';

async function assign(f, actor, pair, date, preferenceVersion = 1, offset = '+00:00', id) {
  const body = command({ preference_version: preferenceVersion, local_date: date, offset, ...(id ? { command_id: id } : {}) });
  const response = await request(f, actor, pair, '/slots', { method: 'POST', body });
  return { response, body };
}
const fill = (f, actor, pair, slotId, body) => request(f, actor, pair, `/slots/${slotId}/body`, { method: 'PUT', body });
const page = (f, actor, pair, query = {}) => request(f, actor, pair, '', { query: { direction: 'latest', ...query } });

test('morning HTTP/PG: recipient sealed metadata is unchanged by preparation; assigned snapshot survives own preference changes and exact retries', async () => {
  const { f, pairA, pairB, usersA, connections } = await morningsFixture();
  try {
    const pref = await setMorningPreference(f, connections[1], pairA);
    assert.equal(pref.preference.userId, usersA[1]); assert.equal(pref.preference.version, 1);
    const scheduled = await assign(f, connections[0], pairA, futureDate());
    const slot = value(scheduled.response).slot;
    const before = value(await page(f, connections[1], pairA)).slots[0];
    assert.equal(before.state, 'sealed'); assert.equal(Object.hasOwn(before, 'prepared'), false);
    assert.equal(Object.hasOwn(before, 'body'), false);
    const text = 'Synthetic morning letter\nҺаумы, 日本語 🦉';
    const filling = command({ body: text });
    const filled = value(await fill(f, connections[0], pairA, slot.id, filling));
    assert.equal(filled.slot.prepared, true); assert.equal(JSON.stringify(filled).includes(text), false);
    const after = value(await page(f, connections[1], pairA)).slots[0];
    assert.deepEqual(after, before, 'recipient gets no readiness or body before release');
    await setMorningPreference(f, connections[1], pairA, 'Pacific/Kiritimati', '10:30', 1);
    const retried = value(await request(f, connections[0], pairA, '/slots', { method: 'POST', body: scheduled.body }));
    assert.equal(retried.replay, true); assert.equal(retried.slot.id, slot.id);
    assert.equal(retried.slot.timezone, 'UTC'); assert.equal(retried.slot.localTime, '09:00');
    assert.equal(retried.slot.releaseAt, slot.releaseAt); assert.equal(retried.slot.preferenceVersion, 1);
    assert.equal(value(await fill(f, connections[0], pairA, slot.id, filling)).replay, true);
    const collision = await assign(f, connections[0], pairA, slot.localDate, 2, '+14:00');
    assert.equal(collision.response.status, 409); assert.equal(collision.response.payload.error, 'slot_exists');
    const stale = await assign(f, connections[0], pairA, futureDate(8), 1);
    assert.equal(stale.response.status, 409);
    const foreign = await request(f, connections[2], pairA, `/slots/${slot.id}`);
    assert.equal(foreign.status, 403); assert.equal(JSON.stringify(foreign).includes(text), false);
    assert.deepEqual(value(await page(f, connections[2], pairB)).slots, []);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM morning_slots WHERE couple_id=$1', [pairA])).rows[0].n, 1);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM letters WHERE couple_id=$1', [pairA])).rows[0].n, 0);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM outbox_events WHERE couple_id=$1', [pairA])).rows[0].n, 0);
  } finally { await f.close(); }
});

test('morning HTTP/PG: 33 assigned days have complete bidirectional bounded history, exact snapshots and no duplicate IDs', async () => {
  const { f, pairA, connections } = await morningsFixture();
  try {
    await setMorningPreference(f, connections[1], pairA, 'Etc/GMT+12', '09:00');
    const assigned = [];
    for (let i = 0; i < 33; i++) assigned.push(value((await assign(f, connections[0], pairA, futureDate(i + 2), 1, '-12:00')).response).slot);
    const latest = value(await page(f, connections[1], pairA));
    assert.equal(latest.slots.length, 30); assert.equal(latest.hasOlder, true); assert.equal(latest.hasNewer, false);
    const older = value(await page(f, connections[1], pairA, { direction: 'before', anchor_id: latest.olderCursor.id,
      anchor_release_at: latest.olderCursor.releaseAt }));
    assert.equal(older.slots.length, 3); assert.equal(older.hasOlder, false); assert.equal(older.hasNewer, true);
    const seen = [...latest.slots, ...older.slots];
    assert.equal(new Set(seen.map(s => s.id)).size, 33);
    assert.deepEqual(seen.map(s => s.id), [...assigned].reverse().map(s => s.id));
    assert.equal(seen.every(s => s.offset === '-12:00' && s.timezone === 'Etc/GMT+12' && s.state === 'sealed'), true);
    const newer = value(await page(f, connections[1], pairA, { direction: 'after', anchor_id: older.newerCursor.id,
      anchor_release_at: older.newerCursor.releaseAt }));
    assert.deepEqual(newer.slots.map(s => s.id), latest.slots.map(s => s.id));
    const oldest = value(await page(f, connections[1], pairA, { direction: 'oldest' }));
    assert.equal(oldest.slots.length, 30); assert.equal(oldest.hasOlder, false);
    assert.deepEqual(oldest.slots.map(s => s.id), assigned.slice(0, 30).reverse().map(s => s.id));
  } finally { await f.close(); }
});

test('connected morning flow: own preference, explicit assignment and one-time preparation never auto-open recipient content', async () => {
  const { f, pairA, usersA } = await morningsFixture(); const accounts = [];
  try {
    const a = await morningAccount(f), b = await morningAccount(f, 1); accounts.push(a, b);
    const sender = a.controller.mornings, recipient = b.controller.mornings;
    recipient.setPreference({ timezone: 'UTC', localTime: '09:00' }); await recipient.savePreference();
    await sender.list();
    assert.equal(sender.getSnapshot().preferences.find(p => p.userId === usersA[1]).timezone, 'UTC');
    sender.setLocalDate(futureDate()); sender.chooseOffset('+00:00'); sender.requestAssignment();
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM morning_slots WHERE couple_id=$1', [pairA])).rows[0].n, 0);
    await sender.confirm(sender.getSnapshot().confirmation.token); await sender.list();
    const slot = sender.getSnapshot().slots[0]; sender.selectSlot(slot.id); sender.setDraft('Connected morning\nSynthetic 🦉');
    sender.requestFill(); sender.cancelConfirmation();
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM morning_content')).rows[0].n, 0);
    sender.requestFill(); await sender.confirm(sender.getSnapshot().confirmation.token);
    assert.equal(sender.getSnapshot().draft, ''); await recipient.list();
    assert.equal(recipient.getSnapshot().slots[0].state, 'sealed'); assert.equal(recipient.getSnapshot().opened, null);
    assert.equal(JSON.stringify(recipient.getSnapshot()).includes('Connected morning'), false);
    const before = b.requests.length; await recipient.open(slot.id);
    assert.equal(b.requests.length, before, 'sealed open is not an implicit write/read');
  } finally { await closeMobile(f, accounts); }
});

test('connected morning lost fill ACK pins exact slot/body while preserving another slot draft and never sending it automatically', async () => {
  const { f, pairA, connections } = await morningsFixture(); const accounts = []; let lose = true; const bodies = [];
  try {
    await setMorningPreference(f, connections[1], pairA);
    const one = value((await assign(f, connections[0], pairA, futureDate())).response).slot;
    const two = value((await assign(f, connections[0], pairA, futureDate(8))).response).slot;
    const a = await morningAccount(f, 0, { beforeRequest: async (record, req) => {
      if (record.path.endsWith('/body')) bodies.push(await req.clone().json());
    }, afterResponse: async record => {
      if (record.path.endsWith('/body') && lose) { lose = false; throw Error('Synthetic lost morning fill ACK'); }
    } }); accounts.push(a);
    const m = a.controller.mornings; await m.list(); m.selectSlot(one.id); m.setDraft('Exact pending morning A');
    m.requestFill(); await m.confirm(m.getSnapshot().confirmation.token);
    assert.equal(m.getSnapshot().status, 'unknown');
    m.selectSlot(two.id); m.setDraft('New morning B draft'); await m.retry();
    assert.deepEqual(bodies[1], bodies[0]); assert.equal(m.getSnapshot().selected.id, two.id);
    assert.equal(m.getSnapshot().draft, 'New morning B draft');
    const stored = (await f.domainPool.query('SELECT slot_id,body FROM morning_content')).rows;
    assert.deepEqual(stored, [{ slot_id: one.id, body: 'Exact pending morning A' }]);
    m.selectSlot(one.id); assert.equal(m.getSnapshot().draft, '');
  } finally { await closeMobile(f, accounts); }
});

test('connected morning held fill ACK cannot publish old-account body after logout and a different pair signs in', async () => {
  const { f, pairA, pairB, connections } = await morningsFixture(); const accounts = []; const gate = latch(); let pending;
  try {
    await setMorningPreference(f, connections[1], pairA);
    const slot = value((await assign(f, connections[0], pairA, futureDate())).response).slot;
    const a = await morningAccount(f, 0, { afterResponse: async record => {
      if (record.path.endsWith('/body')) { gate.arrive(); await gate.gate; }
    } }); accounts.push(a);
    const m = a.controller.mornings; await m.list(); m.selectSlot(slot.id); m.setDraft('Old account synthetic morning');
    m.requestFill(); pending = m.confirm(m.getSnapshot().confirmation.token); await gate.reached;
    await a.controller.signOut(); await a.controller.signIn('reply-2@example.test', password);
    a.controller.setDraft('New account chat draft'); await m.list();
    gate.release(); await pending; pending = null;
    assert.deepEqual(m.getSnapshot().slots, []); assert.equal(m.getSnapshot().draft, ''); assert.equal(m.getSnapshot().opened, null);
    assert.equal(JSON.stringify(m.getSnapshot()).includes('Old account synthetic morning'), false);
    assert.equal(a.controller.getSnapshot().draft, 'New account chat draft');
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM morning_slots WHERE couple_id=$1', [pairB])).rows[0].n, 0);
  } finally { gate.release(); if (pending) await pending; await closeMobile(f, accounts); }
});
