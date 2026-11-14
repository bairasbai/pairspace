import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { replyFixture } from './chat-replies-fixture.mjs';
import { listStories, readStory, orderStory, tellStory, declineStory, removeStoryTopic, removeStoryBody } from '../../src/stories.ts';
import { leavePair } from '../../src/pair-leave.ts';

test('real stories: actor/CAS races, long-form metadata privacy, split removal, canonical replay and capacity', async () => {
  const { f, a, b, db, principals: p } = await replyFixture();
  const scope = { coupleId: a, membershipEpoch: 1 };
  const order = (topic = 'Synthetic narrative topic') => ({ ...scope, commandId: randomUUID(), topic });
  const action = story => ({ ...scope, commandId: randomUUID(), storyId: story.id, expectedVersion: story.version });
  try {
    await f.domainPool.query(await readFile(new URL('../../migrations/040_ordered_stories.sql', import.meta.url), 'utf8'));
    const original = order();
    const duplicates = await Promise.all(Array.from({ length: 4 }, () => orderStory(db, p[0], original)));
    assert.equal(duplicates.every(r => r.ok), true); assert.equal(duplicates.filter(r => !r.value.replay).length, 1);
    const first = duplicates[0].value.story;
    assert.equal(first.topicAuthorId, p[0].userId); assert.equal(first.storyAuthorId, p[1].userId);
    assert.equal((await listStories(db, p[2], scope)).error, 'unavailable');
    assert.equal((await readStory(db, p[2], { ...scope, storyId: first.id })).error, 'unavailable');
    assert.equal((await listStories(db, p[0], { ...scope, coupleId: b })).error, 'unavailable');
    assert.equal((await tellStory(db, p[0], { ...action(first), body: 'Cannot self-tell' })).error, 'unavailable');
    const body = '🦉'.repeat(8000), telling = { ...action(first), body };
    const told = await tellStory(db, p[1], telling); assert.equal(told.ok, true);
    assert.equal('body' in told.value.story, false);
    const listed = (await listStories(db, p[0], scope)).value;
    assert.equal(JSON.stringify(listed).includes(body), false);
    assert.equal((await readStory(db, p[0], { ...scope, storyId: first.id })).value.body === body, true);
    const split = await Promise.all([removeStoryTopic(db, p[0], action(told.value.story)), removeStoryBody(db, p[1], action(told.value.story))]);
    assert.equal(split.filter(r => r.ok).length, 1); assert.equal(split.find(r => !r.ok).error, 'version_conflict');
    let current = split.find(r => r.ok).value.story;
    current = current.topicState === 'removed' ? (await removeStoryBody(db, p[1], action(current))).value.story
      : (await removeStoryTopic(db, p[0], action(current))).value.story;
    assert.equal(current.version, 4); assert.equal(current.storyState, 'story_removed'); assert.equal(current.topicState, 'removed');
    assert.equal(current.toldAt, told.value.story.toldAt); assert.equal('topic' in current, false);
    assert.equal('body' in (await readStory(db, p[0], { ...scope, storyId: first.id })).value, false);
    assert.deepEqual((await tellStory(db, p[1], telling)).value.story, current);
    assert.deepEqual((await orderStory(db, p[0], original)).value.story, current);
    const stored = (await f.domainPool.query('SELECT topic,body FROM ordered_stories WHERE id=$1', [first.id])).rows[0];
    assert.deepEqual(stored, { topic: null, body: null });
    await assert.rejects(f.domainPool.query('DELETE FROM ordered_stories WHERE id=$1', [first.id]));
    for (const competing of ['decline', 'withdraw']) {
      const pending = (await orderStory(db, p[0], order())).value.story;
      const results = await Promise.all([tellStory(db, p[1], { ...action(pending), body: 'A race narrative' }),
        competing === 'decline' ? declineStory(db, p[1], action(pending)) : removeStoryTopic(db, p[0], action(pending))]);
      assert.equal(results.filter(r => r.ok).length, 1); assert.equal(results.find(r => !r.ok).error, 'version_conflict');
    }
    let used = (await listStories(db, p[0], scope)).value.used;
    for (; used < 99; used++) assert.equal((await orderStory(db, p[0], order(`Synthetic topic ${used}`))).ok, true);
    const cap = await Promise.all([orderStory(db, p[0], order('Last capacity A')), orderStory(db, p[0], order('Last capacity B'))]);
    assert.equal(cap.filter(r => r.ok).length, 1); assert.equal(cap.find(r => !r.ok).error, 'capacity_reached');
    const all = (await listStories(db, p[0], scope)).value;
    assert.equal(all.used, 100); assert.equal(all.stories.length, 100); assert.equal(all.capacity, 100);
    assert.deepEqual(all.stories.map(s => s.sequence).sort((x,y) => x-y), Array.from({ length: 100 }, (_, i) => i+1));
    const last = all.stories.find(s => s.storyState === 'waiting');
    const result = await tellStory(db, p[1], { ...action(last), body: 'Allowed at capacity' }); assert.equal(result.ok, true);
    assert.equal((await removeStoryBody(db, p[1], action(result.value.story))).ok, true);
    assert.equal((await leavePair(db, p[1], { ...scope, commandId: randomUUID(), confirm: true })).ok, true);
    assert.equal((await listStories(db, p[0], scope)).error, 'unavailable');
    assert.equal((await readStory(db, p[1], { ...scope, storyId: first.id })).error, 'unavailable');
    assert.equal((await tellStory(db, p[1], telling)).error, 'unavailable');
  } finally { await f.close(); }
});

test('real story receipt FK wait after body update rechecks expiry and rolls back body/version/receipt', async () => {
  const { f, a, db, principals: p, usersA } = await replyFixture();
  let holder, pending;
  const scope = { coupleId: a, membershipEpoch: 1 };
  try {
    await f.domainPool.query(await readFile(new URL('../../migrations/040_ordered_stories.sql', import.meta.url), 'utf8'));
    const story = (await orderStory(db, p[0], { ...scope, commandId: randomUUID(), topic: 'Receipt race topic' })).value.story;
    holder = await f.domainPool.connect(); await holder.query('BEGIN');
    const blocker = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    await holder.query('SELECT user_id FROM couple_members WHERE couple_id=$1 AND user_id=$2 FOR UPDATE', [a, usersA[1]]);
    const limited = { ...p[1], tokenExpiresAt: Math.floor(Date.now()/1000) + 2 };
    let pid, receiptRequested = false;
    const observed = { ...db, transaction: work => db.transaction(async tx => {
      pid = (await tx.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      return work({ query(sql, args) { if (sql.startsWith('INSERT INTO story_commands')) receiptRequested = true; return tx.query(sql, args); } });
    }) };
    const telling = { ...scope, storyId: story.id, expectedVersion: 1, commandId: randomUUID(), body: 'Must roll back' };
    pending = tellStory(observed, limited, telling); pending.catch(() => {});
    let blocked = false;
    for (let n = 0; n < 150; n++) {
      if (pid && receiptRequested) blocked = (await f.domainPool.query('SELECT $2=ANY(pg_blocking_pids(pid)) blocked FROM pg_stat_activity WHERE pid=$1', [pid, blocker])).rows[0]?.blocked;
      if (blocked) break; await delay(10);
    }
    assert.equal(blocked, true, 'real receipt FK lock is observed after body update');
    while (Date.now() < limited.tokenExpiresAt*1000) await delay(10);
    await holder.query('COMMIT'); holder.release(); holder = null;
    assert.deepEqual(await pending, { ok: false, error: 'unavailable' }); pending = null;
    assert.deepEqual((await listStories(db, p[0], scope)).value.stories, [story]);
    assert.equal((await f.domainPool.query('SELECT command_id FROM story_commands WHERE command_id=$1', [telling.commandId])).rowCount, 0);
    assert.equal((await f.domainPool.query('SELECT body FROM ordered_stories WHERE id=$1', [story.id])).rows[0].body, null);
  } finally {
    if (holder) { await holder.query('ROLLBACK'); holder.release(); }
    if (pending) await pending.catch(() => {});
    await f.close();
  }
});
