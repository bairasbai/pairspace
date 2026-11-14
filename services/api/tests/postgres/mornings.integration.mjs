import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { replyFixture } from './chat-replies-fixture.mjs';
import { commandMorning } from '../../src/morning-commands.ts';
import { listMornings, readMorning } from '../../src/morning-read.ts';
import { openMorning } from '../../src/morning-open.ts';
const scope = coupleId => ({ coupleId, membershipEpoch: 1 });
const pref = (pair, timezone = 'UTC', localTime = '09:00') => ({ ...scope(pair), commandId: randomUUID(), expectedVersion: 0, timezone, localTime });
const day = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const schedule = (pair, n = 5) => ({ ...scope(pair), commandId: randomUUID(), preferenceVersion: 1, localDate: day(n), offset: '+00:00' });
const detail = (pair, slotId) => ({ ...scope(pair), slotId, readId: randomUUID() });
function receiptFailure(db) {
    return { ...db, transaction: work => db.transaction(tx => work({ query(sql, params) {
                if (sql.includes('INSERT INTO morning_command_receipts'))
                    throw Error('synthetic_receipt_failure');
                return tx.query(sql, params);
            } })) };
}
test('morning native preference/assignment/fill atomicity, concurrency, privacy and immutable snapshots', async () => {
    const { f, a, b, db, principals: p } = await replyFixture();
    try {
        const oldEvents = (await f.domainPool.query('SELECT count(*)::int n FROM outbox_events')).rows[0].n;
        await assert.rejects(commandMorning(receiptFailure(db), p[1], pref(a), 'preference'), /synthetic_receipt_failure/);
        assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM morning_preferences')).rows[0].n, 0);
        assert.equal((await commandMorning(db, p[1], pref(a), 'preference')).ok, true);
        await assert.rejects(commandMorning(receiptFailure(db), p[0], schedule(a), 'schedule'), /synthetic_receipt_failure/);
        assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM morning_slots')).rows[0].n, 0);
        const attempts = await Promise.all([commandMorning(db, p[0], schedule(a), 'schedule'), commandMorning(db, p[0], schedule(a), 'schedule')]);
        assert.equal(attempts.filter(r => r.ok).length, 1);
        assert.equal(attempts.find(r => !r.ok).error, 'slot_exists');
        const slot = attempts.find(r => r.ok).value.slot;
        const fill = { ...scope(a), slotId: slot.id, commandId: randomUUID(), body: ' Synthetic\r\n🙂 ' };
        const before = await readMorning(db, p[1], detail(a, slot.id));
        await assert.rejects(commandMorning(receiptFailure(db), p[0], fill, 'fill'), /synthetic_receipt_failure/);
        assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM morning_content')).rows[0].n, 0);
        const fills = await Promise.all([commandMorning(db, p[0], fill, 'fill'), commandMorning(db, p[0], { ...fill, commandId: randomUUID() }, 'fill')]);
        assert.equal(fills.filter(r => r.ok).length, 1);
        assert.equal(fills.find(r => !r.ok).error, 'slot_filled');
        const after = await readMorning(db, p[1], detail(a, slot.id));
        assert.deepEqual(after.value.slot, before.value.slot);
        assert.equal(Object.hasOwn(after.value, 'body'), false);
        assert.equal(Object.hasOwn(after.value.slot, 'prepared'), false);
        assert.equal((await commandMorning(db, p[1], { ...fill, commandId: randomUUID() }, 'fill')).error, 'unavailable');
        assert.equal((await readMorning(db, p[2], detail(a, slot.id))).error, 'unavailable');
        assert.equal((await readMorning(db, p[2], detail(b, slot.id))).error, 'unavailable');
        assert.equal((await readMorning(db, p[0], { ...detail(a, slot.id), membershipEpoch: 2 })).error, 'stale_membership');
        assert.equal((await openMorning(db, p[1], { ...scope(a), slotId: slot.id, commandId: randomUUID(), confirm: true })).error, 'slot_closed');
        await assert.rejects(f.domainPool.query('UPDATE morning_slots SET release_at=release_at+interval \'1 day\' WHERE id=$1', [slot.id]), /immutable_morning_fact/);
        await assert.rejects(f.domainPool.query('UPDATE morning_content SET body=\'changed\' WHERE slot_id=$1', [slot.id]), /immutable_morning_fact/);
        await assert.rejects(f.domainPool.query('DELETE FROM morning_command_receipts'), /immutable_morning_fact/);
        await assert.rejects(f.domainPool.query(`INSERT INTO morning_command_receipts(actor_id,command_id,couple_id,membership_epoch,operation,fingerprint,slot_id)
   VALUES($1,$2,$3,1,'fill',repeat('a',64),$4)`, [p[1].userId, randomUUID(), a, slot.id]), /invalid_morning_receipt_scope/);
        await assert.rejects(f.domainPool.query('INSERT INTO morning_openings(slot_id,recipient_id,opened_at) VALUES($1,$2,$3)', [slot.id, p[1].userId, slot.releaseAt]), /morning_open_unavailable/);
        assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM outbox_events')).rows[0].n, oldEvents);
    }
    finally {
        await f.close();
    }
});
test('morning native date-line offset snapshots and populated previous schema remain unchanged', async () => {
    const { f, a, db, principals: p } = await replyFixture();
    try {
        const oldMessages = (await f.domainPool.query('SELECT id,body,version FROM chat_messages ORDER BY id')).rows;
        assert.equal((await commandMorning(db, p[1], pref(a, 'Pacific/Kiritimati', '00:30'), 'preference')).ok, true);
        const input = { ...schedule(a, 7), offset: '+14:00' };
        const result = await commandMorning(db, p[0], input, 'schedule');
        assert.equal(result.ok, true);
        const actual = (await f.domainPool.query(`SELECT release_at AT TIME ZONE timezone AS wall, local_date::text,
    to_char(release_at AT TIME ZONE timezone,'HH24:MI') AS time FROM morning_slots WHERE id=$1`, [result.value.slot.id])).rows[0];
        assert.equal(actual.local_date, input.localDate);
        assert.equal(actual.time, '00:30');
        assert.equal(result.value.slot.offset, '+14:00');
        assert.deepEqual((await f.domainPool.query('SELECT id,body,version FROM chat_messages ORDER BY id')).rows, oldMessages);
        const window = await listMornings(db, p[1], { ...scope(a), readId: randomUUID(), direction: 'latest' });
        assert.equal(window.value.slots[0].state, 'sealed');
        assert.equal(window.value.lastAvailableId, null);
    }
    finally {
        await f.close();
    }
});
test('morning writes reauthorize after an observed preference-row lock expires the session', async () => {
    const { f, a, db, principals: p } = await replyFixture();
    const lock = await f.domainPool.connect();
    try {
        assert.equal((await commandMorning(db, p[1], pref(a), 'preference')).ok, true);
        await f.authPool.query(`UPDATE "session" SET "expiresAt"=clock_timestamp()+interval '2 seconds' WHERE id=$1`, [p[1].sessionId]);
        await lock.query('BEGIN');
        const locker = (await lock.query('SELECT pg_backend_pid() pid')).rows[0].pid;
        await lock.query('SELECT version FROM morning_preferences WHERE couple_id=$1 FOR UPDATE', [a]);
        let waiter;
        const tracked = { ...db, transaction: work => db.transaction(async (tx) => { waiter = (await tx.query('SELECT pg_backend_pid() pid')).rows[0].pid; return work(tx); }) };
        const pending = commandMorning(tracked, p[1], { ...pref(a), expectedVersion: 1 }, 'preference');
        for (let n = 0; n < 100 && !waiter; n++)
            await delay(5);
        let observed = false;
        for (let n = 0; n < 150; n++) {
            const row = (await f.domainPool.query(`SELECT wait_event_type='Lock' AND $2=ANY(pg_blocking_pids(pid)) AS blocked FROM pg_stat_activity WHERE pid=$1`, [waiter, locker])).rows[0];
            if (row?.blocked) {
                observed = true;
                break;
            }
            await delay(10);
        }
        assert.equal(observed, true, 'actual lock and exact blocking PID');
        await delay(2100);
        await lock.query('COMMIT');
        assert.equal((await pending).error, 'unavailable');
        assert.equal((await f.domainPool.query('SELECT version FROM morning_preferences WHERE couple_id=$1', [a])).rows[0].version, 1);
    }
    finally {
        await lock.query('ROLLBACK').catch(() => { });
        lock.release();
        await f.close();
    }
});
