import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { sendMessage } from '../src/chat.ts';
import { adapter, c1, c2, command, createFixture, id, outsider, principal, u2, u3, waiting } from './fixtures.ts';

let pg: PGlite;
beforeEach(async () => { pg = await createFixture(); });
afterEach(async () => { await pg.close(); });

it('enforces two slots, one active couple and exactly two active members', async () => {
  await expect(pg.query("INSERT INTO couple_members VALUES($1,$2,3,'active')", [c1, outsider])).rejects.toMatchObject({ code: '23514' });
  await expect(pg.query("INSERT INTO couple_members VALUES($1,$2,1,'active')", [c1, outsider])).rejects.toMatchObject({ code: '23505' });
  await expect(pg.query("INSERT INTO couple_members VALUES($1,$2,1,'active')", [waiting, u2])).rejects.toMatchObject({ code: '23505' });
  await expect(pg.query("INSERT INTO couples(id,status) VALUES($1,'active')", [id(99)])).rejects.toMatchObject({ code: '23514' });
  await expect(pg.query("UPDATE couples SET status='active' WHERE id=$1", [waiting])).rejects.toMatchObject({ code: '23514' });
  await expect(pg.query("DELETE FROM couple_members WHERE couple_id=$1 AND user_id=$2", [c1, u2])).rejects.toMatchObject({ code: '23514' });
  await expect(pg.query("UPDATE couple_members SET status='revoked' WHERE couple_id=$1 AND user_id=$2", [c1, u2])).rejects.toMatchObject({ code: '23514' });
  expect((await pg.query('SELECT * FROM couple_members WHERE couple_id=$1', [c1])).rows).toHaveLength(2);
});
it('composite foreign keys forbid cross-couple sender and outbox message association', async () => {
  await expect(pg.query('INSERT INTO chat_messages(couple_id,sender_id,client_message_id,seq,body) VALUES($1,$2,$3,1,$4)', [c1, u3, id(100), 'text'])).rejects.toMatchObject({ code: '23503' });
  const result = await sendMessage(adapter(pg), principal, command);
  if (!result.ok) throw new Error(result.error);
  await expect(pg.query("UPDATE outbox_events SET couple_id=$1 WHERE message_id=$2", [c2, result.value.message.id])).rejects.toMatchObject({ code: '23503' });
});
it('SQL checks enforce normalized bounds and server sequence invariants', async () => {
  for (const body of ['', ' ', 'x'.repeat(8001), 'e\u0301']) {
    await expect(pg.query('INSERT INTO chat_messages(couple_id,sender_id,client_message_id,seq,body) VALUES($1,$2,$3,1,$4)', [c1, principal.userId, id(100), body])).rejects.toMatchObject({ code: '23514' });
  }
  await expect(pg.query('UPDATE couples SET next_chat_seq=9007199254740992 WHERE id=$1', [c1])).rejects.toMatchObject({ code: '23514' });
  await sendMessage(adapter(pg), principal, command);
  await expect(pg.query('INSERT INTO chat_messages(couple_id,sender_id,client_message_id,seq,body) VALUES($1,$2,$3,1,$4)', [c1, principal.userId, id(102), 'text'])).rejects.toMatchObject({ code: '23505' });
});
it('outbox permits references only, forbids duplicate and incoherent event kinds', async () => {
  const result = await sendMessage(adapter(pg), principal, command);
  if (!result.ok) throw new Error(result.error);
  const columns = await pg.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name='outbox_events'");
  expect(columns.rows.map(row => row.column_name).sort()).toEqual(['id', 'couple_id', 'type', 'message_id', 'created_at', 'processed_at'].sort());
  await expect(pg.query("INSERT INTO outbox_events(couple_id,type,message_id) VALUES($1,'chat.message_created',$2)", [c1, result.value.message.id])).rejects.toMatchObject({ code: '23505' });
  await expect(pg.query("INSERT INTO outbox_events(couple_id,type) VALUES($1,'chat.message_created')", [c1])).rejects.toMatchObject({ code: '23514' });
  await expect(pg.query("INSERT INTO outbox_events(couple_id,type,message_id) VALUES($1,'couple.closed',$2)", [c1, result.value.message.id])).rejects.toMatchObject({ code: '23514' });
});

it('provider identity migration enforces domain FK and one-to-one mapping without session copies', async () => {
  await pg.exec(await readFile(new URL('../migrations/003_better_auth_identity.sql', import.meta.url), 'utf8'));
  await pg.query('INSERT INTO better_auth_identities VALUES ($1,$2)', ['provider-one', principal.userId]);
  await expect(pg.query('INSERT INTO better_auth_identities VALUES ($1,$2)', ['provider-one', u2])).rejects.toMatchObject({ code: '23505' });
  await expect(pg.query('INSERT INTO better_auth_identities VALUES ($1,$2)', ['provider-two', principal.userId])).rejects.toMatchObject({ code: '23505' });
  await expect(pg.query('INSERT INTO better_auth_identities VALUES ($1,$2)', ['provider-three', id(999)])).rejects.toMatchObject({ code: '23503' });
  await expect(pg.query('INSERT INTO better_auth_identities VALUES ($1,$2)', ['', u2])).rejects.toMatchObject({ code: '23514' });
  expect((await pg.query('SELECT * FROM better_auth_identities')).rows).toHaveLength(1);
});
