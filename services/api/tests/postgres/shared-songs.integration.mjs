import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { songsFixture, songsHarness } from './shared-songs-fixture.mjs';
const value = async response => (await response.json()).value;

test('shared songs PostgreSQL: explicit immutable title and explanation is shared only within verified pair and epoch', async () => {
  const x = await songsFixture();
  try {
    for (const index of [0, 1]) {
      const response = await x.create(index, ' Synthetic e\u0301 ', randomUUID(), x.pairA, 1, { explanation: 'e\u0301\r\nSynthetic 😀' });
      assert.equal(response.status, 201);
      const song = (await value(response)).song;
      assert.equal(song.title, 'Synthetic é'); assert.equal(song.explanation, 'é\nSynthetic 😀');
      assert.equal(song.creatorId, x.usersA[index]);
      assert.deepEqual(Object.keys(song).sort(), ['coupleId', 'createdAt', 'creatorId', 'explanation', 'id', 'membershipEpoch', 'title']);
    }
    const a = await value(await x.list(0)); assert.equal(a.songs.length, 2); assert.equal(a.limit, 50);
    assert.deepEqual(await value(await x.list(1)), a);
    assert.equal((await x.list(null)).status, 401);
    for (const index of [2, 3]) { assert.equal((await x.list(index)).status, 403); assert.equal((await x.create(index)).status, 403); }
    assert.deepEqual((await value(await x.list(2, x.pairB))).songs, []);
    assert.equal((await x.list(0, x.pairA, 2)).status, 409);
    assert.equal((await x.f.domainPool.query('SELECT count(*)::int n FROM outbox_events')).rows[0].n, 0);
    for (const sql of ['UPDATE shared_songs SET explanation=explanation', 'DELETE FROM shared_songs']) await assert.rejects(x.f.domainPool.query(sql), { code: '23514' });
    for (const extra of [{ explanation: ' ' }, { explanation: '\ud800' }, { explanation: '😀'.repeat(2001) }, { title: ' ' }, { music_url: 'https://example.invalid' }, { timezone: 'UTC' }]) {
      assert.equal((await x.create(0, 'Synthetic invalid', randomUUID(), x.pairA, 1, extra)).status, 400);
    }

  } finally { await x.f.close(); }
});

test('shared songs PostgreSQL: durable lost ACK, concurrent identical retries and strict payload conflict', async () => {
  const x = await songsFixture(); let server;
  try {
    server = await songsHarness(x.f); const cookie = await x.connections[0].getCookie();
    const body = { command_id: randomUUID(), membership_epoch: 1, title: 'Synthetic lost ACK', explanation: 'Shared reason', };
    await assert.rejects(server.request(cookie, x.path(), body), /fetch failed/);
    const response = await server.request(cookie, x.path(), body); assert.equal(response.status, 200);
    const replay = await value(response); assert.equal(replay.replay, true);
    for (const extra of [{ title: 'Changed' }, { explanation: 'Changed' }]) assert.equal((await x.post(0, x.path(), { ...body, ...extra })).status, 409);
    const id = randomUUID(); const results = await Promise.all(Array.from({ length: 6 }, () => x.create(0, 'Synthetic concurrent', id)));
    assert.equal(results.filter(r => r.status === 201).length, 1); assert.equal(results.filter(r => r.status === 200).length, 5);
    assert.equal(new Set((await Promise.all(results.map(value))).map(r => r.song.id)).size, 1);
    assert.equal((await x.f.domainPool.query('SELECT count(*)::int n FROM shared_songs')).rows[0].n, 2);
    assert.equal((await x.leave(1)).status, 200);
    assert.equal((await x.post(0, x.path(), body)).status, 403);
    assert.equal((await x.list(1)).status, 403);
  } finally { await server?.close(); await x.f.close(); }
});

test('shared songs PostgreSQL: fifty latest entries, stable author-independent order and strict database text constraints', async () => {
  const x = await songsFixture();
  try {
    const timestamp = '2026-11-10T12:00:00.123Z';
    const ids = Array.from({ length: 51 }, () => randomUUID()).sort().reverse();
    for (const [index, id] of ids.entries()) await x.f.domainPool.query(
      'INSERT INTO shared_songs(id,couple_id,creator_id,membership_epoch,command_id,title,explanation,created_at) VALUES($1,$2,$3,1,$4,$5,$6,$7)',
      [id, x.pairA, x.usersA[index % 2], randomUUID(), 'Synthetic song ' + index, 'An explicit synthetic reason', timestamp]);
    for (const actor of [0, 1]) {
      const result = await value(await x.list(actor));
      assert.equal(result.limit, 50); assert.deepEqual(result.songs.map(song => song.id), ids.slice(0, 50));
    }
    const invalid = [
      ['', 'reason', timestamp], ['Title', ' ', timestamp], ['e\u0301', 'reason', timestamp],
      ['Title', 'e\u0301', timestamp], ['Title', 'x\r', timestamp], ['Title', '😀'.repeat(2001), timestamp],
      ['x'.repeat(201), 'reason', timestamp], ['Title', 'reason', 'infinity'],
      ['Title', 'reason', '2026-11-10T12:00:00.123456Z'],
    ];
    for (const [title, explanation, created] of invalid) await assert.rejects(x.f.domainPool.query(
      'INSERT INTO shared_songs(couple_id,creator_id,membership_epoch,command_id,title,explanation,created_at) VALUES($1,$2,1,$3,$4,$5,$6)',
      [x.pairA, x.usersA[0], randomUUID(), title, explanation, created]), { code: '23514' });
    assert.deepEqual((await value(await x.list(2, x.pairB))).songs, []);
    assert.equal((await x.f.domainPool.query('SELECT count(*)::int n FROM shared_memories')).rows[0].n, 0);
  } finally { await x.f.close(); }
});
