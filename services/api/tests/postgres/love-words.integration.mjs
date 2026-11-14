import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { replyFixture } from './chat-replies-fixture.mjs';
import { createLoveWord, editLoveWord, deleteLoveWord, listLoveWords } from '../../src/love-words.ts';
import { leavePair } from '../../src/pair-leave.ts';

// One disposable auth fixture and no minute-boundary waits. All operations remain
// under the existing per-test deadline, SQL limits and single-worker full profile.
test('love dictionary real CAS, canonical tombstones, cap, rollback and held-lock auth', async () => {
  const { f, a, b, db, principals: p, usersA } = await replyFixture();
  let holder, pending;
  const scope = { coupleId: a, membershipEpoch: 1 };
  const create = (word = 'Synthetic word') => ({ ...scope, commandId: randomUUID(), word });
  try {
    const initial = create();
    const duplicates = await Promise.all(Array.from({ length: 4 }, () => createLoveWord(db, p[0], initial)));
    assert.ok(duplicates.every(result => result.ok));
    assert.equal(duplicates.filter(result => !result.value.replay).length, 1);
    const first = duplicates[0].value.word;
    assert.equal(new Set(duplicates.map(result => result.value.word.id)).size, 1);
    assert.equal((await listLoveWords(db, p[2], scope)).error, 'unavailable');
    assert.equal((await listLoveWords(db, p[0], { ...scope, coupleId: b })).error, 'unavailable');
    assert.equal((await createLoveWord(db, p[0], { ...initial, word: 'Different' })).error, 'idempotency_conflict');
    const edit = { ...create('Edited'), wordId: first.id, expectedVersion: 1 };
    assert.equal((await editLoveWord(db, p[1], edit)).error, 'unavailable');
    const edits = await Promise.all([editLoveWord(db, p[0], edit),
      editLoveWord(db, p[0], { ...edit, commandId: randomUUID(), word: 'Other edit' })]);
    assert.equal(edits.filter(result => result.ok).length, 1);
    assert.equal(edits.find(result => !result.ok).error, 'version_conflict');
    const canonical = edits.find(result => result.ok).value.word;
    assert.equal(canonical.version, 2);
    assert.equal(canonical.edited, true);
    assert.deepEqual((await createLoveWord(db, p[0], initial)).value.word, canonical);
    const noOp = await editLoveWord(db, p[0], { ...edit, commandId: randomUUID(), expectedVersion: 2, word: canonical.word });
    assert.deepEqual(noOp.value.word, canonical);
    // A receipt FK can wait after the text UPDATE. Expiry there must throw out
    // of the transaction, not return an error that commits the edited text.
    holder = await f.domainPool.connect(); await holder.query('BEGIN');
    const memberBlocker = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    await holder.query('SELECT user_id FROM couple_members WHERE couple_id=$1 AND user_id=$2 FOR UPDATE', [a, usersA[0]]);
    const receiptPrincipal = { ...p[0], tokenExpiresAt: Math.floor(Date.now() / 1000) + 2 };
    let receiptPid, receiptRequested = false;
    const receiptDb = { ...db, transaction: work => db.transaction(async tx => {
      receiptPid = (await tx.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      return work({ query(sql, args) {
        if (sql.startsWith('INSERT INTO love_word_commands')) receiptRequested = true;
        return tx.query(sql, args);
      } });
    }) };
    const receiptCommand = { ...edit, commandId: randomUUID(), expectedVersion: 2, word: 'Rollback after receipt wait' };
    pending = editLoveWord(receiptDb, receiptPrincipal, receiptCommand); pending.catch(() => {});
    let receiptWait = false;
    for (let n = 0; n < 150; n++) {
      if (receiptPid && receiptRequested) receiptWait = (await f.domainPool.query('SELECT $2=ANY(pg_blocking_pids(pid)) blocked FROM pg_stat_activity WHERE pid=$1', [receiptPid, memberBlocker])).rows[0]?.blocked;
      if (receiptWait) break; await delay(10);
    }
    assert.equal(receiptWait, true, 'actual receipt FK lock wait after text UPDATE');
    while (Date.now() < receiptPrincipal.tokenExpiresAt * 1000) await delay(10);
    await holder.query('COMMIT'); holder.release(); holder = null;
    assert.deepEqual(await pending, { ok: false, error: 'unavailable' }); pending = null;
    assert.deepEqual((await createLoveWord(db, p[0], initial)).value.word, canonical);
    assert.equal((await f.domainPool.query('SELECT command_id FROM love_word_commands WHERE command_id=$1', [receiptCommand.commandId])).rowCount, 0);
    const removal = { ...scope, commandId: randomUUID(), wordId: first.id, expectedVersion: 2 };
    const race = await Promise.all([deleteLoveWord(db, p[0], removal),
      editLoveWord(db, p[0], { ...edit, commandId: randomUUID(), expectedVersion: 2, word: 'Race' })]);
    assert.equal(race.filter(result => result.ok).length, 1);
    assert.equal(race.find(result => !result.ok).error, 'version_conflict');
    let tombstone = race.find(result => result.ok).value.word;
    if (tombstone.state === 'active') {
      tombstone = (await deleteLoveWord(db, p[0], { ...removal, commandId: randomUUID(), expectedVersion: tombstone.version })).value.word;
    }
    assert.equal(tombstone.state, 'deleted');
    for (const key of ['word', 'meaning', 'saidWhen', 'edited']) assert.equal(key in tombstone, false);
    assert.deepEqual((await createLoveWord(db, p[0], initial)).value.word, tombstone);
    const erased = (await f.domainPool.query('SELECT word,meaning,said_when,edited FROM love_words WHERE id=$1', [first.id])).rows[0];
    assert.deepEqual(erased, { word: null, meaning: null, said_when: null, edited: null });
    await assert.rejects(f.domainPool.query("UPDATE love_words SET state='active',word='Revive',meaning='',said_when='',edited=true,version=version+1 WHERE id=$1", [first.id]));
    await assert.rejects(f.domainPool.query('DELETE FROM love_words WHERE id=$1', [first.id]));
    const receiptColumns = (await f.domainPool.query("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='love_word_commands'", [f.schema])).rows.map(row => row.column_name);
    for (const field of ['word', 'meaning', 'said_when', 'body']) assert.equal(receiptColumns.includes(field), false);
    const broken = { ...db, transaction: work => db.transaction(tx => work({ query(sql, args) {
      if (sql.startsWith('INSERT INTO love_word_commands')) throw Error('synthetic receipt failure');
      return tx.query(sql, args);
    } })) };
    await assert.rejects(createLoveWord(broken, p[0], create('Must roll back')));
    assert.equal((await listLoveWords(db, p[0], scope)).value.used, 1);

    // Fill the same bounded epoch; deleted rows consume capacity. Author identities
    // alternate. At100 a new create fails while an existing edit/delete still works.
    let last;
    for (let n = 1; n < 100; n++) {
      const result = await createLoveWord(db, p[n % 2], create(`Synthetic ${n}`));
      assert.equal(result.ok, true); last = result.value.word;
    }
    const full = (await listLoveWords(db, p[1], scope)).value;
    assert.equal(full.used, 100); assert.equal(full.words.length, 100); assert.equal(full.capacity, 100);
    assert.equal((await createLoveWord(db, p[0], create())).error, 'capacity_reached');
    assert.equal((await editLoveWord(db, p[1], { ...create('At cap'), wordId: last.id, expectedVersion: 1 })).ok, true);
    assert.equal((await deleteLoveWord(db, p[1], { ...scope, commandId: randomUUID(), wordId: last.id, expectedVersion: 2 })).ok, true);
    assert.equal((await listLoveWords(db, p[0], scope)).value.used, 100);

    // Hold an existing entry after pair/auth acquisition, observe the actual SQL
    // waiter, and let the token expire. No test clock overrides SQL authority.
    const own = full.words.find(word => word.state === 'active' && word.authorId === usersA[0]);
    const limited = { ...p[0], tokenExpiresAt: Math.floor(Date.now() / 1000) + 2 };
    holder = await f.domainPool.connect(); await holder.query('BEGIN');
    const blocker = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    await holder.query('SELECT id FROM love_words WHERE id=$1 FOR UPDATE', [own.id]);
    let pid;
    const waitingDb = { ...db, transaction: work => db.transaction(async tx => {
      pid = (await tx.query('SELECT pg_backend_pid() pid')).rows[0].pid; return work(tx);
    }) };
    const heldCommand = { ...create('Must not save after expiry'), wordId: own.id, expectedVersion: own.version };
    pending = editLoveWord(waitingDb, limited, heldCommand); pending.catch(() => {});
    let observed = false;
    for (let n = 0; n < 150; n++) {
      if (pid) observed = (await f.domainPool.query('SELECT $2=ANY(pg_blocking_pids(pid)) blocked FROM pg_stat_activity WHERE pid=$1', [pid, blocker])).rows[0]?.blocked;
      if (observed) break; await delay(10);
    }
    assert.equal(observed, true, 'actual entry row lock blocks authored mutation');
    while (Date.now() < limited.tokenExpiresAt * 1000) await delay(10);
    await holder.query('COMMIT'); holder.release(); holder = null;
    assert.deepEqual(await pending, { ok: false, error: 'unavailable' }); pending = null;
    assert.equal((await f.domainPool.query('SELECT command_id FROM love_word_commands WHERE command_id=$1', [heldCommand.commandId])).rowCount, 0);
    assert.deepEqual((await listLoveWords(db, p[0], scope)).value.words.find(word => word.id === own.id), own);
    assert.equal((await leavePair(db, p[1], { ...scope, commandId: randomUUID(), confirm: true })).ok, true);
    assert.equal((await listLoveWords(db, p[0], scope)).error, 'unavailable');
    assert.equal((await createLoveWord(db, p[0], initial)).error, 'unavailable');
  } finally {
    if (holder) { await holder.query('ROLLBACK'); holder.release(); }
    if (pending) await pending.catch(() => {});
    await f.close();
  }
});
