import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { replyFixture } from './chat-replies-fixture.mjs';
import { createPrediction, listPredictions, readPrediction, openPrediction, declinePrediction, removePrediction } from '../../src/predictions.ts';
import { leavePair } from '../../src/pair-leave.ts';
const created = '2026-11-15T15:00:00.000Z', released = '2026-11-16T06:00:00.000Z';
const early = () => new Date(created), due = () => new Date(released);
const schedule = { localDate: '2026-11-16', localTime: '09:00', timezone: 'Europe/Moscow', offset: '+03:00' };
const migrate = async f => f.domainPool.query(await readFile(new URL('../../migrations/043_predictions.sql', import.meta.url), 'utf8'));
const command = (scope, prediction) => ({ ...scope, predictionId: prediction.id, expectedVersion: prediction.version, commandId: randomUUID(), confirm: true });
const proposal = (scope, text = 'Synthetic private prediction') => ({ ...scope, commandId: randomUUID(), confirm: true, text, schedule });
async function observedWait(f, pid, locker) {
  for (let n = 0; n < 150; n++) {
    const waiter = pid();
    if (waiter && (await f.domainPool.query('SELECT $2=ANY(pg_blocking_pids(pid)) blocked FROM pg_stat_activity WHERE pid=$1', [waiter, locker])).rows[0]?.blocked) return;
    await delay(10);
  }
  assert.fail('Expected real PostgreSQL lock wait was not observed');
}
function observed(db, state) {
  return { ...db, transaction: work => db.transaction(async tx => {
    state.waiter = (await tx.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    return work({ query(sql, args) {
      if (/SELECT body FROM predictions/i.test(sql)) state.bodies++;
      if (/INSERT INTO prediction_commands/i.test(sql)) state.receipt = true;
      return tx.query(sql, args);
    } });
  }) };
}
async function unlock(holder) { await holder.query('COMMIT'); holder.release(); }
async function cleanup(holder, pending, f) {
  if (holder) { await holder.query('ROLLBACK'); holder.release(); }
  if (pending) await pending.catch(() => {});
  await f.close();
}

test('real predictions: body-free ACK/list, due consent, duplicate and CAS races, terminal choices and current replay', async () => {
  const { f, a, b, db, principals: p } = await replyFixture();
  try {
    await migrate(f); const scope = { coupleId: a, membershipEpoch: 1 };
    const input = proposal(scope, '🦉'.repeat(2000));
    const duplicates = await Promise.all(Array.from({ length: 4 }, () => createPrediction(db, p[0], input, early)));
    assert.equal(duplicates.every(r => r.ok), true); assert.equal(duplicates.filter(r => !r.value.replay).length, 1);
    let q = duplicates[0].value.prediction;
    for (const result of duplicates) { assert.equal('text' in result.value, false); assert.equal('text' in result.value.prediction, false); }
    const detail = { ...scope, predictionId: q.id }, state = { bodies: 0 };
    const tracked = observed(db, state);
    assert.equal(JSON.stringify((await listPredictions(tracked, p[1], scope, due)).value).includes(input.text), false);
    assert.equal('text' in (await readPrediction(tracked, p[1], detail, early)).value, false);
    assert.equal('text' in (await readPrediction(tracked, p[1], detail, due)).value, false); assert.equal(state.bodies, 0);
    assert.equal((await readPrediction(tracked, p[0], detail, early)).value.text, input.text); assert.equal(state.bodies, 1);
    assert.equal((await readPrediction(db, p[2], detail, due)).error, 'unavailable');
    assert.equal((await listPredictions(db, p[0], { ...scope, coupleId: b }, due)).error, 'unavailable');
    assert.equal((await listPredictions(db, p[0], { ...scope, membershipEpoch: 2 }, due)).error, 'stale_membership');
    assert.equal((await openPrediction(db, p[0], command(scope, q), due)).error, 'unavailable');
    assert.equal((await openPrediction(db, p[1], command(scope, q), early)).error, 'not_due');
    const opening = command(scope, q);
    const opened = await Promise.all(Array.from({ length: 4 }, () => openPrediction(db, p[1], opening, due)));
    assert.equal(opened.every(r => r.ok), true); assert.equal(opened.filter(r => !r.value.replay).length, 1);
    for (const result of opened) assert.equal('text' in result.value, false);
    q = opened[0].value.prediction;
    assert.equal((await readPrediction(db, p[1], detail, due)).value.text, input.text);
    assert.equal('text' in (await readPrediction(db, p[1], detail, early)).value, false);
    const replay = await openPrediction(db, p[1], opening, early);
    assert.equal(replay.ok && replay.value.replay, true); assert.equal('text' in replay.value, false);
    assert.equal((await openPrediction(db, p[1], command(scope, q), due)).error, 'version_conflict');
    const removed = await removePrediction(db, p[0], command(scope, q), due); assert.equal(removed.ok, true);
    for (const result of [await createPrediction(db, p[0], input, early), await openPrediction(db, p[1], opening, early)]) {
      assert.equal(result.ok && result.value.replay, true); assert.deepEqual(result.value.prediction, removed.value.prediction); assert.equal('text' in result.value, false);
    }
    assert.equal('text' in (await readPrediction(db, p[0], detail, due)).value, false);
    assert.equal((await f.domainPool.query('SELECT body FROM predictions WHERE id=$1', [q.id])).rows[0].body, null);
    await assert.rejects(f.domainPool.query('DELETE FROM predictions WHERE id=$1', [q.id]), { code: '23514' });
    await assert.rejects(f.domainPool.query('UPDATE prediction_commands SET fingerprint=fingerprint'), { code: '23514' });
    for (const competing of ['decline', 'remove']) {
      const fresh = (await createPrediction(db, p[0], proposal(scope), early)).value.prediction;
      const outcomes = await Promise.all([openPrediction(db, p[1], command(scope, fresh), due), competing === 'decline'
        ? declinePrediction(db, p[1], command(scope, fresh), due) : removePrediction(db, p[0], command(scope, fresh), due)]);
      assert.equal(outcomes.filter(r => r.ok).length, 1); assert.equal(outcomes.find(r => !r.ok).error, 'version_conflict');
    }
    const fresh = (await createPrediction(db, p[0], proposal(scope), early)).value.prediction;
    const refused = await declinePrediction(db, p[1], command(scope, fresh), early); assert.equal(refused.ok, true);
    state.bodies = 0;
    assert.equal('text' in (await readPrediction(tracked, p[1], { ...scope, predictionId: fresh.id }, due)).value, false); assert.equal(state.bodies, 0);
    assert.equal((await openPrediction(db, p[1], command(scope, refused.value.prediction), due)).error, 'version_conflict');
    assert.equal((await readPrediction(db, p[0], { ...scope, predictionId: fresh.id }, early)).value.text, 'Synthetic private prediction');
    assert.equal((await leavePair(db, p[1], { ...scope, commandId: randomUUID(), confirm: true })).ok, true);
    assert.equal((await listPredictions(db, p[0], scope, due)).error, 'unavailable');
    assert.equal((await openPrediction(db, p[1], opening, due)).error, 'unavailable');
  } finally { await f.close(); }
});

test('real predictions: lifetime history capacity serializes the last slot and preserves tombstones', async () => {
  const { f, a, db, principals: p } = await replyFixture();
  try {
    await migrate(f); const scope = { coupleId: a, membershipEpoch: 1 };
    for (let n = 0; n < 99; n++) assert.equal((await createPrediction(db, p[0], proposal(scope), early)).ok, true);
    const race = await Promise.all([createPrediction(db, p[0], proposal(scope, 'Last A'), early), createPrediction(db, p[0], proposal(scope, 'Last B'), early)]);
    assert.equal(race.filter(r => r.ok).length, 1); assert.equal(race.find(r => !r.ok).error, 'capacity_reached');
    const history = (await listPredictions(db, p[1], scope, due)).value;
    assert.equal(history.used, 100); assert.equal(history.predictions.length, 100);
    assert.deepEqual((await f.domainPool.query('SELECT sequence FROM predictions WHERE couple_id=$1 ORDER BY sequence', [a])).rows.map(row => row.sequence), Array.from({ length: 100 }, (_, n) => n + 1));
    assert.equal((await removePrediction(db, p[0], command(scope, history.predictions[0]), due)).ok, true);
    assert.equal((await createPrediction(db, p[0], proposal(scope), early)).error, 'capacity_reached');
  } finally { await f.close(); }
});

for (const boundary of ['pair', 'row']) test(`real prediction opening rechecks feature clock after observed ${boundary} wait`, async () => {
  const { f, a, db, principals: p } = await replyFixture(); let holder, pending;
  try {
    await migrate(f); const scope = { coupleId: a, membershipEpoch: 1 };
    const q = (await createPrediction(db, p[0], proposal(scope), early)).value.prediction;
    holder = await f.domainPool.connect(); await holder.query('BEGIN');
    const locker = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    await holder.query(boundary === 'pair' ? 'SELECT id FROM couples WHERE id=$1 FOR UPDATE' : 'SELECT id FROM predictions WHERE id=$1 FOR UPDATE', [boundary === 'pair' ? a : q.id]);
    const state = { bodies: 0 }; let featureTime = released;
    const input = command(scope, q);
    pending = openPrediction(observed(db, state), p[1], input, () => new Date(featureTime)); pending.catch(() => {});
    await observedWait(f, () => state.waiter, locker); featureTime = created;
    await unlock(holder); holder = null;
    assert.deepEqual(await pending, { ok: false, error: 'not_due' }); pending = null; assert.equal(state.bodies, 0);
    assert.equal((await f.domainPool.query('SELECT version,opened_at FROM predictions WHERE id=$1', [q.id])).rows[0].version, 1);
    assert.equal((await f.domainPool.query('SELECT command_id FROM prediction_commands WHERE command_id=$1', [input.commandId])).rowCount, 0);
  } finally { await cleanup(holder, pending, f); }
});

for (const boundary of ['expiry', 'clock']) test(`real prediction receipt FK wait: ${boundary} rolls back opening and command`, async () => {
  const { f, a, db, principals: p, usersA } = await replyFixture(); let holder, pending;
  try {
    await migrate(f); const scope = { coupleId: a, membershipEpoch: 1 };
    const q = (await createPrediction(db, p[0], proposal(scope), early)).value.prediction;
    holder = await f.domainPool.connect(); await holder.query('BEGIN');
    const locker = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    await holder.query('SELECT user_id FROM couple_members WHERE couple_id=$1 AND user_id=$2 FOR UPDATE', [a, usersA[1]]);
    const state = { bodies: 0 }; let featureTime = released;
    const principal = boundary === 'expiry' ? { ...p[1], tokenExpiresAt: Math.floor(Date.now() / 1000) + 2 } : p[1];
    const input = command(scope, q);
    pending = openPrediction(observed(db, state), principal, input, () => new Date(featureTime)); pending.catch(() => {});
    await observedWait(f, () => state.receipt ? state.waiter : null, locker);
    if (boundary === 'expiry') while (Date.now() < principal.tokenExpiresAt * 1000) await delay(10);
    else featureTime = created;
    await unlock(holder); holder = null;
    assert.deepEqual(await pending, { ok: false, error: 'unavailable' }); pending = null;
    assert.equal(state.bodies, 0);
    assert.deepEqual((await listPredictions(db, p[0], scope, due)).value.predictions, [q]);
    assert.equal((await f.domainPool.query('SELECT command_id FROM prediction_commands WHERE command_id=$1', [input.commandId])).rowCount, 0);
  } finally { await cleanup(holder, pending, f); }
});

test('real prediction private read checks provider expiry after row wait before body SELECT', async () => {
  const { f, a, db, principals: p } = await replyFixture(); let holder, pending;
  try {
    await migrate(f); const scope = { coupleId: a, membershipEpoch: 1 };
    const q = (await createPrediction(db, p[0], proposal(scope), early)).value.prediction;
    assert.equal((await openPrediction(db, p[1], command(scope, q), due)).ok, true);
    await f.authPool.query(`UPDATE "session" SET "expiresAt"=clock_timestamp()+interval '2 seconds' WHERE id=$1`, [p[1].sessionId]);
    holder = await f.domainPool.connect(); await holder.query('BEGIN');
    const locker = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    await holder.query('SELECT id FROM predictions WHERE id=$1 FOR UPDATE', [q.id]);
    const state = { bodies: 0 };
    pending = readPrediction(observed(db, state), p[1], { ...scope, predictionId: q.id }, due); pending.catch(() => {});
    await observedWait(f, () => state.waiter, locker); await delay(2100);
    assert.equal((await f.domainPool.query('SELECT "expiresAt"<=clock_timestamp() expired FROM "session" WHERE id=$1', [p[1].sessionId])).rows[0].expired, true);
    await unlock(holder); holder = null;
    assert.deepEqual(await pending, { ok: false, error: 'unavailable' }); pending = null; assert.equal(state.bodies, 0);
  } finally { await cleanup(holder, pending, f); }
});

test('real prediction private read denies provider revocation after session wait before prediction access', async () => {
  const { f, a, db, principals: p } = await replyFixture(); let holder, pending;
  try {
    await migrate(f); const scope = { coupleId: a, membershipEpoch: 1 };
    const q = (await createPrediction(db, p[0], proposal(scope), early)).value.prediction;
    holder = await f.domainPool.connect(); await holder.query('BEGIN');
    const locker = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    await holder.query('SELECT id FROM "session" WHERE id=$1 FOR UPDATE', [p[0].sessionId]);
    let waiter, privateQueries = 0;
    const tracked = { ...db, transaction: work => db.transaction(async tx => {
      waiter = (await tx.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      return work({ query(sql, args) { if (/FROM predictions/i.test(sql)) privateQueries++; return tx.query(sql, args); } });
    }) };
    pending = readPrediction(tracked, p[0], { ...scope, predictionId: q.id }, early); pending.catch(() => {});
    await observedWait(f, () => waiter, locker);
    await holder.query('DELETE FROM "session" WHERE id=$1', [p[0].sessionId]);
    await unlock(holder); holder = null;
    assert.deepEqual(await pending, { ok: false, error: 'unavailable' }); pending = null; assert.equal(privateQueries, 0);
  } finally { await cleanup(holder, pending, f); }
});

test('real prediction creation rechecks selected local day after pair lock wait', async () => {
  const { f, a, db, principals: p } = await replyFixture(); let holder, pending;
  try {
    await migrate(f); const scope = { coupleId: a, membershipEpoch: 1 };
    holder = await f.domainPool.connect(); await holder.query('BEGIN');
    const locker = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    await holder.query('SELECT id FROM couples WHERE id=$1 FOR UPDATE', [a]);
    const state = { bodies: 0 }; let featureTime = created;
    const input = proposal(scope);
    pending = createPrediction(observed(db, state), p[0], input, () => new Date(featureTime)); pending.catch(() => {});
    await observedWait(f, () => state.waiter, locker);
    featureTime = '2026-11-15T21:00:00.000Z'; // Midnight in Moscow: selected day is now today.
    await unlock(holder); holder = null;
    assert.deepEqual(await pending, { ok: false, error: 'invalid_request' }); pending = null;
    assert.equal((await f.domainPool.query('SELECT id FROM predictions WHERE couple_id=$1', [a])).rowCount, 0);
    assert.equal((await f.domainPool.query('SELECT command_id FROM prediction_commands WHERE command_id=$1', [input.commandId])).rowCount, 0);
  } finally { await cleanup(holder, pending, f); }
});
