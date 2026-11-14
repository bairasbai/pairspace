import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { replyFixture } from './chat-replies-fixture.mjs';
test('prove cached pg_stat_activity query can differ from current blocker, then refresh snapshot', async () => {
 const {f,a,usersA}=await replyFixture(); let holder,observer,pending,advance;
 const gate=new Promise(resolve=>{advance=resolve;});let ready;
 const reached=new Promise(resolve=>{ready=resolve;});let pid;
 try {
  holder=await f.domainPool.connect();observer=await f.domainPool.connect();
  await holder.query('BEGIN');const blocker=(await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  await holder.query('SELECT user_id FROM couple_members WHERE couple_id=$1 AND user_id=$2 FOR UPDATE',[a,usersA[1]]);
  pending=f.database().transaction(async tx=>{
   pid=(await tx.query('SELECT pg_backend_pid() pid')).rows[0].pid;
   await tx.query('SELECT status,membership_epoch FROM couples WHERE id=$1 FOR UPDATE',[a]);ready();await gate;
   await tx.query('SELECT user_id FROM couple_members WHERE couple_id=$1 ORDER BY user_id FOR SHARE',[a]);
  });pending.catch(()=>{});await reached;
  await observer.query('BEGIN');
  const inspect=()=>observer.query('SELECT query,$2=ANY(pg_blocking_pids(pid)) blocked FROM pg_stat_activity WHERE pid=$1',[pid,blocker]);
  const first=(await inspect()).rows[0];assert.match(first.query,/FROM couples.*FOR UPDATE/s);assert.equal(first.blocked,false);
  advance();let stale;
  for(let n=0;n<150;n++){const row=(await inspect()).rows[0];if(row.blocked){stale=row;break;}await delay(10);}
  assert.ok(stale);assert.match(stale.query,/FROM couples.*FOR UPDATE/s,'cached query still earlier while lock manager reports current member wait');
  await observer.query('SELECT pg_stat_clear_snapshot()');
  const fresh=(await inspect()).rows[0];assert.equal(fresh.blocked,true);assert.match(fresh.query,/FROM couple_members.*FOR SHARE/s);
  await holder.query('COMMIT');holder.release();holder=null;await pending;pending=null;
 } finally {advance();if(holder){await holder.query('ROLLBACK');holder.release();}if(observer){await observer.query('ROLLBACK');observer.release();}if(pending)await pending.catch(()=>{});await f.close();}
});
