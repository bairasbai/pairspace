import { Buffer } from 'node:buffer';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { replyFixture } from './chat-replies-fixture.mjs';
import { createStem, completeStem, skipStem, removeAuthorBundle, removeRecipientContinuation, listStems } from '../../src/stems.ts';
import { leavePair } from '../../src/pair-leave.ts';
test('stems SQL projection, terminal races, independent removals, capacity and receipt-lock rollback', async () => {
    const { f, a, b, db, principals: p, usersA } = await replyFixture();
    let holder, pending;
    const scope = { coupleId: a, membershipEpoch: 1 };
    const create = () => ({ ...scope, commandId: randomUUID(), beginning: 'Synthetic beginning', ownContinuation: 'Private author continuation' });
    const action = r => ({ ...scope, commandId: randomUUID(), roundId: r.id, expectedVersion: r.version });
    const read = async (id, actor = p[0]) => (await listStems(db, actor, scope)).value.rounds.find(r => r.id === id);
    const trace = () => { const sqls = []; return { sqls, db: { ...db, transaction: work => db.transaction(tx => work({ query(sql, args) { sqls.push(sql); return tx.query(sql, args); } })) } }; };
    const privateQueries = sqls => sqls.filter(s => s.startsWith('SELECT') && /\bauthor_continuation\b/.test(s));
    try {
        const original = create(), dupes = await Promise.all(Array.from({ length: 4 }, () => createStem(db, p[0], original)));
        assert.ok(dupes.every(r => r.ok));
        assert.equal(dupes.filter(r => !r.value.replay).length, 1);
        const first = dupes[0].value.round;
        assert.equal(first.authorContinuation, original.ownContinuation);
        assert.equal(first.recipientId, p[1].userId);
        assert.equal((await listStems(db, p[2], scope)).error, 'unavailable');
        assert.equal((await listStems(db, p[0], { ...scope, coupleId: b })).error, 'unavailable');
        const waitingTrace = trace();
        const waiting = (await listStems(waitingTrace.db, p[1], scope)).value.rounds[0];
        assert.equal('authorContinuation' in waiting, false);
        assert.deepEqual(privateQueries(waitingTrace.sqls), []);
        const skipTrace = trace(), skip = { ...action(first) };
        assert.equal((await skipStem(skipTrace.db, p[1], skip)).ok, true);
        assert.deepEqual(privateQueries(skipTrace.sqls), []);
        const replayTrace = trace();
        assert.equal((await skipStem(replayTrace.db, p[1], skip)).value.replay, true);
        assert.deepEqual(privateQueries(replayTrace.sqls), []);
        assert.equal((await read(first.id, p[0])).authorContinuation, original.ownContinuation);
        assert.equal('authorContinuation' in await read(first.id, p[1]), false);
        assert.equal((await removeAuthorBundle(db, p[0], { ...action(first), expectedVersion: 2 })).value.round.phase, 'skipped');
        // Deterministic terminal-first schedules prove privacy independently of
        // which participant happens to win the concurrent races below.
        for (const terminal of ['skip', 'withdraw']) {
            const before = (await createStem(db, p[0], create())).value.round;
            const staleCommand = { ...action(before), continuation: 'Too late but valid' };
            const ended = terminal === 'skip'
                ? await skipStem(db, p[1], action(before))
                : await removeAuthorBundle(db, p[0], action(before));
            assert.equal(ended.ok, true);
            const terminalTrace = trace();
            const rejected = await completeStem(terminalTrace.db, p[1], staleCommand);
            assert.equal(rejected.error, 'version_conflict');
            assert.equal(rejected.current.phase, terminal === 'skip' ? 'skipped' : 'withdrawn');
            assert.equal('authorContinuation' in rejected.current, false);
            assert.equal('recipientContinuation' in rejected.current, false);
            assert.deepEqual(privateQueries(terminalTrace.sqls), []);
            assert.equal((await f.domainPool.query('SELECT command_id FROM stem_commands WHERE command_id=$1', [staleCommand.commandId])).rowCount, 0);
        }
        for (const competitor of ['skip', 'withdraw']) {
            const r = (await createStem(db, p[0], create())).value.round;
            const completed = { ...action(r), continuation: 'Recipient continuation' };
            const pair = await Promise.all([completeStem(db, p[1], completed), competitor === 'skip' ? skipStem(db, p[1], action(r)) : removeAuthorBundle(db, p[0], action(r))]);
            assert.equal(pair.filter(x => x.ok).length, 1);
            assert.equal(pair.find(x => !x.ok).error, 'version_conflict');
            const current = await read(r.id, p[1]);
            if (current.phase === 'completed')
                assert.equal(current.authorContinuation, 'Private author continuation');
            else {
                assert.equal('authorContinuation' in current, false);
                assert.ok(['skipped', 'withdrawn'].includes(current.phase));
            }
        }
        const round = (await createStem(db, p[0], create())).value.round;
        assert.equal((await completeStem(db, p[0], { ...action(round), continuation: 'self' })).error, 'unavailable');
        const invalidTrace = trace();
        assert.equal((await completeStem(invalidTrace.db, p[1], { ...action(round), continuation: '' })).error, 'invalid_request');
        assert.deepEqual(privateQueries(invalidTrace.sqls), []);
        const complete = { ...action(round), continuation: 'Preserve my continuation' };
        const completed = (await completeStem({ ...db, now: () => new Date('2000-01-01') }, p[1], complete)).value.round;
        assert.equal(completed.completedAt, round.createdAt);
        const completedTrace = trace();
        const staleCompleted = await completeStem(completedTrace.db, p[1], { ...complete, commandId: randomUUID() });
        assert.equal(staleCompleted.error, 'version_conflict');
        assert.equal(staleCompleted.current.authorContinuation, 'Private author continuation');
        assert.equal(staleCompleted.current.recipientContinuation, complete.continuation);
        assert.equal(staleCompleted.current.phase, 'completed');
        assert.equal(privateQueries(completedTrace.sqls).length, 1);

        const split = await Promise.all([removeAuthorBundle(db, p[0], action(completed)), removeRecipientContinuation(db, p[1], action(completed))]);
        assert.equal(split.filter(x => x.ok).length, 1);
        assert.equal(split.find(x => !x.ok).error, 'version_conflict');
        const middle = split.find(x => x.ok).value.round;
        if (middle.authorTextState === 'removed') {
            assert.equal(middle.recipientContinuation, complete.continuation);
            await removeRecipientContinuation(db, p[1], action(middle));
        }
        else {
            assert.equal(middle.authorContinuation, 'Private author continuation');
            await removeAuthorBundle(db, p[0], action(middle));
        }
        const removed = await read(round.id, p[1]);
        assert.equal(removed.version, 4);
        assert.equal(removed.phase, 'completed');
        assert.equal('authorContinuation' in removed, false);
        assert.equal('recipientContinuation' in removed, false);
        assert.deepEqual((await completeStem(db, p[1], complete)).value.round, removed);
        await assert.rejects(f.domainPool.query("UPDATE stems SET phase='waiting',version=1 WHERE id=$1", [round.id]));
        const raw = (await f.domainPool.query('SELECT beginning,author_continuation,recipient_continuation FROM stems WHERE id=$1', [round.id])).rows[0];
        assert.deepEqual(raw, { beginning: null, author_continuation: null, recipient_continuation: null });
        // Receipt membership FK holds the completed UPDATE uncommitted. Real session
        // expiry after the observed wait rolls back phase, body, timestamp and receipt.
        const lockRound = (await createStem(db, p[0], create())).value.round;
        holder = await f.domainPool.connect();
        await holder.query('BEGIN');
        const blocker = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
        await holder.query('SELECT user_id FROM couple_members WHERE couple_id=$1 AND user_id=$2 FOR UPDATE', [a, usersA[1]]);
        const limited = { ...p[1], tokenExpiresAt: Math.floor(Date.now() / 1000) + 2 };
        let pid, receiptRequested = false;
        const sqls = [];
        const waitingDb = { ...db, transaction: work => db.transaction(async (tx) => { pid = (await tx.query('SELECT pg_backend_pid() pid')).rows[0].pid; return work({ query(sql, args) { sqls.push(sql); if (sql.startsWith('INSERT INTO stem_commands'))
                    receiptRequested = true; return tx.query(sql, args); } }); }) };
        const blocked = { ...action(lockRound), continuation: 'Must not publish' };
        pending = completeStem(waitingDb, limited, blocked);
        pending.catch(() => { });
        let observed = false;
        for (let i = 0; i < 150; i++) {
            if (pid && receiptRequested)
                observed = (await f.domainPool.query('SELECT $2=ANY(pg_blocking_pids(pid)) blocked FROM pg_stat_activity WHERE pid=$1', [pid, blocker])).rows[0]?.blocked;
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
        assert.deepEqual(privateQueries(sqls), []);
        assert.deepEqual(await read(lockRound.id), lockRound);
        assert.equal((await f.domainPool.query('SELECT command_id FROM stem_commands WHERE command_id=$1', [blocked.commandId])).rowCount, 0);
        // Actual accepted maximum-size texts and post-completion projection.
        const maxInput = { ...create(), beginning: '😀'.repeat(500), ownContinuation: '😀'.repeat(2000) };
        const maxRound = (await createStem(db, p[0], maxInput)).value.round;
        const maxComplete = (await completeStem(db, p[1], { ...action(maxRound), continuation: '😀'.repeat(2000) })).value.round;
        assert.equal([...maxComplete.beginning].length, 500);
        assert.equal([...maxComplete.authorContinuation].length, 2000);
        assert.equal([...maxComplete.recipientContinuation].length, 2000);
        assert.ok(Buffer.byteLength(JSON.stringify({ ok: true, value: { rounds: Array.from({ length: 100 }, () => maxComplete), used: 100, capacity: 100, checkedAt: new Date().toISOString() } })) < 2 * 1024 * 1024);
        let used = (await listStems(db, p[0], scope)).value.used;
        for (; used < 100; used++)
            assert.equal((await createStem(db, p[0], create())).ok, true);
        assert.equal((await createStem(db, p[1], create())).error, 'capacity_reached');
        assert.equal((await skipStem(db, p[1], action(lockRound))).ok, true);
        const all = (await listStems(db, p[1], scope)).value;
        assert.equal(all.used, 100);
        assert.equal(all.rounds.length, 100);
        let ended = false;
        for (const r of all.rounds) {
            if (r.phase !== 'waiting')
                ended = true;
            else
                assert.equal(ended, false);
        }
        assert.equal((await leavePair(db, p[1], { ...scope, commandId: randomUUID(), confirm: true })).ok, true);
        assert.equal((await listStems(db, p[0], scope)).error, 'unavailable');
        assert.equal((await createStem(db, p[0], original)).error, 'unavailable');
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
