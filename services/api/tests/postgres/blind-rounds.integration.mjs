import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { roundsFixture, value } from './blind-rounds-fixture.mjs';
import { createFixture } from './fixture.mjs';

test('blind rounds PostgreSQL: explicit advance, immutable old replay, answer binding and legacy first round', async () => {
  const x = await roundsFixture();
  try {
    const openId = randomUUID(), first = (await value(await x.open(0, openId))).round;
    const next = x.command(first);
    assert.equal((await x.next(0, next)).status, 409);
    await x.submit(0, first.id);
    assert.equal((await x.next(0, next)).status, 409);
    await x.submit(1, first.id);
    const result = await value(await x.next(0, next));
    assert.equal(result.replay, false); assert.equal(result.commandId, next.command_id);
    const second = result.round; assert.notEqual(second.id, first.id); assert.equal(second.questionId, 'shared-plan');
    assert.equal((await value(await x.read(0))).round.id, first.id);
    assert.equal((await value(await x.open(0))).round.id, first.id);
    assert.equal((await value(await x.open(0, openId))).round.id, first.id);
    assert.equal((await x.submit(0, second.id)).status, 400, 'wrong question cannot submit into later round');
    assert.equal((await x.submit(0, second.id, 'Synthetic', randomUUID(), x.pairA, 1,
      { question_id: 'shared-plan', catalog_version: 2 })).status, 400);
    await x.finish(second);
    const third = (await value(await x.next(1, x.command(second, 'kind-memory')))).round;
    const replay = await value(await x.next(0, next));
    assert.equal(replay.replay, true); assert.equal(replay.round.id, second.id);
    assert.equal((await value(await x.select(0, first))).round.id, first.id);
    assert.equal((await value(await x.history(0))).currentRoundId, third.id);
    assert.equal((await x.next(1, x.command(first))).status, 409);
    assert.equal((await x.next(0, { ...next, question_id: 'kind-memory' })).status, 409);
  } finally { await x.f.close(); }
});

test('blind rounds PostgreSQL: concurrent next commands create exactly one successor', async () => {
  const x = await roundsFixture();
  try {
    const first = (await value(await x.open(0))).round; await x.finish(first);
    const commands = [x.command(first), x.command(first, 'kind-memory')];
    const responses = await Promise.all(commands.map((command, index) => x.next(index, command)));
    assert.deepEqual(responses.map(r => r.status).sort(), [201, 409]);
    const winner = responses.findIndex(r => r.status === 201), result = await value(responses[winner]);
    const replay = await value(await x.next(winner, commands[winner]));
    assert.equal(replay.round.id, result.round.id); assert.equal(replay.replay, true);
    assert.equal((await x.f.domainPool.query('SELECT count(*)::int n FROM blind_rounds')).rows[0].n, 2);
  } finally { await x.f.close(); }
});

test('blind rounds PostgreSQL: history bounded to latest ten metadata rows and isolation on every new route', async () => {
  const x = await roundsFixture();
  try {
    const first = (await value(await x.open(0))).round; let current = first;
    const ids = [first.id];
    for (let n = 0; n < 11; n++) {
      await x.finish(current);
      current = (await value(await x.next(n % 2, x.command(current, ['small-joy', 'shared-plan', 'kind-memory'][n % 3])))).round;
      ids.push(current.id);
    }
    const history = await value(await x.history(0));
    assert.equal(history.limit, 10); assert.equal(history.currentRoundId, current.id);
    assert.deepEqual(history.rounds.map(r => r.id), ids.slice(-10).reverse());
    for (const round of history.rounds) assert.deepEqual(Object.keys(round).sort(), ['catalogVersion', 'id', 'questionId']);
    assert.equal((await value(await x.select(0, first))).round.id, first.id, 'old explicit selection still supported');
    for (const actor of [2, null]) {
      assert.notEqual((await x.history(actor)).status, 200);
      assert.notEqual((await x.select(actor, first)).status, 200);
      assert.notEqual((await x.next(actor, x.command(current))).status, 200);
    }
    assert.notEqual((await x.select(0, first, x.pairB)).status, 200);
    assert.notEqual((await x.history(0, x.pairA, 2)).status, 200);
    await x.leave(0);
    for (const actor of [0, 1]) {
      assert.notEqual((await x.history(actor)).status, 200);
      assert.notEqual((await x.select(actor, first)).status, 200);
      assert.notEqual((await x.next(actor, x.command(current))).status, 200);
    }
  } finally { await x.f.close(); }
});

test('blind rounds PostgreSQL: forward migration preserves first round, answers and receipts', async () => {
  const f = await createFixture({ skipBlindRoundsMigration: true });
  try {
    const pair = randomUUID(), users = [randomUUID(), randomUUID()].sort(), round = randomUUID(), command = randomUUID();
    await f.domainPool.query("INSERT INTO couples(id,status) VALUES($1,'waiting_partner')", [pair]);
    for (let index = 0; index < 2; index++) {
      await f.domainPool.query('INSERT INTO users(id) VALUES($1)', [users[index]]);
      await f.domainPool.query("INSERT INTO couple_members(couple_id,user_id,slot,status) VALUES($1,$2,$3,'active')", [pair, users[index], index + 1]);
    }
    await f.domainPool.query("UPDATE couples SET status='active' WHERE id=$1", [pair]);
    await f.domainPool.query(`INSERT INTO blind_rounds(id,couple_id,membership_epoch,question_id,catalog_version,participant_one,participant_two)
      VALUES($1,$2,1,'small-joy',1,$3,$4)`, [round, pair, ...users]);
    await f.domainPool.query("INSERT INTO blind_answers VALUES($1,$2,'Synthetic preserved answer')", [round, users[0]]);
    await f.domainPool.query("INSERT INTO blind_commands VALUES($1,$2,$3,'answer')", [users[0], command, round]);
    const before = {};
    for (const table of ['blind_rounds', 'blind_answers', 'blind_commands']) before[table] = (await f.domainPool.query(`SELECT * FROM ${table}`)).rows;
    await f.domainPool.query(await readFile(new URL('../../migrations/011_repeatable_blind_rounds.sql', import.meta.url), 'utf8'));
    for (const table of ['blind_rounds', 'blind_answers', 'blind_commands']) {
      const rows = (await f.domainPool.query(`SELECT * FROM ${table}`)).rows;
      if (table === 'blind_rounds') { assert.equal(rows[0].predecessor_round_id, null); delete rows[0].predecessor_round_id; }
      assert.deepEqual(rows, before[table]);
    }
  } finally { await f.close(); }
});

test('blind rounds PostgreSQL: next strict consent/version/header validation and receipt rollback are atomic', async () => {
  const x = await roundsFixture();
  try {
    const first = (await value(await x.open(0))).round; await x.finish(first);
    const command = x.command(first);
    for (const extra of [{ confirm: false }, { catalog_version: 2 }, { question_id: 'unknown' }, { extra: true }]) {
      assert.equal((await x.next(0, { ...command, ...extra })).status, 400);
    }
    const wrongHeader = await x.raw(0, `${x.roundsPath()}/next`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify(command) });
    assert.equal(wrongHeader.status, 400);
    await x.f.domainPool.query(`CREATE FUNCTION reject_next_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.operation='next' THEN RAISE EXCEPTION 'Synthetic receipt failure'; END IF; RETURN NEW; END $$`);
    await x.f.domainPool.query('CREATE TRIGGER reject_next_receipt BEFORE INSERT ON blind_commands FOR EACH ROW EXECUTE FUNCTION reject_next_receipt()');
    assert.equal((await x.next(0, command)).status, 503);
    assert.equal((await x.f.domainPool.query('SELECT count(*)::int n FROM blind_rounds')).rows[0].n, 1);
    await x.f.domainPool.query('DROP TRIGGER reject_next_receipt ON blind_commands');
    const responses = await Promise.all([x.next(0, command), x.next(0, command)]);
    assert.deepEqual(responses.map(r => r.status).sort(), [200, 201]);
    const results = await Promise.all(responses.map(value));
    assert.equal(results[0].round.id, results[1].round.id);
    assert.deepEqual(results.map(r => r.replay).sort(), [false, true]);
    assert.equal((await x.f.domainPool.query('SELECT count(*)::int n FROM blind_rounds')).rows[0].n, 2);
  } finally { await x.f.close(); }
});
