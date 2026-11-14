import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { replyFixture } from './chat-replies-fixture.mjs';
import { createScaleSlot, publishScaleSlot, removeScaleSlot, listScaleSlots } from '../../src/day-scale.ts';
import { leavePair } from '../../src/pair-leave.ts';
test('day scale isolation, CAS, fresh re-publication, midnight/auth FK rollback and per-author capacity', async () => {
    const { f, a, b, db, principals: p, usersA } = await replyFixture();
    let holder, pending;
    const scope = { coupleId: a, membershipEpoch: 1 }, fixed = { ...db, now: () => new Date('2026-11-10T12:00:00Z') };
    const create = (date = '2026-11-10', timezone = 'UTC', value = 0) => ({ ...scope, commandId: randomUUID(), expectedDate: date, timezone, value });
    const action = s => ({ ...scope, commandId: randomUUID(), slotId: s.id, expectedVersion: s.version });
    try {
        const original = create(), dupes = await Promise.all(Array.from({ length: 4 }, () => createScaleSlot(fixed, p[0], original)));
        assert.ok(dupes.every(r => r.ok));
        assert.equal(dupes.filter(r => !r.value.replay).length, 1);
        const first = dupes[0].value.slot;
        assert.equal(first.value, 0);
        assert.equal((await listScaleSlots(fixed, p[2], scope)).error, 'unavailable');
        assert.equal((await listScaleSlots(fixed, p[0], { ...scope, coupleId: b })).error, 'unavailable');
        assert.equal((await publishScaleSlot(fixed, p[1], { ...action(first), value: 100 })).error, 'unavailable');
        const duplicate = await createScaleSlot(fixed, p[0], create('2026-11-10', 'Etc/UTC', 50));
        assert.equal(duplicate.error, 'version_conflict');
        assert.deepEqual(duplicate.current, first);
        const races = await Promise.all([publishScaleSlot(fixed, p[0], { ...action(first), value: 50 }), removeScaleSlot(fixed, p[0], action(first))]);
        assert.equal(races.filter(r => r.ok).length, 1);
        assert.equal(races.find(r => !r.ok).error, 'version_conflict');
        let current = races.find(r => r.ok).value.slot;
        if (current.state === 'active')
            current = (await removeScaleSlot(fixed, p[0], action(current))).value.slot;
        assert.equal('value' in current, false);
        assert.equal((await f.domainPool.query('SELECT value FROM day_scale WHERE id=$1', [current.id])).rows[0].value, null);
        const removedRetry = await createScaleSlot(fixed, p[0], original);
        assert.deepEqual(removedRetry.value.slot, current);
        const fresh = await publishScaleSlot(fixed, p[0], { ...action(current), value: 88 });
        assert.equal(fresh.value.slot.value, 88);
        assert.equal(fresh.value.slot.version, current.version + 1);
        assert.deepEqual((await createScaleSlot(fixed, p[0], original)).value.slot, fresh.value.slot);
        assert.equal((await publishScaleSlot(fixed, p[0], { ...action(fresh.value.slot), value: 88 })).value.slot.version, fresh.value.slot.version);
        assert.equal((await createScaleSlot(fixed, p[1], create('2026-11-11', 'Pacific/Kiritimati', 100))).ok, true);
        assert.equal((await createScaleSlot(fixed, p[1], create('2026-11-10', 'Pacific/Kiritimati', 100))).error, 'date_mismatch');
        // A real membership lock blocks INSERT's FK. A new local day during the wait
        // must roll back both new slot and receipt, never silently move the printed date.
        holder = await f.domainPool.connect();
        await holder.query('BEGIN');
        const blocker = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
        await holder.query('SELECT user_id FROM couple_members WHERE couple_id=$1 AND user_id=$2 FOR UPDATE', [a, usersA[0]]);
        let instant = new Date('2026-11-12T23:59:59Z'), pid, insertRequested = false;
        const waitingDb = { ...db, now: () => instant, transaction: work => db.transaction(async (tx) => { pid = (await tx.query('SELECT pg_backend_pid() pid')).rows[0].pid; return work({ query(sql, args) { if (sql.startsWith('INSERT INTO day_scale('))
                    insertRequested = true; return tx.query(sql, args); } }); }) };
        const midnight = create('2026-11-12');
        pending = createScaleSlot(waitingDb, p[0], midnight);
        pending.catch(() => { });
        let observed = false;
        for (let i = 0; i < 150; i++) {
            if (pid && insertRequested)
                observed = (await f.domainPool.query('SELECT $2=ANY(pg_blocking_pids(pid)) blocked FROM pg_stat_activity WHERE pid=$1', [pid, blocker])).rows[0]?.blocked;
            if (observed)
                break;
            await delay(10);
        }
        assert.equal(observed, true);
        instant = new Date('2026-11-13T00:00:01Z');
        await holder.query('COMMIT');
        holder.release();
        holder = null;
        assert.deepEqual(await pending, { ok: false, error: 'date_mismatch' });
        pending = null;
        assert.equal((await f.domainPool.query('SELECT id FROM day_scale WHERE couple_id=$1 AND local_date=$2', [a, '2026-11-12'])).rowCount, 0);
        assert.equal((await f.domainPool.query('SELECT command_id FROM day_scale_commands WHERE command_id=$1', [midnight.commandId])).rowCount, 0);
        // Receipt FK after an existing-slot UPDATE: session expiry rolls value back.
        holder = await f.domainPool.connect();
        await holder.query('BEGIN');
        const authBlocker = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
        await holder.query('SELECT user_id FROM couple_members WHERE couple_id=$1 AND user_id=$2 FOR UPDATE', [a, usersA[0]]);
        let receiptRequested = false;
        pid = undefined;
        const limited = { ...p[0], tokenExpiresAt: Math.floor(Date.now() / 1000) + 2 };
        const expiryDb = { ...fixed, transaction: work => db.transaction(async (tx) => { pid = (await tx.query('SELECT pg_backend_pid() pid')).rows[0].pid; return work({ query(sql, args) { if (sql.startsWith('INSERT INTO day_scale_commands'))
                    receiptRequested = true; return tx.query(sql, args); } }); }) };
        const update = { ...action(fresh.value.slot), value: 77 };
        pending = publishScaleSlot(expiryDb, limited, update);
        pending.catch(() => { });
        observed = false;
        for (let i = 0; i < 150; i++) {
            if (pid && receiptRequested)
                observed = (await f.domainPool.query('SELECT $2=ANY(pg_blocking_pids(pid)) blocked FROM pg_stat_activity WHERE pid=$1', [pid, authBlocker])).rows[0]?.blocked;
            if (observed)
                break;
            await delay(10);
        }
        assert.equal(observed, true);
        while (Date.now() < limited.tokenExpiresAt * 1000)
            await delay(10);
        await holder.query('COMMIT');
        holder.release();
        holder = null;
        assert.deepEqual(await pending, { ok: false, error: 'unavailable' });
        pending = null;
        assert.equal((await f.domainPool.query('SELECT value FROM day_scale WHERE id=$1', [first.id])).rows[0].value, 88);
        for (const actor of [p[0], p[1]])
            for (let i = 1; i <= 99; i++) {
                const date = new Date(Date.UTC(2027, 0, i, 12)), data = create(date.toISOString().slice(0, 10), 'UTC', i);
                assert.equal((await createScaleSlot({ ...db, now: () => date }, actor, data)).ok, true);
            }
        const all = await listScaleSlots(fixed, p[0], scope);
        assert.equal(all.value.slots.length, 200);
        assert.equal(all.value.ownUsed, 100);
        assert.equal((await createScaleSlot({ ...db, now: () => new Date('2028-01-01') }, p[0], create('2028-01-01'))).error, 'capacity_reached');
        assert.equal((await removeScaleSlot(fixed, p[0], action(fresh.value.slot))).ok, true);
        await assert.rejects(f.domainPool.query("UPDATE day_scale SET timezone='Etc/UTC',version=version+1 WHERE id=$1", [first.id]));
        assert.equal((await leavePair(db, p[1], { ...scope, commandId: randomUUID(), confirm: true })).ok, true);
        assert.equal((await listScaleSlots(db, p[0], scope)).error, 'unavailable');
        assert.equal((await createScaleSlot(db, p[0], original)).error, 'unavailable');
    }
    finally {
        if (holder) {
            await holder.query('ROLLBACK');
            holder.release();
        }
        if (pending)
            await pending.catch(() => { });
        await f.close();
    }
});
