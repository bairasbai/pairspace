import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { sendMorningDiscussion } from '../../src/morning-discussions.ts';
import { latch } from './mobile-reply-fixture.mjs';
import { password } from './mobile-invitations-fixture.mjs';
import { morningRequest as request, morningValue as value, morningCommand as command,
  setMorningPreference, morningAccount } from './mobile-mornings-fixture.mjs';
const discussion = (x, actor, slot, options = {}) => request(x.f, x.connections[actor], x.pairA, `/slots/${slot}/discussion`, options);
const get = (x, actor, slot, query = {}) => discussion(x, actor, slot, { query: { direction: 'first', ...query } });
const post = (x, actor, slot, body) => discussion(x, actor, slot, { method: 'POST', body });

export async function setupDiscussionSlot(x, release) {
  // Explicit recipient-owned changed preference; same immutable instant, different
  // civil date. The original UTC missed slot and original filled slot stay intact.
  const utc = new Date(release), offsetHours = utc.getUTCHours() >= 10 ? 14 : -12;
  const local = new Date(release + offsetHours * 3600000).toISOString();
  const timezone = offsetHours === 14 ? 'Etc/GMT-14' : 'Etc/GMT+12';
  const offset = offsetHours === 14 ? '+14:00' : '-12:00';
  assert.notEqual(local.slice(0, 10), utc.toISOString().slice(0, 10));
  await setMorningPreference(x.f, x.connections[0], x.pairA, timezone, local.slice(11, 16), 1);
  const slot = value(await request(x.f, x.connections[1], x.pairA, '/slots', { method: 'POST', body: command({
    preference_version: 2, local_date: local.slice(0, 10), offset,
  }) })).slot;
  assert.equal(slot.releaseAt, utc.toISOString());
  value(await request(x.f, x.connections[1], x.pairA, `/slots/${slot.id}/body`, { method: 'PUT',
    body: command({ body: 'Synthetic separate morning for draft B' }),
  }));
  for (const actor of [0, 1]) {
    const denied = await get(x, actor, slot.id);
    assert.equal(denied.status >= 400, true); assert.equal(Object.hasOwn(denied.payload, 'value'), false);
  }
  return slot;
}

export function registerMorningDiscussionTests(context) {
  test('genuine morning discussion: sender can follow up before recipient latch; recipient cannot read reply existence until explicit open', async () => {
    const x = context(), id = x.discussionSlot.id;
    const before = await get(x, 0, id);
    assert.equal(before.status >= 400, true);
    const sent = value(await post(x, 1, id, command({ body: 'Sender first follow-up\nOwn original author' })));
    assert.equal(sent.message.authorId, x.usersA[1]); assert.equal(sent.message.slotId, id);
    const after = await get(x, 0, id);
    assert.equal(after.status, before.status);
    assert.deepEqual(Object.keys(after.payload).sort(), Object.keys(before.payload).sort());
    assert.equal(Object.hasOwn(after.payload, 'value'), false);
    value(await request(x.f, x.connections[0], x.pairA, `/slots/${id}/open`, { method: 'POST', body: command({ confirm: true }) }));
    assert.equal(value(await get(x, 0, id)).messages[0].body, sent.message.body);
    const reply = value(await post(x, 0, id, command({ body: 'Recipient follow-up\nҺаумы 🦉' })));
    assert.equal(reply.message.authorId, x.usersA[0]);
    assert.deepEqual(value(await get(x, 1, id)).messages.map(m => m.authorId), [x.usersA[1], x.usersA[0]]);
  });

  test('genuine morning discussion: 67 immutable HTTP replies navigate all 30-row windows, exact retry and insertion never duplicate or retarget', async () => {
    const x = context(), id = x.slot.id, sent = [];
    const initialOutbox = (await x.f.domainPool.query('SELECT count(*)::int n FROM outbox_events')).rows;
    for (let i = 0; i < 67; i++) sent.push(value(await post(x, i % 2, id, command({ body: `Synthetic discussion ${i}\nSecond line` }))).message);
    let page = value(await get(x, 0, id)); const collected = [...page.messages];
    const between = value(await post(x, 1, id, command({ body: 'Inserted after first page before subsequent pages' }))).message;
    const expected = [...sent, between];
    assert.equal(page.messages.length, 30); assert.equal(page.hasPrevious, false);
    while (page.hasNext) {
      page = value(await get(x, 0, id, { direction: 'after', anchor_id: page.nextCursor.id, anchor_seq: page.nextCursor.seq }));
      assert.equal(page.messages.length <= 30, true); collected.push(...page.messages);
    }
    assert.deepEqual(collected.map(m => m.id), expected.map(m => m.id)); assert.equal(new Set(collected.map(m => m.id)).size, 68);
    const back = value(await get(x, 1, id, { direction: 'before', anchor_id: page.previousCursor.id, anchor_seq: page.previousCursor.seq }));
    assert.deepEqual(back.messages.map(m => m.id), sent.slice(30, 60).map(m => m.id));
    const c = command({ body: 'Exact new inserted reply' }); const inserted = value(await post(x, 0, id, c));
    const replay = value(await post(x, 0, id, c)); assert.equal(replay.replay, true); assert.equal(replay.message.id, inserted.message.id);
    assert.equal((await post(x, 0, id, { ...c, body: 'Different payload' })).status, 409);
    assert.equal((await post(x, 0, x.discussionSlot.id, c)).status, 409);
    const last = value(await get(x, 1, id, { direction: 'last' }));
    assert.equal(last.messages.at(-1).id, inserted.message.id); assert.equal(last.hasNext, false);
    assert.deepEqual((await x.f.domainPool.query('SELECT count(*)::int n FROM outbox_events')).rows, initialOutbox);
  });

  test('genuine morning discussion receipt failure rolls back the new reply, leaving no partial message or notification', async () => {
    const x = context(), id = x.slot.id;
    const before = (await x.f.domainPool.query('SELECT count(*)::int n FROM morning_discussion_messages WHERE slot_id=$1', [id])).rows;
    await x.f.domainPool.query(`CREATE FUNCTION fail_test_discussion_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic_receipt_failure'; END $$;
      CREATE TRIGGER fail_test_discussion_receipt BEFORE INSERT ON morning_discussion_receipts
      FOR EACH ROW EXECUTE FUNCTION fail_test_discussion_receipt()`);
    try {
      const failed = await post(x, 0, id, command({ body: 'Must roll back this reply' }));
      assert.equal(failed.status, 503);
      assert.deepEqual((await x.f.domainPool.query('SELECT count(*)::int n FROM morning_discussion_messages WHERE slot_id=$1', [id])).rows, before);
    } finally {
      await x.f.domainPool.query('DROP TRIGGER fail_test_discussion_receipt ON morning_discussion_receipts; DROP FUNCTION fail_test_discussion_receipt()');
    }
  });

  test('connected morning discussions: unknown reply retry remains on A and preserves B draft without auto-posting or moving history', async () => {
    const x = context(); let account, lose = true; const commands = [];
    try {
      account = await morningAccount(x.f, 0, { beforeRequest: async (record, req) => {
        if (record.method === 'POST' && /\/discussion(?:-v2)?$/.test(record.path)) commands.push({ path: record.path, body: await req.clone().json() });
      }, afterResponse: async record => {
        if (record.method === 'POST' && /\/discussion(?:-v2)?$/.test(record.path) && lose) { lose = false; throw Error('Synthetic lost discussion ACK'); }
      } });
      const d = account.controller.morningDiscussions;
      const a = value(await request(x.f, account.connection, x.pairA, `/slots/${x.slot.id}`)).slot;
      const b = value(await request(x.f, account.connection, x.pairA, `/slots/${x.discussionSlot.id}`)).slot;
      await d.open(a); d.setDraft('Exact pending discussion A'); await d.send();
      assert.equal(d.getSnapshot().status, 'unknown');
      await d.open(b); d.setDraft('Separate newer discussion B');
      const before = d.getSnapshot().messages.map(m => m.id);
      await d.retry();
      assert.deepEqual(commands[1], commands[0]); assert.equal(d.getSnapshot().slot.id, b.id);
      assert.equal(d.getSnapshot().draft, 'Separate newer discussion B');
      assert.deepEqual(d.getSnapshot().messages.map(m => m.id), before);
      assert.equal((await x.f.domainPool.query('SELECT count(*)::int n FROM morning_discussion_messages WHERE slot_id=$1 AND body=$2',
        [a.id, 'Exact pending discussion A'])).rows[0].n, 1);
      assert.equal((await x.f.domainPool.query('SELECT count(*)::int n FROM morning_discussion_messages WHERE body=$1',
        ['Separate newer discussion B'])).rows[0].n, 0);
      await d.open(a); assert.equal(d.getSnapshot().draft, '');
    } finally { if (account) await account.controller.signOut(); }
  });

  test('connected morning discussions: held ACK after account switch cannot restore old slot, messages or draft', async () => {
    const x = context(), gate = latch(); let account, pending;
    try {
      account = await morningAccount(x.f, 0, { afterResponse: async record => {
        if (record.method === 'POST' && /\/discussion(?:-v2)?$/.test(record.path)) { gate.arrive(); await gate.gate; }
      } });
      const d = account.controller.morningDiscussions;
      const slot = value(await request(x.f, account.connection, x.pairA, `/slots/${x.slot.id}`)).slot;
      await d.open(slot); d.setDraft('Old account pending reply'); pending = d.send(); await gate.reached;
      await account.controller.signOut(); await account.controller.signIn('reply-2@example.test', password);
      account.controller.setDraft('New account private composer');
      gate.release(); await pending; pending = null;
      assert.equal(d.getSnapshot().slot, null); assert.deepEqual(d.getSnapshot().messages, []);
      assert.equal(d.getSnapshot().draft, ''); assert.equal(JSON.stringify(d.getSnapshot()).includes('Old account pending reply'), false);
      assert.equal(account.controller.getSnapshot().draft, 'New account private composer');
    } finally { gate.release(); if (pending) await pending; if (account) await account.controller.signOut(); }
  });


  test('connected morning discussion current-session expired POST denial remains blocking after closing its selected thread', async () => {
    const x = context(), gate = latch(); let account, pending, expire = true;
    try {
      account = await morningAccount(x.f, 0, { beforeRequest: async record => {
        if (record.method === 'POST' && /\/discussion(?:-v2)?$/.test(record.path) && expire) {
          expire = false;
          const session = await account.connection.auth.getSession({ query: { disableCookieCache: true } });
          assert.ok(session.data.session.id);
          await x.f.authPool.query(`UPDATE "session" SET "expiresAt"=clock_timestamp()-interval '1 second' WHERE id=$1`, [session.data.session.id]);
        }
      }, afterResponse: async (record, response) => {
        if (record.method === 'POST' && /\/discussion(?:-v2)?$/.test(record.path)) {
          assert.equal(response.status === 401 || response.status === 403, true); gate.arrive(); await gate.gate;
        }
      } });
      const d = account.controller.morningDiscussions;
      const slot = value(await request(x.f, account.connection, x.pairA, `/slots/${x.slot.id}`)).slot;
      await d.open(slot); d.setDraft('Expired session must not write'); pending = d.send(); await gate.reached;
      d.close(); gate.release(); await pending; pending = null;
      assert.notEqual(account.controller.getSnapshot().phase, 'signed_in');
      assert.equal(d.getSnapshot().available, false); assert.equal(d.getSnapshot().draft, '');
      assert.equal((await x.f.domainPool.query('SELECT count(*)::int n FROM morning_discussion_messages WHERE body=$1',
        ['Expired session must not write'])).rows[0].n, 0);
    } finally { gate.release(); if (pending) await pending; if (account) await account.controller.signOut(); }
  });


  test('actual PostgreSQL discussion ordering uses unique sequence across equal trusted-clock timestamps after genuine release', async () => {
    const x = context();
    const response = await x.f.call('sign-in/email', { email: 'reply-0@example.test', password });
    assert.equal(response.status, 200);
    const cookie = response.headers.getSetCookie().map(v => v.split(';')[0]).join('; ');
    const db = x.f.database();
    const principal = await db.sessionAuthority.authenticate(new Request('http://localhost:3123/read', {
      headers: { origin: 'http://localhost:3123', cookie },
    }));
    assert.ok(principal);
    const now = new Date(); assert.equal(now.getTime() >= x.release, true);
    // Fixed trusted test clock only creates an exact timestamp tie. Real release was
    // already crossed above; session rechecks and all installed SQL guards still run.
    const fixed = { ...db, now: () => now };
    const rows = [];
    for (const body of ['Same timestamp first reply', 'Same timestamp second reply']) {
      const sent = await sendMorningDiscussion(fixed, principal, { coupleId: x.pairA, membershipEpoch: 1,
        slotId: x.slot.id, commandId: randomUUID(), body });
      assert.equal(sent.ok, true); rows.push(sent.value.message);
    }
    assert.equal(rows[0].createdAt, rows[1].createdAt); assert.equal(rows[1].seq > rows[0].seq, true);
    const next = value(await get(x, 1, x.slot.id, { direction: 'after', anchor_id: rows[0].id, anchor_seq: rows[0].seq }));
    assert.equal(next.messages[0].id, rows[1].id);
    const previous = value(await get(x, 0, x.slot.id, { direction: 'before', anchor_id: rows[1].id, anchor_seq: rows[1].seq }));
    assert.equal(previous.messages.at(-1).id, rows[0].id);
  });

}
