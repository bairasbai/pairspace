import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { replyFixture } from './chat-replies-fixture.mjs';
export { delay };
export const start = '2026-11-10T12:00:00.000Z', tomorrow = '2026-11-11T00:00:00.000Z';
export const early = () => new Date(start), past = () => new Date(tomorrow);
export const proposal = (scope, text = 'Synthetic private daily answer', expectedDay = '2026-11-10') => ({ ...scope, commandId: randomUUID(), confirm: true, text, expectedDay });
export const command = (scope, answer) => ({ ...scope, answerId: answer.id, expectedVersion: answer.version, commandId: randomUUID(), confirm: true });
export async function fixture() {
 const result = await replyFixture();
 try { await result.f.domainPool.query(await readFile(new URL('../../migrations/046_daily_questions.sql', import.meta.url), 'utf8')); return result; }
 catch (error) { await result.f.close(); throw error; }
}
export function observed(db, state) {
 return { ...db, transaction: work => db.transaction(async tx => {
  state.waiter = (await tx.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  return work({ query(sql, args) {
   if (/SELECT text FROM daily_question_answers/i.test(sql)) { state.bodies++; (state.bodyAuthors ??= []).push(args[3]); }
   if (/FROM daily_question_(answers|slots)/i.test(sql)) state.privateQueries = (state.privateQueries || 0) + 1;
   if (/INSERT INTO daily_question_commands/i.test(sql)) state.receipt = true;
   return tx.query(sql, args);
  } });
 }) };
}
export async function observedWait(f, pid, locker) {
 for (let n = 0; n < 150; n++) {
  const waiter = pid();
  if (waiter && (await f.domainPool.query('SELECT $2=ANY(pg_blocking_pids(pid)) blocked FROM pg_stat_activity WHERE pid=$1', [waiter, locker])).rows[0]?.blocked) return;
  await delay(10);
 }
 assert.fail('Expected real PostgreSQL lock wait was not observed');
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
export function bodyFree(value) { assert.equal(/"text"\s*:/.test(JSON.stringify(value)), false); }
