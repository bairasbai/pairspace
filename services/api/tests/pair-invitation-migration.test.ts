import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createFixture, id, outsider, u2, waiting } from './fixtures.ts';

let pg: PGlite;
const now = '2026-11-10T00:00:00Z', later = '2026-11-10T00:10:00Z';
beforeEach(async () => {
  pg = await createFixture();
  await pg.exec(await readFile(new URL('../migrations/004_pair_invites.sql', import.meta.url), 'utf8'));
  await pg.query("INSERT INTO couple_members VALUES($1,$2,1,'active')", [waiting, outsider]);
});
afterEach(async () => { await pg.close(); });
const insert = (command = id(50), hash = 'a'.repeat(64), issuer = outsider, couple = waiting) => pg.query<{ id: string }>(`
  INSERT INTO pair_invites(couple_id,issuer_user_id,command_id,token_hash,created_at,expires_at)
  VALUES($1,$2,$3,$4,$5,$6) RETURNING id`, [couple, issuer, command, hash, now, later]);

it('reserves one current invite even when expired; keeps historical command and hash unique after revocation', async () => {
  const first = (await insert()).rows[0].id;
  await expect(insert(id(51), 'b'.repeat(64))).rejects.toMatchObject({ code: '23505' });
  // Historical timestamps do not free the current-slot index. Only an explicit revocation does.
  await pg.query('UPDATE pair_invites SET revoked_at=expires_at WHERE id=$1', [first]);
  await expect(insert(id(50), 'b'.repeat(64))).rejects.toMatchObject({ code: '23505' });
  await expect(insert(id(51), 'a'.repeat(64))).rejects.toMatchObject({ code: '23505' });
  await insert(id(51), 'b'.repeat(64));
  expect((await pg.query('SELECT * FROM pair_invites')).rows).toHaveLength(2);
  const columns = await pg.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name='pair_invites'");
  expect(columns.rows.map(r => r.column_name).sort()).toEqual(['id', 'couple_id', 'issuer_user_id', 'command_id', 'token_hash',
    'created_at', 'expires_at', 'revoked_at', 'consumed_at', 'consumed_by_user_id'].sort());
});

it('enforces tenant-bound issuer/consumer references and coherent revoke/consume state', async () => {
  await expect(insert(id(50), 'a'.repeat(64), u2)).rejects.toMatchObject({ code: '23503' });
  const invite = (await insert()).rows[0].id;
  for (const set of ["token_hash='raw-token'", 'expires_at=created_at', "created_at='-infinity'", "expires_at='infinity'",
    "revoked_at='infinity'", "revoked_at=created_at-interval '1 second'", 'consumed_at=created_at',
    `consumed_by_user_id='${outsider}'`, `consumed_at=created_at,consumed_by_user_id='${outsider}'`]) {
    await expect(pg.query(`UPDATE pair_invites SET ${set} WHERE id=$1`, [invite])).rejects.toMatchObject({ code: '23514' });
  }
  await expect(pg.query('UPDATE pair_invites SET consumed_at=created_at,consumed_by_user_id=$2 WHERE id=$1', [invite, u2]))
    .rejects.toMatchObject({ code: '23503' });
  const partner = id(99);
  await pg.query('INSERT INTO users(id) VALUES($1)', [partner]);
  await pg.transaction(async tx => {
    await tx.query("INSERT INTO couple_members VALUES($1,$2,2,'active')", [waiting, partner]);
    await tx.query('UPDATE pair_invites SET consumed_at=created_at,consumed_by_user_id=$2 WHERE id=$1', [invite, partner]);
    await tx.query("UPDATE couples SET status='active' WHERE id=$1", [waiting]);
  });
  for (const set of ['revoked_at=created_at', 'consumed_at=expires_at', "consumed_at=created_at-interval '1 second'", "consumed_at='infinity'"]) {
    await expect(pg.query(`UPDATE pair_invites SET ${set} WHERE id=$1`, [invite])).rejects.toMatchObject({ code: '23514' });
  }
});

it('rolls back revoked current when a replacement insert fails', async () => {
  const invite = (await insert()).rows[0].id;
  await expect(pg.transaction(async tx => {
    await tx.query('UPDATE pair_invites SET revoked_at=expires_at WHERE id=$1', [invite]);
    await tx.query(`INSERT INTO pair_invites(couple_id,issuer_user_id,command_id,token_hash,created_at,expires_at)
      VALUES($1,$2,$3,$4,$5,$6)`, [waiting, outsider, id(51), 'invalid-hash', now, later]);
  })).rejects.toMatchObject({ code: '23514' });
  expect((await pg.query('SELECT revoked_at FROM pair_invites WHERE id=$1', [invite])).rows).toEqual([{ revoked_at: null }]);
  expect((await pg.query('SELECT * FROM pair_invites')).rows).toHaveLength(1);
});
