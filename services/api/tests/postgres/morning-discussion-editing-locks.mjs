import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { mutateMorningDiscussion } from '../../src/morning-discussion-mutations.ts';
/** Call last with a genuinely available, own-authored discussion message. Expires only this synthetic session. */
export async function verifyMorningMutationTargetLock({ f, db, principal, coupleId, slotId, message }) {
    const lock = await f.domainPool.connect();
    try {
        await f.authPool.query(`UPDATE "session" SET "expiresAt"=clock_timestamp()+interval '2 seconds' WHERE id=$1`, [principal.sessionId]);
        await lock.query('BEGIN');
        const locker = (await lock.query('SELECT pg_backend_pid() pid')).rows[0].pid;
        await lock.query('SELECT id FROM morning_discussion_messages WHERE id=$1 FOR UPDATE', [message.id]);
        let waiter, updates = 0, bodyReads = 0;
        const tracked = { ...db, transaction: work => db.transaction(async (tx) => {
                waiter = (await tx.query('SELECT pg_backend_pid() pid')).rows[0].pid;
                return work({ query(sql, params) {
                        if (sql.startsWith('SELECT id,slot_id,couple_id'))
                            bodyReads++;
                        if (sql.startsWith('UPDATE morning_discussion_messages'))
                            updates++;
                        return tx.query(sql, params);
                    } });
            }) };
        const pending = mutateMorningDiscussion(tracked, principal, { coupleId, membershipEpoch: 1, slotId, messageId: message.id,
            commandId: randomUUID(), expectedVersion: message.version, body: 'Expired command never applied' }, 'edit');
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
        assert.equal(observed, true, 'target row contention proven with exact blocking backend');
        await delay(2100);
        await lock.query('COMMIT');
        assert.deepEqual(await pending, { ok: false, error: 'unavailable' });
        assert.equal(updates, 0);
        assert.equal(bodyReads, 0);
        const row = (await f.domainPool.query('SELECT body,version FROM morning_discussion_messages WHERE id=$1', [message.id])).rows[0];
        assert.equal(row.version, message.version);
        assert.equal(row.body, message.body);
    }
    finally {
        await lock.query('ROLLBACK').catch(() => { });
        lock.release();
    }
}
