import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { replyFixture } from './chat-replies-fixture.mjs';
import { commandMorning } from '../../src/morning-commands.ts';
import { draftMorning } from '../../src/morning-draft.ts';
import { readMorning } from '../../src/morning-read.ts';
test('private draft PostgreSQL CAS, receipt rollback and sealed isolation', async () => {
    const { f, a, b, db, principals: p } = await replyFixture();
    try {
        const scope = { coupleId: a, membershipEpoch: 1 };
        assert.equal((await commandMorning(db, p[1], { ...scope, commandId: randomUUID(), expectedVersion: 0, timezone: 'UTC', localTime: '09:00' }, 'preference')).ok, true);
        const scheduled = await commandMorning(db, p[0], { ...scope, commandId: randomUUID(), preferenceVersion: 1, localDate: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10), offset: '+00:00' }, 'schedule');
        assert.equal(scheduled.ok, true);
        const slotId = scheduled.value.slot.id;
        const fill = { ...scope, slotId, commandId: randomUUID(), body: 'Synthetic original' };
        assert.equal((await draftMorning(db, p[0], { ...fill, expectedVersion: 0 }, true)).ok, true);
        const read = { ...scope, slotId, readId: randomUUID() }, base = { ...scope, slotId, expectedVersion: 1 };
        const sealed = await readMorning(db, p[1], read);
        const first = { ...base, commandId: randomUUID(), body: 'Synthetic edit' };
        const results = await Promise.all([draftMorning(db, p[0], first, true), draftMorning(db, p[0], { ...first, commandId: randomUUID(), body: 'Other edit' }, true)]);
        assert.equal(results.filter(r => r.ok).length, 1);
        assert.equal(results.find(r => !r.ok).error, 'version_conflict');
        const current = (await draftMorning(db, p[0], read, false)).value;
        assert.equal(current.version, 2);
        const noop = { ...base, expectedVersion: 2, body: current.body, commandId: randomUUID() };
        assert.equal((await draftMorning(db, p[0], noop, true)).value.version, 2);
        assert.equal((await draftMorning(db, p[1], read, false)).error, 'unavailable');
        assert.equal((await draftMorning(db, p[2], read, false)).error, 'unavailable');
        assert.equal((await draftMorning(db, p[2], { ...read, coupleId: b }, false)).error, 'unavailable');
        assert.deepEqual((await readMorning(db, p[1], read)).value.slot, sealed.value.slot);
        const bad = { ...db, transaction: work => db.transaction(tx => work({ query(sql, params) { if (sql.includes('INSERT INTO morning_draft_receipts'))
                    throw Error('receipt failure'); return tx.query(sql, params); } })) };
        await assert.rejects(draftMorning(bad, p[0], { ...noop, body: 'Rollback', commandId: randomUUID() }, true), /receipt failure/);
        assert.equal((await draftMorning(db, p[0], read, false)).value.body, current.body);
        assert.equal((await commandMorning(db, p[0], fill, 'fill')).ok, true);
        assert.equal((await draftMorning(db, p[0], { ...fill, expectedVersion: 0 }, true)).value.body, current.body);
        await assert.rejects(f.domainPool.query('UPDATE morning_drafts SET body=$2 WHERE slot_id=$1', [slotId, 'raw invalid']), /immutable_morning_draft_identity/);
        await assert.rejects(f.domainPool.query('DELETE FROM morning_draft_receipts'), /immutable_morning_fact/);
        await assert.rejects(f.domainPool.query('INSERT INTO morning_draft_receipts(actor_id,command_id,slot_id,fingerprint) VALUES($1,$2,$3,$4)', [p[1].userId, randomUUID(), slotId, 'a'.repeat(64)]), /invalid_morning_draft_scope/);
        const late = { ...db, now: () => new Date(Date.parse(scheduled.value.slot.releaseAt) + 1) };
        assert.equal((await draftMorning(late, p[0], read, false)).value.body, current.body);
        assert.equal((await draftMorning(late, p[0], { ...noop, commandId: randomUUID() }, true)).ok, true);
        assert.equal((await draftMorning(late, p[0], noop, true)).value.replay, true);
    }
    finally {
        await f.close();
    }
});
