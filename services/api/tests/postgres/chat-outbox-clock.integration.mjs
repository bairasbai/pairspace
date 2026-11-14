import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {replyFixture} from './chat-replies-fixture.mjs';
import {sendMessage} from '../../src/chat.ts';
import {simulateChatOutbox} from '../../src/chat-outbox.ts';
import {saveNotificationPreferences} from '../../src/notification-preferences.ts';

async function observedMembershipWait(pool, state, blockerPid) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (state.pid && state.membershipRequested) {
      const row = (await pool.query(`SELECT wait_event_type='Lock'
        AND $2=ANY(pg_blocking_pids(pid)) blocked FROM pg_stat_activity WHERE pid=$1`,
        [state.pid, blockerPid])).rows[0];
      if (row?.blocked) return;
    }
    await delay(10);
  }
  assert.fail('actual PostgreSQL membership FOR SHARE lock wait was not observed');
}

for (const boundary of ['quiet']) test(`chat simulation samples clock after membership wait across ${boundary} boundary`, async () => {
  const {f, a, db, principals: p, usersA} = await replyFixture();
  let holder, pending;
  try {
    const scope = {coupleId:a, membershipEpoch:1};
    let clock = new Date(boundary === 'expiry' ? '2030-01-01T12:00:00.000Z' : '2030-01-02T11:00:00.000Z');
    const sourceDb = {...db, now:() => new Date(clock)};
    assert.equal((await saveNotificationPreferences(db, p[1], {...scope,
      commandId:randomUUID(), expectedVersion:0, care:false, chat:true, letter:false,
      quiet:boundary === 'quiet' ? {start:'12:00', end:'13:00', timezone:'UTC'} : null})).ok, true);
    const sent = await sendMessage(db, p[0], {...scope, clientId:randomUUID(),body:'Synthetic'});
    assert.equal(sent.ok, true);
    const eventId = (await f.domainPool.query('SELECT id FROM outbox_events WHERE message_id=$1',
      [sent.value.message.id])).rows[0].id;
    clock = new Date('2030-01-02T11:59:59.999Z');
    holder = await f.domainPool.connect();
    await holder.query('BEGIN');
    const blockerPid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    // Hold only a member row: worker must already own pair/outbox locks while waiting.
    await holder.query('SELECT user_id FROM couple_members WHERE couple_id=$1 AND user_id=$2 FOR UPDATE', [a, usersA[1]]);
    const state = {pid:null, pairLocked:false, membershipRequested:false};
    const workerDb = {...sourceDb, transaction:work => db.transaction(async tx => {
      state.pid = (await tx.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      return work({async query(sql, args) {
        if (sql.includes('FROM couple_members') && sql.includes('FOR SHARE')) state.membershipRequested = true;
        const result = await tx.query(sql, args);
        if (sql.includes('FROM couples') && sql.includes('FOR UPDATE')) state.pairLocked = true;
        return result;
      }});
    })};
    pending = simulateChatOutbox(workerDb, eventId);
    await observedMembershipWait(f.domainPool, state, blockerPid);
    assert.equal(state.pairLocked, true, 'worker owns pair lock before membership wait');
    // Inject a deterministic server-clock boundary only after real lock contention.
    clock = new Date('2030-01-02T12:00:00.000Z');
    await holder.query('COMMIT');
    holder.release(); holder = null;
    const result = await pending; pending = null;
    assert.equal(result.ok, true);
    assert.equal(result.value.reason, boundary === 'expiry' ? 'expired' : 'quiet_hours');
    assert.equal(result.value.state, 'simulation_blocked');
    assert.equal(result.value.preferenceVersion, boundary === 'expiry' ? null : 1);
    assert.equal(result.value.asOf, clock.toISOString());
    const persisted = (await f.domainPool.query(`SELECT s.reason, s.evaluated_at, o.processed_at
      FROM chat_notification_simulations s JOIN outbox_events o ON o.id=s.event_id WHERE s.event_id=$1`, [eventId])).rows[0];
    assert.equal(new Date(persisted.evaluated_at).toISOString(), clock.toISOString());
    assert.equal(persisted.processed_at, null);
    clock = new Date('2030-01-02T14:00:00.000Z');
    const replay = await simulateChatOutbox(sourceDb, eventId);
    assert.equal(replay.value.replay, true);
    assert.equal(replay.value.id, result.value.id);
    assert.equal(replay.value.reason, result.value.reason);
    assert.equal(replay.value.asOf, result.value.asOf);
  } finally {
    if (holder) { await holder.query('ROLLBACK'); holder.release(); }
    if (pending) await pending.catch(() => {});
    await f.close();
  }
});
