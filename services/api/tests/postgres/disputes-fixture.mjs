import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { replyFixture } from './chat-replies-fixture.mjs';
export { delay };
export const created = '2026-11-15T15:00:00.000Z', released = '2026-11-15T21:00:00.000Z';
export const early = () => new Date(created), due = () => new Date(released);
export const schedule = { judgeDate: '2026-11-16', timezone: 'Europe/Moscow' };
export const proposal = (scope, claim = 'Synthetic disputed claim') => ({ ...scope, commandId: randomUUID(), confirm: true, claim, condition: 'Optional synthetic nonbinding note', ...schedule });
export const command = (scope, dispute) => ({ ...scope, disputeId: dispute.id, expectedVersion: dispute.version, commandId: randomUUID(), confirm: true });
export async function fixture() {
 const result = await replyFixture();
 try { await result.f.domainPool.query(await readFile(new URL('../../migrations/045_disputes.sql', import.meta.url), 'utf8')); return result; }
 catch (e) { await result.f.close(); throw e; }
}
export async function observedWait(f, pid, locker) {
 for (let n = 0; n < 150; n++) {
  const waiter = pid();
  if (waiter && (await f.domainPool.query('SELECT $2=ANY(pg_blocking_pids(pid)) blocked FROM pg_stat_activity WHERE pid=$1', [waiter, locker])).rows[0]?.blocked) return;
  await delay(10);
 }
 assert.fail('Expected real PostgreSQL lock wait was not observed');
}
export function observed(db, state) {
 return { ...db, transaction: work => db.transaction(async tx => {
  state.waiter = (await tx.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  return work({ query(sql, args) {
   if (/SELECT claim,condition FROM disputes/i.test(sql)) state.bodies++;
   if (/FROM disputes/i.test(sql)) state.privateQueries = (state.privateQueries || 0) + 1;
   if (/INSERT INTO dispute_commands/i.test(sql)) state.receipt = true;
   return tx.query(sql, args);
  } });
 }) };
}
export async function lock(f, sql, args) {
 const holder = await f.domainPool.connect(); await holder.query('BEGIN');
 const locker = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
 await holder.query(sql, args); return { holder, locker };
}
export async function unlock(holder) { await holder.query('COMMIT'); holder.release(); }
export async function cleanup(holder, pending, f) {
 if (holder) { await holder.query('ROLLBACK'); holder.release(); }
 if (pending) await pending.catch(() => {});
 await f.close();
}
export function bodyFree(value) {
 assert.equal(/"(?:text|body|claim|condition)"\s*:/.test(JSON.stringify(value)), false);
}
