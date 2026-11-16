import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { replyFixture } from './chat-replies-fixture.mjs';
export { delay };
export const created = '2026-11-15T15:00:00.000Z', released = '2026-11-16T06:00:00.000Z';
export const early = () => new Date(created), due = () => new Date(released);
export const schedule = { localDate: '2026-11-16', localTime: '09:00', timezone: 'Europe/Moscow', offset: '+03:00' };
export const laterSchedule = { ...schedule, localDate: '2026-11-18' };
export const proposal = (scope, text = 'Synthetic private capsule') => ({ ...scope, commandId: randomUUID(), confirm: true, text, schedule });
export const command = (scope, capsule) => ({ ...scope, capsuleId: capsule.id, expectedVersion: capsule.version, commandId: randomUUID(), confirm: true });
export async function fixture() {
 const result = await replyFixture();
 try { await result.f.domainPool.query(await readFile(new URL('../../migrations/044_capsules.sql', import.meta.url), 'utf8')); return result; }
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
   if (/SELECT body FROM capsules/i.test(sql)) state.bodies++;
   if (/FROM capsules/i.test(sql)) state.privateQueries = (state.privateQueries || 0) + 1;
   if (/INSERT INTO capsule_commands/i.test(sql)) state.receipt = true;
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
 assert.equal(/"(?:text|body)"\s*:/.test(JSON.stringify(value)), false);
}
