import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createFixture } from './fixture.mjs';
import { account } from './profile-fixture.mjs';
import { createSharedSong, editSharedSong } from '../../src/shared-songs.ts';

test('song editing PostgreSQL: populated migration rollback, immutable legacy receipts, canonical replay and atomic edit rollback', async () => {
  const f = await createFixture({ skipSongEditingMigration: true }); let connection;
  try {
    const pair = randomUUID(), identities = [await account(f, 0), await account(f, 1)];
    const users = await f.provision(identities.map(identity => identity.user.id), pair);
    const commands = [randomUUID(), randomUUID()];
    const urls = [null, 'https://youtu.be/SyntheticLegacy'];
    for (const [n, command] of commands.entries()) await f.domainPool.query(`INSERT INTO shared_songs
      (couple_id,creator_id,membership_epoch,command_id,title,explanation,music_url,created_at)
      VALUES($1,$2,1,$3,'Synthetic legacy','Synthetic reason',$4,'2026-11-10T00:00:00.000Z')`, [pair, users[0], command, urls[n]]);
    const legacy = (await f.domainPool.query('SELECT * FROM shared_songs ORDER BY command_id')).rows;
    const migration = await readFile(new URL('../../migrations/018_edit_shared_songs.sql', import.meta.url), 'utf8');
    connection = await f.domainPool.connect(); await connection.query('BEGIN'); await connection.query(migration);
    assert.equal((await connection.query('SELECT count(*)::int n FROM shared_song_commands')).rows[0].n, 2);
    await connection.query('ROLLBACK'); connection.release(); connection = null;
    assert.deepEqual((await f.domainPool.query('SELECT * FROM shared_songs ORDER BY command_id')).rows, legacy);
    assert.equal((await f.domainPool.query("SELECT to_regclass('shared_song_commands') AS table")).rows[0].table, null);
    await assert.rejects(f.domainPool.query('UPDATE shared_songs SET title=title'), { code: '23514' });
    await f.domainPool.query(migration);
    const receipts = (await f.domainPool.query('SELECT * FROM shared_song_commands ORDER BY command_id')).rows;
    assert.equal(receipts.length, 2);
    assert.ok(receipts.every(r => r.operation === 'create' && r.expected_version === null));
    const session = (await f.domainPool.query('SELECT id,"expiresAt" FROM "session" WHERE "userId"=$1', [identities[0].user.id])).rows[0];
    const principal = { source: 'better-auth', userId: users[0], authUserId: identities[0].user.id,
      sessionId: session.id, tokenExpiresAt: Math.floor(session.expiresAt.getTime() / 1000) };
    const db = f.database();
    for (const [n, commandId] of commands.entries()) {
      const command = { coupleId: pair, membershipEpoch: 1, commandId, title: 'Synthetic legacy', explanation: 'Synthetic reason',
        ...(urls[n] === null ? {} : { musicUrl: urls[n] }) };
      const replay = await createSharedSong(db, principal, command);
      assert.equal(replay.ok, true); assert.equal(replay.value.replay, true); assert.equal(replay.value.song.version, 1);
      assert.equal(replay.value.song.createdAt, '2026-11-10T00:00:00.000Z');
      assert.equal(replay.value.song.musicUrl, urls[n] ?? undefined);
      const edit = { ...command, commandId: randomUUID(), songId: replay.value.song.id, expectedVersion: 1,
        title: 'Synthetic corrected legacy', explanation: 'Synthetic corrected reason' };
      delete edit.musicUrl;
      const interrupted = { ...db, transaction: work => db.transaction(tx => work({ query: async (sql, params) => {
        if (sql.includes('INSERT INTO shared_song_commands')) throw new Error('synthetic_receipt_failure');
        return tx.query(sql, params);
      } })) };
      await assert.rejects(editSharedSong(interrupted, principal, edit), /synthetic_receipt_failure/);
      assert.deepEqual((await createSharedSong(db, principal, command)).value.song, replay.value.song);
      const edited = await editSharedSong(db, principal, edit); assert.equal(edited.ok, true);
      assert.equal(edited.value.song.version, 2); assert.equal('musicUrl' in edited.value.song, false);
      assert.deepEqual((await createSharedSong(db, principal, command)).value.song, edited.value.song);
      assert.deepEqual((await editSharedSong(db, principal, edit)).value.song, edited.value.song);
      assert.deepEqual(await createSharedSong(db, principal, { ...command, title: edit.title }), { ok: false, error: 'idempotency_conflict' });
      assert.deepEqual(await editSharedSong(db, principal, { ...edit, explanation: 'Changed' }), { ok: false, error: 'idempotency_conflict' });
      assert.deepEqual(await editSharedSong(db, principal, { ...edit, expectedVersion: 2 }), { ok: false, error: 'idempotency_conflict' });
    }
    assert.deepEqual((await f.domainPool.query("SELECT * FROM shared_song_commands WHERE operation='create' ORDER BY command_id")).rows, receipts);
    for (const sql of ['UPDATE shared_song_commands SET title=title', 'DELETE FROM shared_song_commands', 'DELETE FROM shared_songs',
      'UPDATE shared_songs SET creator_id=creator_id,command_id=gen_random_uuid(),version=version+1']) {
      await assert.rejects(f.domainPool.query(sql), { code: '23514' });
    }
    const row = (await f.domainPool.query('SELECT * FROM shared_songs LIMIT 1')).rows[0];
    await assert.rejects(f.domainPool.query(`INSERT INTO shared_song_commands(actor_user_id,command_id,couple_id,membership_epoch,song_id,title,explanation,music_url,operation,expected_version)
      VALUES($1,$2,$3,1,$4,$5,$6,NULL,'edit',1)`, [users[1], randomUUID(), pair, row.id, row.title, row.explanation]), { code: '23503' });
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM shared_song_commands')).rows[0].n, 4);
  } finally {
    if (connection) { await connection.query('ROLLBACK'); connection.release(); }
    await f.close();
  }
});
