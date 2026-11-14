import {setupMorningNotificationLive,exerciseMorningNotificationBoundary,registerMorningNotificationLive} from './morning-notification-live.mjs';
import { preparedMorning } from '../../src/morning-prepared.ts';
import { registerMorningMutationUpgradeTest, registerMorningMutationNativeTests } from './morning-discussion-mutation-native.mjs';
import assert from 'node:assert/strict';
import { registerMorningDiscussionEditingTests } from './morning-discussion-editing-connected.mjs';
import { setupDiscussionSlot, registerMorningDiscussionTests } from './morning-discussion-connected.mjs';
import { before, after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { password } from './profile-fixture.mjs';
import { readMorning, listMornings } from '../../src/morning-read.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { morningsFixture, morningRequest as request, morningValue as value, morningCommand as command,
  setMorningPreference, morningAccount } from './mobile-mornings-fixture.mjs';

// One genuine wall-clock transition shared by bounded sequential phases. No OS,
// application, or SQL clock override; no restored-history/disabled-trigger fixture.
// Every phase retains the suite's unchanged 30-second per-test limit.
let notificationData;
let x, release, slot, emptySlot, fillCommand, scheduleCommand, recipient, discussionSlot, preparedEditCommand, preparedOutcomes;
before(async () => { x = await morningsFixture({ enableSyntheticMorningDiscussions: true, enableSyntheticMorningDiscussionEditing: true, skipMorningDiscussionEditingMigration: true }); });
after(async () => { if (recipient) await recipient.controller.signOut(); if (x) await x.f.close(); });
async function preparedAuthor(f, db) {
  const response = await f.call('sign-in/email', {email:'reply-0@example.test',password});
  assert.equal(response.status,200);
  const cookie=response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
  return db.sessionAuthority.authenticate(new Request('http://localhost:3123/read',{headers:{origin:'http://localhost:3123',cookie}}));
}
const read = (actor, id) => request(x.f, x.connections[actor], x.pairA, `/slots/${id}`);
const open = (actor, id, body) => request(x.f, x.connections[actor], x.pairA, `/slots/${id}/open`, { method: 'POST', body });

test('genuine morning boundary setup: prepare one future slot, leave another empty and prove sealed/read-only privacy', async () => {
  const { f, pairA, connections } = x;
  release = Math.ceil((Date.now() + 61000) / 60000) * 60000;
  const iso = new Date(release).toISOString(), date = iso.slice(0, 10), time = iso.slice(11, 16);
  await setMorningPreference(f, connections[1], pairA, 'UTC', time);
  await setMorningPreference(f, connections[0], pairA, 'UTC', time);
  scheduleCommand = command({ preference_version: 1, local_date: date, offset: '+00:00' });
  slot = value(await request(f, connections[0], pairA, '/slots', { method: 'POST', body: scheduleCommand })).slot;
  emptySlot = value(await request(f, connections[1], pairA, '/slots', { method: 'POST', body: command({
    preference_version: 1, local_date: date, offset: '+00:00',
  }) })).slot;
  assert.equal(slot.releaseAt, iso); assert.equal(emptySlot.releaseAt, iso);
  const before = value(await read(1, slot.id));
  fillCommand = command({ body: 'Synthetic genuine morning\nҺаумы, 日本語 🦉' });
  value(await request(f, connections[0], pairA, `/slots/${slot.id}/body`, { method: 'PUT', body: fillCommand }));
  const after = value(await read(1, slot.id));
  assert.deepEqual(after.slot, before.slot); assert.equal(after.slot.state, 'sealed');
  assert.equal(after.slot.openedAt, null); assert.equal(Object.hasOwn(after, 'body'), false);
  const early = await open(1, slot.id, command({ confirm: true }));
  assert.equal(early.status >= 400, true); assert.equal(JSON.stringify(early).includes(fillCommand.body), false);
  const originalSender = value(await read(0, slot.id));
  assert.equal(Object.hasOwn(originalSender.slot, 'openedAt'), false);
  preparedEditCommand = command({ expected_version: 1, body: fillCommand.body + ' prepared edit' });
  const edited = value(await request(f, connections[0], pairA, `/slots/${slot.id}/prepared`, { method: 'PUT', body: preparedEditCommand }));
  assert.equal(edited.version, 2);
  const restored = value(await request(f, connections[0], pairA, `/slots/${slot.id}/prepared`, { method: 'PUT', body: command({ expected_version: 2, body: fillCommand.body }) }));
  assert.equal(restored.version, 3);
  discussionSlot = await setupDiscussionSlot(x, release);
  notificationData = await setupMorningNotificationLive(x, release);

});

async function exercisePreparedBoundary() {
  const {f,pairA}=x;
  const db=f.database(), principal=await preparedAuthor(f,db);
  assert.ok(principal);
  const lock=await f.domainPool.connect();
  let pending;
  try {
    await lock.query('BEGIN');
    await lock.query('SELECT id FROM morning_slots WHERE id=$1 FOR UPDATE',[slot.id]);
    assert.ok(Date.now()<release,'lock acquired before release');
    const scope={coupleId:pairA,membershipEpoch:1,slotId:slot.id};
    pending=Promise.allSettled([
      preparedMorning(db,principal,{...scope,readId:randomUUID()},false),
      preparedMorning(db,principal,{...scope,commandId:randomUUID(),expectedVersion:3,body:fillCommand.body},true),
      preparedMorning(db,principal,{...scope,commandId:randomUUID(),expectedVersion:3,body:'Blocked edit'},true),
    ]);
    await delay(50);
    const blocked=await lock.query('SELECT count(*)::int n FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid))>0');
    assert.ok(blocked.rows[0].n>0,'real contention before release');
    await delay(Math.max(0,release-Date.now()+30));
  } finally {
    try { await lock.query('ROLLBACK'); } finally { lock.release(); }
    if(pending) preparedOutcomes=await pending;
  }
}

for (let phase = 1; phase <= 5; phase++) {
  test(`genuine morning boundary wait ${phase}/5: at most 25 seconds, bounded release checks`, async () => {
    assert.ok(slot, 'setup completed');
    const remaining=release-Date.now();
    if(!preparedOutcomes && remaining>0 && remaining<=24000) {
      await delay(Math.max(0,remaining-1800));
      const results=await Promise.allSettled([exercisePreparedBoundary(),exerciseMorningNotificationBoundary(x,release,notificationData)]);
      // Preserve every strict assertion, but never retry a phase while its peer
      // is still releasing held rows after a rejected observer assertion.
      for(const result of results)if(result.status==='rejected')throw result.reason;
    } else if(remaining>0) {
      // Leave at least four seconds for the next bounded phase to acquire locks.
      await delay(Math.max(0,Math.min(25000,remaining-4000)));
    }
  });
}

test('prepared GET, edit and no-op waiting on actual row locks recheck after the deadline', async () => {
  assert.ok(Date.now() >= release);
  assert.ok(preparedOutcomes);
  assert.deepEqual(preparedOutcomes.map(result => result.status==='fulfilled' ? result.value.error : String(result.reason)), ['slot_closed','slot_closed','slot_closed']);
});

test('prepared edit release is terminal under adapter rollback even BEFORE recipient opening', async () => {
  const {f,pairA,connections}=x;
  const db=f.database();
  const principal=await preparedAuthor(f, db);
  assert.ok(principal);
  const rollback={...db,now:()=>new Date(release-1000)};
  const scope={coupleId:pairA,membershipEpoch:1,slotId:slot.id};
  assert.equal((await preparedMorning(rollback,principal,{...scope,readId:randomUUID()},false)).error,'slot_closed');
  assert.equal((await preparedMorning(rollback,principal,{...scope,commandId:randomUUID(),expectedVersion:3,body:fillCommand.body},true)).error,'slot_closed');
  const replay=value(await request(f,connections[0],pairA,`/slots/${slot.id}/prepared`,{method:'PUT',body:preparedEditCommand}));
  assert.equal(replay.replay,true);assert.equal(replay.version,3);assert.equal(replay.body,fillCommand.body);
});

test('genuine morning boundary: due GET remains metadata-only, explicit recipient opens are idempotent, missed slot refuses late fill', async () => {
  assert.ok(slot, 'setup completed');
  assert.equal(Date.now() >= release, true, 'five bounded waits reached the real release instant');
  const { f, pairA, connections } = x;
  const due = value(await read(1, slot.id));
  assert.equal(due.slot.state, 'available'); assert.equal(due.slot.openedAt, null);
  assert.equal(Object.hasOwn(due, 'body'), false, 'GET has no latch side effect');
  const senderBeforeOpen = value(await read(0, slot.id));
  const outboxBefore = (await f.domainPool.query('SELECT count(*)::int n FROM outbox_events')).rows;
  // Disposable synthetic schema only: fail the receipt INSERT after the real
  // opening INSERT. Existing production guards remain installed and enabled.
  await f.domainPool.query(`CREATE FUNCTION fail_test_morning_open_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.operation='open' THEN RAISE EXCEPTION 'synthetic_receipt_failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_test_morning_open_receipt BEFORE INSERT ON morning_command_receipts
    FOR EACH ROW EXECUTE FUNCTION fail_test_morning_open_receipt()`);
  try {
    const failed = await open(1, slot.id, command({ confirm: true }));
    assert.equal(failed.status, 503);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM morning_openings WHERE slot_id=$1', [slot.id])).rows[0].n, 0);
    assert.equal((await f.domainPool.query("SELECT count(*)::int n FROM morning_command_receipts WHERE slot_id=$1 AND operation='open'", [slot.id])).rows[0].n, 0);
    const stillClosed = value(await read(1, slot.id));
    assert.equal(stillClosed.slot.openedAt, null); assert.equal(Object.hasOwn(stillClosed, 'body'), false);
  } finally {
    await f.domainPool.query('DROP TRIGGER fail_test_morning_open_receipt ON morning_command_receipts; DROP FUNCTION fail_test_morning_open_receipt()');
  }
  let loseAck = true; const openBodies = [];
  recipient = await morningAccount(f, 1, { beforeRequest: async (record, req) => {
    if (record.path.endsWith('/open')) openBodies.push(await req.clone().json());
  }, afterResponse: async record => {
    if (record.path.endsWith('/open') && loseAck) { loseAck = false; throw Error('Synthetic first-open ACK loss'); }
  } });
  await recipient.controller.mornings.list(); await recipient.controller.mornings.open(slot.id);
  assert.equal(recipient.controller.mornings.getSnapshot().status, 'unknown');
  assert.equal(recipient.controller.mornings.getSnapshot().opened, null);
  await recipient.controller.mornings.retry();
  assert.deepEqual(openBodies[1], openBodies[0]);
  assert.equal(recipient.controller.mornings.getSnapshot().opened.body, fillCommand.body);
  const opening = command({ confirm: true });
  const [a, b] = await Promise.all([open(1, slot.id, opening), open(1, slot.id, command({ confirm: true }))]);
  const first = value(a), concurrent = value(b);
  assert.equal(first.body, fillCommand.body); assert.equal(concurrent.body, fillCommand.body);
  assert.equal(first.slot.openedAt, concurrent.slot.openedAt); assert.notEqual(first.slot.openedAt, null);
  const replay = value(await open(1, slot.id, opening));
  assert.equal(replay.replay, true); assert.equal(replay.slot.openedAt, first.slot.openedAt);
  const reread = value(await read(1, slot.id));
  assert.equal(reread.body, fillCommand.body); assert.equal(reread.slot.openedAt, first.slot.openedAt);
  const senderAfterOpen = value(await read(0, slot.id));
  assert.deepEqual(senderAfterOpen.slot, senderBeforeOpen.slot); assert.equal(senderAfterOpen.body, senderBeforeOpen.body);
  assert.equal(Object.hasOwn(senderAfterOpen.slot, 'openedAt'), false);
  assert.deepEqual((await f.domainPool.query('SELECT count(*)::int n FROM outbox_events')).rows, outboxBefore);
  const missed = value(await read(0, emptySlot.id));
  assert.equal(missed.slot.state, 'missed'); assert.equal(Object.hasOwn(missed, 'body'), false);
  assert.equal((await open(0, emptySlot.id, command({ confirm: true }))).status >= 400, true);
  const lateFill = await request(f, connections[1], pairA, `/slots/${emptySlot.id}/body`, {
    method: 'PUT', body: command({ body: 'Not allowed after release' }),
  });
  assert.equal(lateFill.status, 409); assert.equal(lateFill.payload.error, 'slot_closed');
  await setMorningPreference(f, connections[1], pairA, 'Pacific/Kiritimati', '09:00', 1);
  const scheduleReplay = value(await request(f, connections[0], pairA, '/slots', { method: 'POST', body: scheduleCommand }));
  assert.equal(scheduleReplay.replay, true); assert.equal(scheduleReplay.slot.releaseAt, slot.releaseAt);
  assert.equal(value(await request(f, connections[0], pairA, `/slots/${slot.id}/body`, { method: 'PUT', body: fillCommand })).replay, true);
});


test('genuine morning latch survives injected trusted-clock rollback without changing the OS clock or exposing unopened content', async () => {
  assert.ok(slot, 'genuine release/open setup completed');
  const response = await x.f.call('sign-in/email', { email: 'reply-1@example.test', password });
  assert.equal(response.status, 200);
  const cookie = response.headers.getSetCookie().map(v => v.split(';')[0]).join('; ');
  const db = x.f.database();
  const principal = await db.sessionAuthority.authenticate(new Request('http://localhost:3123/read', {
    headers: { origin: 'http://localhost:3123', cookie },
  }));
  assert.ok(principal);
  const rollback = { ...db, now: () => new Date(release - 1000) };
  const result = await readMorning(rollback, principal, {
    coupleId: x.pairA, membershipEpoch: 1, slotId: slot.id, readId: randomUUID(),
  });
  assert.equal(result.ok, true); assert.equal(result.value.body, fillCommand.body);
  assert.equal(result.value.slot.state, 'available'); assert.notEqual(result.value.slot.openedAt, null);
  assert.equal(result.value.serverNow, new Date(release - 1000).toISOString());
  const sender = await preparedAuthor(x.f, db);
  assert.ok(sender);
  assert.equal((await preparedMorning(rollback,sender,{coupleId:x.pairA,membershipEpoch:1,slotId:slot.id,commandId:randomUUID(),expectedVersion:3,body:fillCommand.body},true)).error,'slot_closed');
  const history = await listMornings(rollback, principal, {
    coupleId: x.pairA, membershipEpoch: 1, readId: randomUUID(), direction: 'latest',
  });
  assert.equal(history.ok, true); assert.equal(history.value.lastAvailableId, slot.id);
  assert.equal(history.value.slots.find(s => s.id === slot.id).state, 'available');
});

registerMorningDiscussionTests(() => ({ ...x, slot, discussionSlot, release }));

registerMorningMutationUpgradeTest(() => ({ ...x, slot, discussionSlot, release }));
registerMorningDiscussionEditingTests(() => ({ ...x, slot, discussionSlot, release }));
registerMorningMutationNativeTests(() => ({ ...x, slot, discussionSlot, release }));

registerMorningNotificationLive(() => ({x,release,data:notificationData,slot}));
