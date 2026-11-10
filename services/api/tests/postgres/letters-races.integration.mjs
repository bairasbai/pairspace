import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { lettersFixture, pauseAfterMembers } from './letters-fixture.mjs';
import { sendLetter, listLetters, openLetter } from '../../src/letters.ts';
import { closeCouple } from '../../src/chat.ts';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
test('real PostgreSQL letters: member replacement and close serialize against send and prevent stale recipient replay', async () => {
  const { f, pairA, principal, usersA } = await lettersFixture();
  const db = f.database(); const p = await principal(0); const partner = await principal(1);
  const lock = pauseAfterMembers(db); const tasks = []; let replacement;
  try {
    const command = { coupleId: pairA, membershipEpoch: 1, clientId: randomUUID(), body: 'Synthetic' };
    const sending = sendLetter(lock.db, p, command); tasks.push(sending); await lock.entered;
    replacement = await f.domainPool.connect(); await replacement.query('BEGIN');
    let finished = false;
    const replacing = replacement.query("UPDATE couple_members SET status='revoked' WHERE couple_id=$1 AND user_id=$2", [pairA, usersA[1]]).then(() => { finished = true; }); tasks.push(replacing);
    await delay(80); assert.equal(finished, false, 'recipient membership remains locked through insert');
    lock.release(); const sent = await sending; assert.equal(sent.ok, true); await replacing;
    const newUser = randomUUID(); await replacement.query('INSERT INTO users(id) VALUES($1)', [newUser]);
    await replacement.query("INSERT INTO couple_members(couple_id,user_id,slot,status) VALUES($1,$2,2,'active')", [pairA, newUser]);
    await replacement.query('COMMIT'); replacement.release(); replacement = null;
    const scope = { coupleId: pairA, membershipEpoch: 1 };
    assert.deepEqual(await listLetters(db, partner, scope), { ok: false, error: 'unavailable' });
    assert.deepEqual(await openLetter(db, partner, { ...scope, letterId: sent.value.letter.id }), { ok: false, error: 'unavailable' });
    assert.deepEqual(await sendLetter(db, p, command), { ok: false, error: 'idempotency_conflict' });
    assert.equal((await closeCouple(db, p, pairA, 1)).ok, true);
    assert.deepEqual(await sendLetter(db, p, { ...command, clientId: randomUUID() }), { ok: false, error: 'unavailable' });
    assert.deepEqual(await listLetters(db, p, scope), { ok: false, error: 'unavailable' });
    assert.equal((await f.domainPool.query('SELECT count(*)::int AS n FROM letters')).rows[0].n, 1);
  } finally { lock.release(); await Promise.allSettled(tasks); if (replacement) { await replacement.query('ROLLBACK'); replacement.release(); } await f.close(); }
});

test('real PostgreSQL letters: expiration during pair lock wait rejects new send, replay, list and open', async () => {
  const { f, pairA, principal } = await lettersFixture(); const db = f.database();
  const p = await principal(0); const partner = await principal(1);
  const scope = { coupleId: pairA, membershipEpoch: 1 };
  const command = { ...scope, clientId: randomUUID(), body: 'Synthetic' }; let held; const tasks = [];
  try {
    const sent = await sendLetter(db, p, command); assert.equal(sent.ok, true);
    await f.domainPool.query('UPDATE "session" SET "expiresAt"=clock_timestamp()+interval \'1 second\' WHERE id=ANY($1)', [[p.sessionId, partner.sessionId]]);
    held = await f.domainPool.connect(); await held.query('BEGIN'); await held.query('SELECT id FROM couples WHERE id=$1 FOR UPDATE', [pairA]);
    tasks.push(sendLetter(db, p, command), sendLetter(db, p, { ...command, clientId: randomUUID() }),
      listLetters(db, partner, scope), openLetter(db, partner, { ...scope, letterId: sent.value.letter.id }));
    await delay(1200); await held.query('COMMIT'); held.release(); held = null;
    for (const result of await Promise.all(tasks)) assert.deepEqual(result, { ok: false, error: 'unavailable' });
    assert.equal((await f.domainPool.query('SELECT count(*)::int AS n FROM letters')).rows[0].n, 1);
  } finally { if (held) { await held.query('ROLLBACK'); held.release(); } await Promise.allSettled(tasks); await f.close(); }
});

test('real PostgreSQL letters: command cannot be replayed into a new pair; old letter IDs remain unavailable', async () => {
  const { f, pairA, principal, usersA } = await lettersFixture(); const db = f.database(); const p = await principal(0);
  try {
    const command = { coupleId: pairA, membershipEpoch: 1, clientId: randomUUID(), body: 'Synthetic' };
    const sent = await sendLetter(db, p, command); assert.equal(sent.ok, true);
    assert.equal((await closeCouple(db, p, pairA, 1)).ok, true);
    const newPair = randomUUID(); const connection = await f.domainPool.connect();
    try {
      await connection.query('BEGIN'); await connection.query("INSERT INTO couples(id,status) VALUES($1,'waiting_partner')", [newPair]);
      for (let n = 0; n < 2; n++) await connection.query("INSERT INTO couple_members(couple_id,user_id,slot,status) VALUES($1,$2,$3,'active')", [newPair, usersA[n], n + 1]);
      await connection.query("UPDATE couples SET status='active' WHERE id=$1", [newPair]); await connection.query('COMMIT');
    } catch (error) { await connection.query('ROLLBACK'); throw error; } finally { connection.release(); }
    assert.deepEqual(await sendLetter(db, p, { ...command, coupleId: newPair }), { ok: false, error: 'idempotency_conflict' });
    const partner = await principal(1); const scope = { coupleId: newPair, membershipEpoch: 1 };
    assert.deepEqual((await listLetters(db, partner, scope)).value.letters, []);
    assert.deepEqual(await openLetter(db, partner, { ...scope, letterId: sent.value.letter.id }), { ok: false, error: 'unavailable' });
    assert.equal((await f.domainPool.query('SELECT count(*)::int AS n FROM letters')).rows[0].n, 1);
  } finally { await f.close(); }
});

test('real PostgreSQL letters: authorized open locks recipient until body read finishes', async () => {
  const { f, pairA, principal, usersA } = await lettersFixture(); const db = f.database();
  const scope = { coupleId: pairA, membershipEpoch: 1 }; const lock = pauseAfterMembers(db);
  const tasks = []; let revoker;
  try {
    const sent = await sendLetter(db, await principal(0), { ...scope, clientId: randomUUID(), body: 'Synthetic' });
    const recipient = await principal(1);
    const opening = openLetter(lock.db, recipient, { ...scope, letterId: sent.value.letter.id }); tasks.push(opening);
    await lock.entered;
    revoker = await f.domainPool.connect(); await revoker.query('BEGIN'); let finished = false;
    const revoke = revoker.query("UPDATE couple_members SET status='revoked' WHERE couple_id=$1 AND user_id=$2", [pairA, usersA[1]]).then(() => { finished = true; }); tasks.push(revoke);
    await delay(80); assert.equal(finished, false);
    lock.release(); assert.equal((await opening).ok, true); await revoke;
    await revoker.query("UPDATE couples SET status='closed', membership_epoch=membership_epoch+1 WHERE id=$1", [pairA]);
    await revoker.query('COMMIT'); revoker.release(); revoker = null;
    assert.deepEqual(await openLetter(db, recipient, { ...scope, letterId: sent.value.letter.id }), { ok: false, error: 'unavailable' });
  } finally { lock.release(); if (revoker) { await revoker.query('ROLLBACK'); revoker.release(); } await Promise.allSettled(tasks); await f.close(); }
});
