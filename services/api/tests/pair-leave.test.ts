import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { leavePair, parseLeave } from '../src/pair-leave.ts';
import { closeCouple, readHistory, sendMessage } from '../src/chat.ts';
import { createPairLeaveHandler } from '../src/pair-leave-http.ts';
import { adapter, c1, c2, command, createFixture, failOn, history, id, identityPrincipal, principal, u1, u2, u3, outsider, waiting } from './fixtures.ts';
import type { AuthorizedDatabase, SqlExecutor } from '../src/contracts.ts';

let pg: PGlite;
const leave = { commandId: id(500), coupleId: c1, membershipEpoch: 1, confirm: true };
beforeEach(async () => {
  pg = await createFixture();
  await pg.exec(await readFile(new URL('../migrations/008_pair_leave.sql', import.meta.url), 'utf8'));
});
afterEach(async () => { await pg.close(); });
const receipt = async () => (await pg.query('SELECT * FROM pair_leave_commands')).rows;
function wrap(base: AuthorizedDatabase, hook: (sql: string, params: unknown[] | undefined, tx: SqlExecutor) => Promise<void>): AuthorizedDatabase {
  return { ...base, transaction: work => base.transaction(tx => work({ query: async <T>(sql: string, params?: unknown[]) => {
    const rows = await tx.query<T>(sql, params); await hook(sql, params, tx); return rows;
  } })) };
}

it('strict immutable command parser rejects extra selectors and canonicalizes UUID spelling', () => {
  for (const value of [null, [], {}, { ...leave, confirm: false }, { ...leave, userId: u1 }, { ...leave, commandId: 'x' },
    { ...leave, coupleId: 'x' }, { ...leave, membershipEpoch: 0 }, { ...leave, membershipEpoch: 2147483647 }]) expect(parseLeave(value)).toBeNull();
  expect(parseLeave({ ...leave, commandId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' })?.commandId).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
});
it('closes unilaterally, preserves records, revokes invitations and returns only scoped closure metadata', async () => {
  const db = adapter(pg);
  await sendMessage(db, principal, command);
  await pg.query(`INSERT INTO pair_invites(couple_id,issuer_user_id,command_id,token_hash,created_at,expires_at)
    VALUES($1,$2,$3,$4,'2026-01-01','2100-01-01')`, [c1, u1, id(601), 'a'.repeat(64)]);
  expect(await leavePair(db, principal, leave)).toEqual({ ok: true, value: { state: 'closed', sessionId: principal.sessionId,
    userId: u1, coupleId: c1, commandId: leave.commandId, membershipEpoch: 1, replayed: false } });
  expect(await leavePair(db, principal, leave)).toMatchObject({ ok: true, value: { replayed: true } });
  expect(await leavePair(db, identityPrincipal(u2), { ...leave, commandId: id(501) })).toMatchObject({ ok: true, value: { replayed: true } });
  expect(await receipt()).toHaveLength(2);
  expect((await pg.query('SELECT * FROM chat_messages')).rows).toHaveLength(1);
  expect((await pg.query('SELECT revoked_at FROM pair_invites')).rows[0]).not.toEqual({ revoked_at: null });
  expect(await readHistory(db, principal, history)).toMatchObject({ ok: false });
  expect(await sendMessage(db, identityPrincipal(u2), command)).toMatchObject({ ok: false });
  expect((await pg.query("SELECT * FROM outbox_events WHERE type='couple.closed'")).rows).toHaveLength(1);
  expect((await pg.query('SELECT status FROM couples WHERE id=$1', [c2])).rows).toEqual([{ status: 'active' }]);
});
it('legacy close uses the same sorted locks, invitation revoke, and historical proof', async () => {
  const queries: { sql: string; params: unknown[] | undefined }[] = [];
  const db = wrap(adapter(pg), async (sql, params) => { queries.push({ sql, params }); });
  expect(await closeCouple(db, identityPrincipal(u2), c1, 1)).toEqual({ ok: true, value: null });
  const users = queries.filter(q => q.sql === 'SELECT id FROM users WHERE id=$1 FOR UPDATE');
  expect(users.map(q => q.params?.[0])).toEqual([u1, u2]);
  expect(queries.findIndex(q => q.sql.includes('FROM auth_sessions'))).toBeGreaterThan(queries.indexOf(users[1]));
  expect(queries.some(q => q.sql.includes('UPDATE pair_invites'))).toBe(true);
  expect(await leavePair(adapter(pg), principal, leave)).toMatchObject({ ok: true, value: { replayed: true } });
});
it('never follows a stale confirmation or old receipt into a new pair', async () => {
  const db = adapter(pg); await leavePair(db, principal, leave);
  await pg.transaction(async tx => {
    await tx.query("INSERT INTO couple_members VALUES($1,$2,1,'active')", [waiting, u1]);
  });
  expect(await leavePair(db, principal, leave)).toMatchObject({ ok: true, value: { coupleId: c1, replayed: true } });
  expect(await leavePair(db, principal, { ...leave, coupleId: waiting })).toEqual({ ok: false, error: 'pair_unavailable' });
  expect((await pg.query('SELECT status FROM couple_members WHERE couple_id=$1', [waiting])).rows).toEqual([{ status: 'active' }]);
});
it('same command cannot be rebound to another real active pair', async () => {
  const db = adapter(pg); await leavePair(db, principal, leave);
  await pg.transaction(async tx => {
    await tx.query("INSERT INTO couple_members VALUES($1,$2,1,'active'),($1,$3,2,'active')", [waiting, u1, u2]);
    await tx.query("UPDATE couples SET status='active' WHERE id=$1", [waiting]);
  });
  expect(await leavePair(db, principal, { ...leave, coupleId: waiting })).toEqual({ ok: false, error: 'pair_unavailable' });
  expect((await pg.query('SELECT status FROM couples WHERE id=$1', [waiting])).rows).toEqual([{ status: 'active' }]);
});
it('foreign, absent, wrong-epoch and waiting targets cannot close anything', async () => {
  const db = adapter(pg);
  for (const target of [c2, waiting, id(999)]) expect(await leavePair(db, principal, { ...leave, coupleId: target })).toEqual({ ok: false, error: 'pair_unavailable' });
  for (const actor of [identityPrincipal(outsider), identityPrincipal(u3)]) expect(await leavePair(db, actor, leave)).toEqual({ ok: false, error: 'pair_unavailable' });
  expect(await leavePair(db, principal, { ...leave, membershipEpoch: 2 })).toEqual({ ok: false, error: 'pair_unavailable' });
  await pg.query("INSERT INTO couple_members VALUES($1,$2,1,'active')", [waiting, outsider]);
  expect(await leavePair(db, identityPrincipal(outsider), { ...leave, coupleId: waiting })).toEqual({ ok: false, error: 'pair_unavailable' });
  expect(await receipt()).toEqual([]);
});
it('auth and mutation failures preserve pair and receipt atomicity', async () => {
  const db = adapter(pg);
  expect(await leavePair(db, { ...principal, sessionId: 'bad' }, leave)).toEqual({ ok: false, error: 'unauthenticated' });
  expect(await leavePair(db, principal, null)).toEqual({ ok: false, error: 'invalid_request' });
  for (const statement of ['INSERT INTO outbox_events', 'INSERT INTO pair_leave_commands', 'UPDATE pair_invites']) {
    await expect(leavePair(failOn(db, statement), principal, leave)).rejects.toThrow();
    expect(await receipt()).toEqual([]);
    expect((await pg.query('SELECT status FROM couples WHERE id=$1', [c1])).rows).toEqual([{ status: 'active' }]);
  }
  await pg.query("UPDATE auth_sessions SET revoked_at='2026-11-10' WHERE id=$1", [principal.sessionId]);
  expect(await leavePair(db, principal, leave)).toEqual({ ok: false, error: 'unauthenticated' });
});
it('post-couple-lock expiry rejects chat write/read, legacy close and leave', async () => {
  for (const operation of ['send', 'read', 'close', 'leave']) {
    let expired = false;
    const base = { ...adapter(pg), now: () => new Date(expired ? '2101-01-01' : '2026-11-10') };
    const db = wrap(base, async sql => { if (sql.includes('FROM couples')) expired = true; });
    const result = operation === 'send' ? await sendMessage(db, principal, command)
      : operation === 'read' ? await readHistory(db, principal, history)
        : operation === 'close' ? await closeCouple(db, principal, c1, 1) : await leavePair(db, principal, leave);
    expect(result).toMatchObject({ ok: false });
  }
  expect(await receipt()).toEqual([]);
});
it('closed members, pair epoch and receipt cannot be resurrected or rewritten', async () => {
  await leavePair(adapter(pg), principal, leave);
  await expect(pg.query("UPDATE couple_members SET status='active' WHERE couple_id=$1", [c1])).rejects.toThrow('closed_pair_has_active_members');
  await expect(pg.query("UPDATE couples SET status='waiting_partner' WHERE id=$1", [c1])).rejects.toThrow('closed_pair_is_final');
  await expect(pg.query('UPDATE couples SET membership_epoch=membership_epoch+1 WHERE id=$1', [c1])).rejects.toThrow('closed_pair_is_final');
  await expect(pg.query('UPDATE pair_leave_commands SET membership_epoch=2')).rejects.toThrow('immutable_pair_leave_receipt');
  await expect(pg.query('DELETE FROM pair_leave_commands')).rejects.toThrow('immutable_pair_leave_receipt');
});
it('closed-but-unproven rows and changed epoch replays do not get invented success', async () => {
  await pg.transaction(async tx => {
    await tx.query("UPDATE couples SET status='closed',membership_epoch=2 WHERE id=$1", [c1]);
    await tx.query("UPDATE couple_members SET status='revoked' WHERE couple_id=$1", [c1]);
  });
  expect(await leavePair(adapter(pg), principal, leave)).toEqual({ ok: false, error: 'pair_unavailable' });
  expect(await leavePair(adapter(pg), principal, { ...leave, membershipEpoch: 2 })).toEqual({ ok: false, error: 'pair_unavailable' });
});
it('HTTP bounds shape/auth failures and redacts internal errors', async () => {
  const db = adapter(pg);
  const authed = { ...db, sessionAuthority: { ...db.sessionAuthority, authenticate: async () => principal } };
  const handler = createPairLeaveHandler(authed);
  const request = (method = 'POST', body = JSON.stringify(leave), suffix = '', headers = { 'content-type': 'application/json' }) =>
    new Request('http://localhost/v1/pair/leave' + suffix, { method, headers, ...(['GET', 'HEAD'].includes(method) ? {} : { body }) });
  expect((await handler(request('GET'))).status).toBe(405);
  expect((await handler(request('POST', '{}', '/bad'))).status).toBe(404);
  expect((await handler(request('POST', '{}', '?x=1'))).status).toBe(400);
  expect((await handler(request('POST', '{}', '', { 'content-type': 'text/plain' }))).status).toBe(415);
  expect((await handler(request('POST', '{'))).status).toBe(400);
  expect((await handler(request('POST', '{}'))).status).toBe(400);
  expect((await createPairLeaveHandler(db)(request())).status).toBe(401);
  expect((await handler(request('POST', JSON.stringify({ ...leave, coupleId: c2 })))).status).toBe(409);
  const failed = createPairLeaveHandler(failOn(authed, 'UPDATE pair_invites'));
  expect(await (await failed(request())).json()).toEqual({ ok: false, error: 'temporarily_unavailable' });
  const success = await handler(request()); expect(success.status).toBe(200);
  expect(success.headers.get('cache-control')).toBe('no-store');
  await pg.query("UPDATE auth_sessions SET revoked_at='2026-11-10' WHERE id=$1", [principal.sessionId]);
  expect((await handler(request())).status).toBe(401);
});

it('delayed partner receipt and exact replay retain the original closure event timestamp', async () => {
  const db = adapter(pg);
  await leavePair(db, principal, leave);
  const event = (await pg.query<{ created_at: string }>("SELECT created_at::text FROM outbox_events WHERE type='couple.closed' AND couple_id=$1", [c1])).rows[0].created_at;
  await pg.query('SELECT pg_sleep(0.03)');
  await leavePair(db, identityPrincipal(u2), { ...leave, commandId: id(502) });
  await leavePair(db, principal, leave);
  const stamps = (await pg.query<{ closed_at: string }>('SELECT closed_at::text FROM pair_leave_commands')).rows;
  expect(stamps).toEqual([{ closed_at: event }, { closed_at: event }]);
});
it('delayed acknowledgement of legacy close records its original event timestamp', async () => {
  const db = adapter(pg);
  await closeCouple(db, identityPrincipal(u2), c1, 1);
  const event = (await pg.query<{ created_at: string }>("SELECT created_at::text FROM outbox_events WHERE type='couple.closed' AND couple_id=$1", [c1])).rows[0].created_at;
  await pg.query('SELECT pg_sleep(0.03)');
  await leavePair(db, principal, leave);
  expect((await pg.query('SELECT closed_at::text FROM pair_leave_commands')).rows).toEqual([{ closed_at: event }]);
});
