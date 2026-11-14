import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { replyFixture } from './chat-replies-fixture.mjs';
import { commandMorning } from '../../src/morning-commands.ts';
import { readMorningDiscussion, sendMorningDiscussion } from '../../src/morning-discussions.ts';
const scope = coupleId => ({ coupleId, membershipEpoch: 1 });
async function setup() {
    const state = await replyFixture();
    const { a, db, principals: p } = state;
    const pref = await commandMorning(db, p[1], { ...scope(a), commandId: randomUUID(), expectedVersion: 0, timezone: 'UTC', localTime: '09:00' }, 'preference');
    assert.equal(pref.ok, true);
    const slot = await commandMorning(db, p[0], { ...scope(a), commandId: randomUUID(), preferenceVersion: 1, localDate: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10), offset: '+00:00' }, 'schedule');
    assert.equal(slot.ok, true);
    const slotId = slot.value.slot.id;
    assert.equal((await commandMorning(db, p[0], { ...scope(a), slotId, commandId: randomUUID(), body: 'Synthetic original morning' }, 'fill')).ok, true);
    return { ...state, slotId };
}
test('discussion native sealed and unopened denial has no rows/counts/body and no SQL insert bypass', async () => {
    const { f, a, b, db, principals: p, slotId } = await setup();
    try {
        const original = (await f.domainPool.query('SELECT slot_id,body,filled_at::text FROM morning_content WHERE slot_id=$1', [slotId])).rows;
        const outbox = (await f.domainPool.query('SELECT count(*)::int n FROM outbox_events')).rows[0].n;
        const read = { ...scope(a), slotId, readId: randomUUID(), direction: 'first' };
        for (const actor of [p[0], p[1], p[2]]) {
            assert.deepEqual(await readMorningDiscussion(db, actor, read), { ok: false, error: 'unavailable' });
            assert.deepEqual(await sendMorningDiscussion(db, actor, { ...scope(a), slotId, commandId: randomUUID(), body: 'Hidden reply' }), { ok: false, error: 'unavailable' });
        }
        assert.deepEqual(await readMorningDiscussion(db, p[0], { ...read, slotId: randomUUID() }), { ok: false, error: 'unavailable' });
        assert.deepEqual(await readMorningDiscussion(db, p[2], { ...read, coupleId: b }), { ok: false, error: 'unavailable' });
        assert.equal((await readMorningDiscussion(db, p[0], { ...read, membershipEpoch: 2 })).error, 'stale_membership');
        for (const actor of [p[0].userId, p[1].userId, p[2].userId]) {
            await assert.rejects(f.domainPool.query(`INSERT INTO morning_discussion_messages(slot_id,couple_id,membership_epoch,author_id,client_id,body,created_at)
    VALUES($1,$2,1,$3,$4,'No bypass',clock_timestamp())`, [slotId, a, actor, randomUUID()]), /morning_discussion_unavailable/);
        }
        assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM morning_discussion_messages')).rows[0].n, 0);
        assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM morning_discussion_receipts')).rows[0].n, 0);
        assert.deepEqual((await f.domainPool.query('SELECT slot_id,body,filled_at::text FROM morning_content WHERE slot_id=$1', [slotId])).rows, original);
        assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM outbox_events')).rows[0].n, outbox);
    }
    finally {
        await f.close();
    }
});
test('discussion rechecks real session expiry after the final slot lock with no discussion SELECT', async () => {
    const { f, a, db, principals: p, slotId } = await setup();
    const lock = await f.domainPool.connect();
    try {
        await f.authPool.query(`UPDATE "session" SET "expiresAt"=clock_timestamp()+interval '2 seconds' WHERE id=$1`, [p[0].sessionId]);
        await lock.query('BEGIN');
        const locker = (await lock.query('SELECT pg_backend_pid() pid')).rows[0].pid;
        await lock.query('SELECT id FROM morning_slots WHERE id=$1 FOR UPDATE', [slotId]);
        let waiter, privateQueries = 0;
        const tracked = { ...db, transaction: work => db.transaction(async (tx) => {
                waiter = (await tx.query('SELECT pg_backend_pid() pid')).rows[0].pid;
                return work({ query(sql, params) { if (sql.includes('morning_discussion_'))
                        privateQueries++; return tx.query(sql, params); } });
            }) };
        const pending = readMorningDiscussion(tracked, p[0], { ...scope(a), slotId, readId: randomUUID(), direction: 'first' });
        for (let n = 0; n < 100 && !waiter; n++)
            await delay(5);
        let observed = false;
        for (let n = 0; n < 150; n++) {
            const row = (await f.domainPool.query(`SELECT wait_event_type='Lock' AND $2=ANY(pg_blocking_pids(pid)) blocked FROM pg_stat_activity WHERE pid=$1`, [waiter, locker])).rows[0];
            if (row?.blocked) {
                observed = true;
                break;
            }
            await delay(10);
        }
        assert.equal(observed, true, 'actual lock wait and exact blocking backend');
        await delay(2100);
        await lock.query('COMMIT');
        assert.deepEqual(await pending, { ok: false, error: 'unavailable' });
        assert.equal(privateQueries, 0);
    }
    finally {
        await lock.query('ROLLBACK').catch(() => { });
        lock.release();
        await f.close();
    }
});
