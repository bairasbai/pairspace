import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { password } from './mobile-invitations-fixture.mjs';
import { sendMorningDiscussion, readMorningDiscussionMessage } from '../../src/morning-discussions.ts';
import { mutateMorningDiscussion } from '../../src/morning-discussion-mutations.ts';
import { verifyMorningMutationTargetLock } from './morning-discussion-editing-locks.mjs';
async function account(x, index) {
    const response = await x.f.call('sign-in/email', { email: `reply-${index}@example.test`, password });
    assert.equal(response.status, 200);
    const cookie = response.headers.getSetCookie().map(v => v.split(';')[0]).join('; ');
    const db = x.f.database();
    const principal = await db.sessionAuthority.authenticate(new Request('http://localhost:3123/read', { headers: { origin: 'http://localhost:3123', cookie } }));
    assert.ok(principal);
    return { db, principal };
}
const scope = x => ({ coupleId: x.pairA, membershipEpoch: 1, slotId: x.slot.id });
export function registerMorningMutationUpgradeTest(context) {
    test('genuine populated025 to026 upgrade preserves all reply snapshots; failed transaction restores old guard and schema', async () => {
        const x = context(), connection = await x.f.domainPool.connect();
        const columns = 'id,slot_id,couple_id,membership_epoch,author_id,client_id,seq::text,body,created_at::text';
        const before = (await connection.query(`SELECT ${columns} FROM morning_discussion_messages ORDER BY seq`)).rows;
        assert.ok(before.length >= 60);
        const receipts = (await connection.query('SELECT * FROM morning_discussion_receipts ORDER BY actor_id,command_id')).rows;
        const sql = await readFile(new URL('../../migrations/026_morning_discussion_mutations.sql', import.meta.url), 'utf8');
        try {
            await connection.query('BEGIN');
            await connection.query(sql);
            await connection.query('ROLLBACK');
            assert.equal((await connection.query(`SELECT to_jsonb(m)->>'version' AS version FROM morning_discussion_messages m LIMIT 1`)).rows[0].version, null);
            await assert.rejects(connection.query('UPDATE morning_discussion_messages SET body=body WHERE id=$1', [before[0].id]), /immutable_morning_fact/);
            await connection.query('BEGIN');
            await connection.query(sql);
            await connection.query('COMMIT');
            assert.deepEqual((await connection.query(`SELECT ${columns} FROM morning_discussion_messages ORDER BY seq`)).rows, before);
            assert.deepEqual((await connection.query('SELECT * FROM morning_discussion_receipts ORDER BY actor_id,command_id')).rows, receipts);
            assert.equal((await connection.query('SELECT count(*)::int n FROM morning_discussion_messages WHERE version<>1 OR edited_at IS NOT NULL OR deleted_at IS NOT NULL')).rows[0].n, 0);
            assert.equal((await connection.query('SELECT count(*)::int n FROM morning_discussion_mutation_receipts')).rows[0].n, 0);
        }
        finally {
            await connection.query('ROLLBACK').catch(() => { });
            connection.release();
        }
    });
}
export function registerMorningMutationNativeTests(context) {
    test('genuine recipient latch permits edits/deletion under simulated clock rollback with monotonic logical markers', async () => {
        const x = context(), { db, principal } = await account(x, 1);
        const created = await sendMorningDiscussion(db, principal, { ...scope(x), commandId: randomUUID(), body: 'Recipient native original' }, true);
        assert.equal(created.ok, true);
        const message = created.value.message;
        const rollback = { ...db, now: () => new Date(x.release - 1000) };
        const edited = await mutateMorningDiscussion(rollback, principal, { ...scope(x), messageId: message.id, commandId: randomUUID(), expectedVersion: 1, body: 'Recipient native changed' }, 'edit');
        assert.equal(edited.ok, true);
        assert.equal(edited.value.message.version, 2);
        assert.equal(edited.value.message.createdAt, message.createdAt);
        assert.equal(edited.value.message.seq, message.seq);
        assert.ok(edited.value.message.editedAt >= message.createdAt);
        const deleted = await mutateMorningDiscussion(rollback, principal, { ...scope(x), messageId: message.id, commandId: randomUUID(), expectedVersion: 2, confirm: true }, 'delete');
        assert.equal(deleted.ok, true);
        assert.equal(deleted.value.message.body, null);
        assert.equal(deleted.value.message.version, 3);
        assert.ok(deleted.value.message.deletedAt >= edited.value.message.editedAt);
        const read = await readMorningDiscussionMessage(rollback, principal, { ...scope(x), messageId: message.id, readId: randomUUID() });
        assert.equal(read.ok, true);
        assert.equal(read.value.message.body, null);
    });
    test('genuine mutation DB guards reject false edited marker, reset, resurrection, physical delete and closed-pair rawupdate', async () => {
        const x = context(), { db, principal } = await account(x, 0);
        const created = await sendMorningDiscussion(db, principal, { ...scope(x), commandId: randomUUID(), body: 'Native guard original' }, true);
        assert.equal(created.ok, true);
        const m = created.value.message;
        await assert.rejects(x.f.domainPool.query('UPDATE morning_discussion_messages SET version=version+1,edited_at=clock_timestamp() WHERE id=$1', [m.id]), /invalid_morning_discussion_edit/);
        await assert.rejects(x.f.domainPool.query('UPDATE morning_discussion_messages SET seq=seq+100000 WHERE id=$1', [m.id]), /immutable_morning_discussion_identity/);
        await assert.rejects(x.f.domainPool.query('DELETE FROM morning_discussion_messages WHERE id=$1', [m.id]), /immutable_morning_discussion_identity/);
        const lock = await x.f.domainPool.connect();
        try {
            await lock.query('BEGIN');
            await lock.query("UPDATE couples SET status='closed' WHERE id=$1", [x.pairA]);
            await assert.rejects(lock.query("UPDATE morning_discussion_messages SET body='Closed invalid',version=version+1,edited_at=clock_timestamp() WHERE id=$1", [m.id]), /morning_discussion_unavailable/);
            await lock.query('ROLLBACK');
        }
        finally {
            await lock.query('ROLLBACK').catch(() => { });
            lock.release();
        }
        const deleted = await mutateMorningDiscussion(db, principal, { ...scope(x), messageId: m.id, commandId: randomUUID(), expectedVersion: 1, confirm: true }, 'delete');
        assert.equal(deleted.ok, true);
        await assert.rejects(x.f.domainPool.query("UPDATE morning_discussion_messages SET body='Resurrected',deleted_at=NULL,version=version+1,edited_at=clock_timestamp() WHERE id=$1", [m.id]), /invalid_morning_discussion_revision/);
    });
    test('genuine own mutation rechecks session after exact target-row lock expires it', async () => {
        const x = context(), { db, principal } = await account(x, 0);
        const created = await sendMorningDiscussion(db, principal, { ...scope(x), commandId: randomUUID(), body: 'Target lock original' }, true);
        assert.equal(created.ok, true);
        await verifyMorningMutationTargetLock({ f: x.f, db, principal, coupleId: x.pairA, slotId: x.slot.id, message: created.value.message });
    });
}
