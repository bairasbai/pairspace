import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { closeCouple, readHistory, sendMessage } from '../src/chat.ts';
import { adapter, identityPrincipal, c1, c2, command, createFixture, failOn, history, id, outsider, principal, u2, u3, waiting } from './fixtures.ts';

let pg: PGlite;
beforeEach(async () => { pg = await createFixture(); });
afterEach(async () => { await pg.close(); });

describe('SQL-backed message use cases', () => {
  it('orders numeric sequences across digit widths with exclusive cursors', async () => {
    await pg.query(`INSERT INTO chat_messages(couple_id,sender_id,client_message_id,seq,body)
      SELECT $1,$2,gen_random_uuid(),n,'Synthetic pagination row'
      FROM generate_series(1,125) n`, [c1, principal.userId]);
    const db = adapter(pg);
    const latest = await readHistory(db, principal, history);
    expect(latest.ok).toBe(true);
    if (!latest.ok) return;
    expect(latest.value.messages.map(row => row.seq)).toEqual(
      Array.from({ length: 50 }, (_, index) => index + 76));
    expect(latest.value.nextBeforeSeq).toBe(76);
    const older = await readHistory(db, principal, { ...history, beforeSeq: 76 });
    expect(older.ok).toBe(true);
    if (!older.ok) return;
    expect(older.value.messages.map(row => row.seq)).toEqual(
      Array.from({ length: 50 }, (_, index) => index + 26));
    expect(older.value.nextBeforeSeq).toBe(26);
    const last = await readHistory(db, principal, { ...history, beforeSeq: 26 });
    expect(last).toMatchObject({ ok: true, value: { nextBeforeSeq: null } });
    if (!last.ok) return;
    expect(last.value.messages.map(row => row.seq)).toEqual(
      Array.from({ length: 25 }, (_, index) => index + 1));
  });

  it('persists canonical message + content-free outbox atomically', async () => {
    const db = adapter(pg);
    const sent = await sendMessage(db, principal, { ...command, body: 'e\u0301\r\nhello' });
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    expect(sent.value).toMatchObject({ replay: false, message: { body: 'é\nhello', seq: 1, senderId: principal.userId } });
    expect(sent.value.message.id).toMatch(/^[0-9a-f-]{36}$/);
    const events = await pg.query('SELECT * FROM outbox_events');
    expect(events.rows).toHaveLength(1);
    expect(JSON.stringify(events.rows)).not.toContain('hello');
    expect(events.rows[0]).toMatchObject({ couple_id: c1, message_id: sent.value.message.id, type: 'chat.message_created' });
    const result = await readHistory(db, identityPrincipal(u2), history);
    expect(result).toMatchObject({ ok: true, value: { messages: [sent.value.message], nextBeforeSeq: null } });
  });
  it('repeat after commit returns same message and does not allocate seq/outbox twice', async () => {
    const db = adapter(pg);
    const first = await sendMessage(db, principal, command);
    for (let i = 0; i < 20; i++) {
      const again = await sendMessage(db, principal, command);
      expect(again).toEqual(first.ok ? { ok: true, value: { ...first.value, replay: true } } : first);
    }
    expect((await pg.query('SELECT * FROM chat_messages')).rows).toHaveLength(1);
    expect((await pg.query('SELECT * FROM outbox_events')).rows).toHaveLength(1);
    expect((await pg.query<{ next_chat_seq: number }>('SELECT next_chat_seq FROM couples WHERE id=$1', [c1])).rows[0].next_chat_seq).toBe(2);
    expect(await sendMessage(db, principal, { ...command, body: 'Changed' })).toEqual({ ok: false, error: 'idempotency_conflict' });
  });
  it('client ID is scoped to author and pair and sender from input is ignored', async () => {
    const db = adapter(pg);
    await sendMessage(db, principal, { ...command, senderId: u3, userId: u3 });
    await sendMessage(db, identityPrincipal(u2), command);
    await sendMessage(db, identityPrincipal(u3), { ...command, coupleId: c2 });
    const rows = (await pg.query<{ sender_id: string; couple_id: string }>('SELECT sender_id,couple_id FROM chat_messages')).rows;
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ sender_id: principal.userId, couple_id: c1 });
  });
  it('rejects foreign, absent, inactive and stale memberships without message access', async () => {
    const db = adapter(pg);
    for (const person of [identityPrincipal(outsider), identityPrincipal(u3), identityPrincipal(id(99)), identityPrincipal('invalid')]) {
      expect(await sendMessage(db, person, command)).toEqual({ ok: false, error: 'unavailable' });
      expect(await readHistory(db, person, history)).toEqual({ ok: false, error: 'unavailable' });
      expect(await closeCouple(db, person, c1, 1)).toEqual({ ok: false, error: 'unavailable' });
    }
    expect(await sendMessage(db, principal, { ...command, membershipEpoch: 2 })).toEqual({ ok: false, error: 'stale_membership' });
    expect(await readHistory(db, principal, { ...history, membershipEpoch: 2 })).toEqual({ ok: false, error: 'stale_membership' });
    expect(await closeCouple(db, principal, c1, 2)).toEqual({ ok: false, error: 'stale_membership' });
    await pg.query("INSERT INTO couple_members(couple_id,user_id,slot,status) VALUES($1,$2,1,'revoked')", [waiting, principal.userId]);
    expect(await sendMessage(db, principal, { ...command, coupleId: waiting })).toEqual({ ok: false, error: 'unavailable' });
    await pg.query("INSERT INTO couple_members(couple_id,user_id,slot,status) VALUES($1,$2,1,'revoked')", [c1, outsider]);
    expect(await readHistory(db, identityPrincipal(outsider), history)).toEqual({ ok: false, error: 'unavailable' });
  });
  it('denies unknown couple without disclosing existence or epoch', async () => {
    const db = adapter(pg);
    expect(await sendMessage(db, principal, { ...command, coupleId: id(999) })).toEqual({ ok: false, error: 'unavailable' });
    expect(await readHistory(db, principal, { ...history, coupleId: id(999) })).toEqual({ ok: false, error: 'unavailable' });
    expect(await closeCouple(db, principal, id(999), 1)).toEqual({ ok: false, error: 'unavailable' });
  });
  it('takes the couple lock before a separate membership statement', async () => {
    const queries: string[] = [];
    const base = adapter(pg);
    const db = { now: base.now, sessionAuthority: base.sessionAuthority, transaction: <T>(work: Parameters<typeof base.transaction<T>>[0]) => base.transaction(tx => work({
      query: <R>(sql: string, params?: unknown[]) => { queries.push(sql); return tx.query<R>(sql, params); },
    })) };
    for (const operation of [() => sendMessage(db, principal, command), () => readHistory(db, principal, history)]) {
      queries.length = 0;
      expect(await operation()).toMatchObject({ ok: true });
      expect(queries[2]).toMatch(/FROM couples WHERE id = \$1\s+FOR (UPDATE|SHARE)/);
      expect(queries[0]).toContain('FROM users');
      expect(queries[1]).toContain('FROM auth_sessions');
      expect(queries[2]).not.toContain('JOIN');
      expect(queries[3]).toContain('FROM couple_members');
    }
  });
  it('paginates by authoritative server seq without gaps or mixing pairs', async () => {
    const db = adapter(pg);
    for (let i = 0; i < 5; i++) await sendMessage(db, principal, { ...command, clientId: id(101 + i), body: `Message ${i}` });
    await sendMessage(db, identityPrincipal(u3), { ...command, coupleId: c2, body: 'Other couple' });
    const page1 = await readHistory(db, principal, { ...history, limit: 2 });
    expect(page1).toMatchObject({ ok: true, value: { messages: [{ seq: 4 }, { seq: 5 }], nextBeforeSeq: 4 } });
    const page2 = await readHistory(db, principal, { ...history, beforeSeq: 4, limit: 2 });
    expect(page2).toMatchObject({ ok: true, value: { messages: [{ seq: 2 }, { seq: 3 }], nextBeforeSeq: 2 } });
    const page3 = await readHistory(db, principal, { ...history, beforeSeq: 2, limit: 2 });
    expect(page3).toMatchObject({ ok: true, value: { messages: [{ seq: 1 }], nextBeforeSeq: null } });
    expect(await readHistory(db, principal, { ...history, beforeSeq: 1 })).toEqual({ ok: true, value: { messages: [], nextBeforeSeq: null } });
  });
  it('outbox failure rolls back message and seq; retry succeeds once', async () => {
    const db = adapter(pg);
    await expect(sendMessage(failOn(db, 'INSERT INTO outbox_events'), principal, command)).rejects.toThrow('simulated_failure');
    expect((await pg.query('SELECT * FROM chat_messages')).rows).toEqual([]);
    expect((await pg.query('SELECT * FROM outbox_events')).rows).toEqual([]);
    expect(await sendMessage(db, principal, command)).toMatchObject({ ok: true, value: { replay: false, message: { seq: 1 } } });
  });
  it('close revokes future interactions and records an event but does not destroy archive', async () => {
    const db = adapter(pg);
    await sendMessage(db, principal, command);
    expect(await closeCouple(db, identityPrincipal(u2), c1, 1)).toEqual({ ok: true, value: null });
    expect(await closeCouple(db, principal, c1, 1)).toEqual({ ok: false, error: 'unavailable' });
    expect(await sendMessage(db, principal, command)).toEqual({ ok: false, error: 'unavailable' });
    expect(await readHistory(db, principal, history)).toEqual({ ok: false, error: 'unavailable' });
    expect((await pg.query('SELECT * FROM chat_messages')).rows).toHaveLength(1);
    const members = await pg.query<{ status: string }>('SELECT status FROM couple_members WHERE couple_id=$1', [c1]);
    expect(members.rows.every(row => row.status === 'revoked')).toBe(true);
    expect((await pg.query("SELECT * FROM outbox_events WHERE type='couple.closed'")).rows).toHaveLength(1);
  });
  it('close event failure rolls back membership and status', async () => {
    const db = adapter(pg);
    await expect(closeCouple(failOn(db, 'INSERT INTO outbox_events'), principal, c1, 1)).rejects.toThrow();
    expect(await sendMessage(db, principal, command)).toMatchObject({ ok: true });
  });
  it('rejects malformed request before SQL and never interpolates text', async () => {
    const db = adapter(pg);
    expect(await sendMessage(db, principal, null)).toEqual({ ok: false, error: 'invalid_request' });
    expect(await sendMessage(db, principal, { ...command, body: '' })).toEqual({ ok: false, error: 'empty_text' });
    expect(await readHistory(db, principal, {})).toEqual({ ok: false, error: 'invalid_request' });
    expect(await closeCouple(db, principal, 'bad', 1)).toEqual({ ok: false, error: 'invalid_request' });
    expect(await closeCouple(db, principal, c1, 0)).toEqual({ ok: false, error: 'invalid_request' });
    expect(await sendMessage(db, principal, { ...command, body: "'); DROP TABLE users; --" })).toMatchObject({ ok: true });
    expect((await pg.query('SELECT * FROM users')).rows).toHaveLength(5);
  });
});
