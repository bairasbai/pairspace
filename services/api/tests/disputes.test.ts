import { readFile } from 'node:fs/promises';
import { beforeAll, afterAll, it, expect } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import type { AuthorizedDatabase } from '../src/contracts.ts';
import { createDispute as create, joinDispute as join, declineDispute as decline, resolveDispute as resolve,
  removeDispute as remove, readDispute as read, listDisputes as list } from '../src/disputes.ts';
import { adapter, createFixture, id, principal, identityPrincipal, u2, outsider, c1, c2, waiting } from './fixtures.ts';
let pg: PGlite, seq = 161000;
const scope = { coupleId: c1, membershipEpoch: 1 }, recipient = identityPrincipal(u2);
const start = '2026-11-10T00:00:00.000Z', due = '2026-11-11T00:00:00.000Z';
const clock = (value = start) => () => new Date(value);
const db = () => adapter(pg), command = () => ({ ...scope, commandId: id(++seq), confirm: true });
const creation = () => ({ ...command(), claim: 'Synthetic claim', condition: null, judgeDate: '2026-11-11', timezone: 'UTC' });
beforeAll(async () => { pg = await createFixture(); await pg.exec(await readFile(new URL('../migrations/045_disputes.sql', import.meta.url), 'utf8')); });
afterAll(async () => pg.close());
async function make() {
 const input = creation(), result = await create(db(), principal, input, clock());
 if (!result.ok) throw Error('fixture');
 return { input, q: result.value.dispute, action: { ...command(), disputeId: result.value.dispute.id, expectedVersion: 1 } };
}
function distort(base: AuthorizedDatabase, prefix: string, change: (rows: unknown[]) => unknown[]): AuthorizedDatabase {
 return { ...base, transaction: work => base.transaction(tx => work({ query: async <T>(sql: string, args?: unknown[]) => {
  const result = await tx.query<T>(sql, args); return sql.startsWith(prefix) ? { rows: change(result.rows) as T[] } : result;
 } })) };
}
function observe(base: AuthorizedDatabase, action: (sql: string) => void): AuthorizedDatabase {
 return { ...base, transaction: work => base.transaction(tx => work({ query: async <T>(sql: string, args?: unknown[]) => {
  const result = await tx.query<T>(sql, args); action(sql); return result;
 } })) };
}
const receipt = 'SELECT fingerprint,dispute_id,operation,applied FROM dispute_commands';
it('metadata-only ACK/list/replay, separate shared body, joined draw and author removal', async () => {
 const { input, q, action } = await make(), detail = { ...scope, disputeId: q.id };
 let bodies = 0; const tracked = observe(db(), sql => { if (sql.startsWith('SELECT claim,condition')) bodies++; });
 expect(await list(tracked, recipient, scope, clock())).toMatchObject({ value: { capacity: 100 } }); expect(bodies).toBe(0);
 expect(await read(tracked, recipient, detail, clock())).toMatchObject({ value: { claim: input.claim, condition: null } });
 expect(await join(db(), recipient, action, clock())).toMatchObject({ value: { dispute: { version: 2, decisionState: 'joined' } } });
 expect(await join(db(), recipient, action, clock(due))).toMatchObject({ value: { replay: true } });
 const verdict = { ...action, commandId: id(++seq), expectedVersion: 2, winnerId: null };
 expect(await resolve(db(), principal, verdict, clock())).toEqual({ ok: false, error: 'not_due' });
 expect(await resolve(db(), principal, verdict, clock(due))).toMatchObject({ value: { dispute: { version: 3, winnerId: null, resolvedBy: principal.userId } } });
 expect(await resolve(db(), principal, verdict, clock(due))).toMatchObject({ value: { replay: true } });
 expect(await remove(db(), principal, { ...action, commandId: id(++seq), expectedVersion: 3 }, clock(due))).toMatchObject({ value: { dispute: { version: 4, contentState: 'removed' } } });
 for (const result of [await create(db(), principal, input, clock(due)), await join(db(), recipient, action, clock(due)), await resolve(db(), principal, verdict, clock(due))]) {
  expect(result).toMatchObject({ value: { replay: true, dispute: { contentState: 'removed' } } }); expect(JSON.stringify(result)).not.toMatch(/"(?:claim|condition)":/);
 }
 expect(await read(tracked, principal, detail, clock(due))).not.toHaveProperty('value.claim'); expect(bodies).toBe(1);
 expect((await pg.query('SELECT claim,condition FROM disputes WHERE id=$1', [q.id])).rows).toEqual([{ claim: null, condition: null }]);
 expect(await create(db(), principal, { ...input, claim: 'Different' }, clock())).toEqual({ ok: false, error: 'idempotency_conflict' });
});
it('recipient can decline or withdraw after due, never a loss; roles, stale CAS and terminal states fail closed', async () => {
 const { q, action } = await make();
 expect(await join(db(), principal, action, clock())).toEqual({ ok: false, error: 'unavailable' });
 expect(await remove(db(), recipient, action, clock())).toEqual({ ok: false, error: 'unavailable' });
 expect(await join(db(), recipient, { ...action, expectedVersion: 2 }, clock())).toEqual({ ok: false, error: 'version_conflict' });
 expect(await join(db(), recipient, action, clock(due))).toEqual({ ok: false, error: 'version_conflict' });
 expect(await decline(db(), recipient, action, clock(due))).toMatchObject({ value: { dispute: { decisionState: 'declined', winnerId: null } } });
 expect(await decline(db(), recipient, action, clock(due))).toMatchObject({ value: { replay: true } });
 const fresh = await make(); await join(db(), recipient, fresh.action, clock());
 expect(await decline(db(), recipient, { ...fresh.action, commandId: id(++seq), expectedVersion: 2 }, clock(due))).toMatchObject({ value: { dispute: { version: 3, joinedAt: start, decisionState: 'declined' } } });
 expect(await resolve(db(), principal, { ...fresh.action, commandId: id(++seq), expectedVersion: 3, winnerId: principal.userId }, clock(due))).toEqual({ ok: false, error: 'version_conflict' });
 expect(await remove(db(), principal, { ...action, commandId: id(++seq), expectedVersion: 2 }, clock(due))).toMatchObject({ ok: true });
 expect(await remove(db(), principal, { ...action, commandId: id(++seq), expectedVersion: 3 }, clock(due))).toEqual({ ok: false, error: 'version_conflict' });
 expect(await read(db(), principal, { ...scope, disputeId: q.id }, clock())).toEqual({ ok: false, error: 'unavailable' });
});
it('exact inputs, all roles and pair/epoch/principal gates', async () => {
 const { input, q, action } = await make();
 const cases = [[create, input], [list, scope], [read, { ...scope, disputeId: q.id }], [join, action], [decline, action], [remove, action], [resolve, { ...action, winnerId: null }]] as const;
 for (const [operation, request] of cases) {
  for (const actor of [identityPrincipal(outsider), { ...principal, userId: 'bad' }, { ...principal, tokenExpiresAt: 1 }]) expect(await operation(db(), actor, request, clock())).toEqual({ ok: false, error: 'unavailable' });
  for (const coupleId of [c2, waiting, id(999)]) expect(await operation(db(), principal, { ...request, coupleId }, clock())).toEqual({ ok: false, error: 'unavailable' });
  expect(await operation(db(), principal, { ...request, membershipEpoch: 2 }, clock())).toEqual({ ok: false, error: 'stale_membership' });
  for (const bad of [null, [], {}, { ...request, extra: true }, { ...request, coupleId: 'bad' }, { ...request, membershipEpoch: 0 }]) expect(await operation(db(), principal, bad, clock())).toEqual({ ok: false, error: 'invalid_request' });
 }
 for (const patch of [{ claim: '' }, { claim: 'a\rb' }, { condition: 3 }, { judgeDate: 'bad' }, { confirm: false }, { commandId: 'bad' }]) expect(await create(db(), principal, { ...input, ...patch }, clock())).toEqual({ ok: false, error: 'invalid_request' });
 for (const patch of [{ confirm: false }, { commandId: 'bad' }, { expectedVersion: 0 }, { expectedVersion: 4 }, { expectedVersion: '1' }, { disputeId: 'bad' }]) expect(await remove(db(), principal, { ...action, ...patch }, clock())).toEqual({ ok: false, error: 'invalid_request' });
 expect(await resolve(db(), principal, { ...action, winnerId: 'bad' }, clock())).toEqual({ ok: false, error: 'invalid_request' });
 expect(await read(db(), principal, { ...scope, disputeId: 'bad' }, clock())).toEqual({ ok: false, error: 'invalid_request' });
 expect(await remove(db(), principal, { ...action, disputeId: id(999) }, clock())).toEqual({ ok: false, error: 'unavailable' });
 expect(await create(db(), principal, creation(), clock(due))).toEqual({ ok: false, error: 'invalid_request' });
});
it('clock failures, pre-event clocks, missing targets, invalid metadata and invalid body never leak text', async () => {
 const { input, q, action } = await make(), detail = { ...scope, disputeId: q.id };
 for (const [operation, request] of [[list, scope], [create, input], [read, detail], [remove, action]] as const) {
  expect(await operation(db(), principal, request, clock('2026-11-09T00:00:00.000Z'))).toEqual({ ok: false, error: 'unavailable' });
  await expect(operation(db(), principal, request, () => new Date('bad'))).rejects.toThrow('invalid_dispute_clock');
 }
 expect(await read(db(), principal, { ...scope, disputeId: id(999) }, clock())).toEqual({ ok: false, error: 'unavailable' });
 await expect(list(distort(db(), 'SELECT id,couple_id', rows => Array.from({ length: 101 }, () => rows[0])), principal, scope, clock(due))).rejects.toThrow('invalid_dispute_capacity');
 await expect(read(distort(db(), 'SELECT id,couple_id', rows => [{ ...(rows[0] as object), version: 99 }]), principal, detail, clock())).rejects.toThrow('invalid_dispute_record');
 for (const rows of [[], [{ claim: null, condition: null }], [{ claim: ' noncanonical ', condition: null }], [{ claim: 'ok', condition: '' }], [{ claim: 'ok', condition: 2 }]]) await expect(read(distort(db(), 'SELECT claim,condition', () => rows), principal, detail, clock())).rejects.toThrow('invalid_dispute_body');
 let instant = due; const tracked = observe(db(), sql => { if (sql.startsWith('SELECT claim,condition')) instant = start; });
 expect(await read(tracked, principal, detail, () => new Date(instant))).toEqual({ ok: false, error: 'unavailable' });
});
it('matching fingerprint alone cannot forge applied operation, schedule, actor or transition', async () => {
 const { input, q, action } = await make();
 for (const patch of [{ operation: 'join' }, { applied: {} }, { applied: { ...q, id: id(999) } }, { applied: { ...q, claim: 'leak' } },
  { applied: { ...q, judgeDate: '2026-11-12' } }, { applied: { ...q, version: 2, joinedAt: start, decisionState: 'joined' } }]) await expect(create(distort(db(), receipt, rows => [{ ...(rows[0] as object), ...patch }]), principal, input, clock())).rejects.toThrow('invalid_dispute_replay');
 expect(await create(distort(db(), 'SELECT id,couple_id', () => []), principal, input, clock())).toEqual({ ok: false, error: 'unavailable' });
 await join(db(), recipient, action, clock());
 await expect(join(distort(db(), receipt, rows => [{ ...(rows[0] as object), applied: q }]), recipient, action, clock())).rejects.toThrow('invalid_dispute_replay');
 const verdict = { ...action, commandId: id(++seq), expectedVersion: 2, winnerId: null }; const done = await resolve(db(), principal, verdict, clock(due));
 if (!done.ok) throw Error('fixture');
 for (const patch of [{ winnerId: recipient.userId }, { resolvedBy: recipient.userId }]) await expect(resolve(distort(db(), receipt, rows => [{ ...(rows[0] as object), applied: { ...done.value.dispute, ...patch } }]), principal, verdict, clock(due))).rejects.toThrow('invalid_dispute_replay');
});
it('tampered writes and receipts roll back both database effects', async () => {
 const input = creation(), before = (await pg.query('SELECT id FROM disputes')).rows.length;
 const attempts: [string, (rows: unknown[]) => unknown[], string][] = [
  ['INSERT INTO disputes(', () => [], 'invalid_dispute_write'],
  ['INSERT INTO disputes(', rows => [{ ...(rows[0] as object), author_id: recipient.userId, recipient_id: principal.userId }], 'invalid_dispute_applied_state'],
  ['INSERT INTO dispute_commands', () => [], 'invalid_dispute_receipt'],
  ...[{ fingerprint: 'bad' }, { dispute_id: id(999) }, { operation: 'remove' }, { applied: {} }].map(patch => ['INSERT INTO dispute_commands', (rows: unknown[]) => [{ ...(rows[0] as object), ...patch }], 'invalid_dispute_receipt'] as [string, (rows: unknown[]) => unknown[], string]),
 ];
 for (const [prefix, change, error] of attempts) {
  await expect(create(distort(db(), prefix, change), principal, input, clock())).rejects.toThrow(error);
  expect((await pg.query('SELECT id FROM disputes')).rows.length).toBe(before);
  expect((await pg.query('SELECT command_id FROM dispute_commands WHERE command_id=$1', [input.commandId])).rows).toEqual([]);
 }
});
it('late session/date/clock checks roll back writes and receipts; metadata has no bodySELECT', async () => {
 const input = creation(), base = db(); let written = false;
 const expired = observe({ ...base, sessionAuthority: { ...base.sessionAuthority, recheck: async (...args) => !written && base.sessionAuthority.recheck(...args) } }, sql => { if (sql.startsWith('INSERT INTO dispute_commands')) written = true; });
 expect(await create(expired, principal, input, clock())).toEqual({ ok: false, error: 'unavailable' });
 let instant = start; const crossing = observe(db(), sql => { if (sql.startsWith('INSERT INTO dispute_commands')) instant = due; });
 expect(await create(crossing, principal, input, () => new Date(instant))).toEqual({ ok: false, error: 'unavailable' });
 const { q, action } = await make(); instant = start;
 expect(await join(crossing, recipient, action, () => new Date(instant))).toEqual({ ok: false, error: 'unavailable' });
 expect((await pg.query('SELECT version FROM disputes WHERE id=$1', [q.id])).rows).toEqual([{ version: 1 }]);
 await join(db(), recipient, action, clock()); instant = due;
 const backward = observe(db(), sql => { if (sql.startsWith('INSERT INTO dispute_commands')) instant = start; });
 expect(await resolve(backward, principal, { ...action, commandId: id(++seq), expectedVersion: 2, winnerId: null }, () => new Date(instant))).toEqual({ ok: false, error: 'unavailable' });
 const statements: string[] = []; await list(observe(db(), sql => statements.push(sql)), principal, scope, clock(due));
 expect(statements.some(sql => sql.startsWith('SELECT claim,condition'))).toBe(false);
});
it('session loss after list/count/receipt/target/body query denies output', async () => {
 const { input, q, action } = await make(), detail = { ...scope, disputeId: q.id };
 for (const [operation, request, prefix] of [[list, scope, 'SELECT id,couple_id'], [read, detail, 'SELECT id,couple_id'], [read, detail, 'SELECT claim,condition'],
  [create, input, receipt], [create, input, 'SELECT id,couple_id'], [create, creation(), 'SELECT count(*)'], [remove, action, 'SELECT id,couple_id']] as const) {
  const base = db(); let stopped = false;
  const tracked = observe({ ...base, sessionAuthority: { ...base.sessionAuthority, recheck: async (...args) => !stopped && base.sessionAuthority.recheck(...args) } }, sql => { if (sql.startsWith(prefix)) stopped = true; });
  expect(await operation(tracked, principal, request, clock(due))).toEqual({ ok: false, error: 'unavailable' });
 }
});
it('lifetime capacity includes removed tombstones and preserves replay', async () => {
 const { input } = await make(); let used = (await pg.query<{ n: number }>('SELECT count(*)::int n FROM disputes')).rows[0].n;
 while (used++ < 100) await make();
 expect(await create(db(), principal, creation(), clock())).toEqual({ ok: false, error: 'capacity_reached' });
 expect(await create(db(), principal, input, clock())).toMatchObject({ value: { replay: true } });
 expect(await list(db(), principal, scope, clock(due))).toMatchObject({ value: { used: 100, capacity: 100 } });
});
