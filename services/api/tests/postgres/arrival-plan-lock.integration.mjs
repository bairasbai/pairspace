import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {replyFixture} from './chat-replies-fixture.mjs';
import {saveArrivalPlan,getArrivalPlan} from '../../src/arrival-plan.ts';
for(const mode of ['expiry','revocation'])for(const operation of ['read','create','edit','retry'])test(`arrival_plans ${operation} denies ${mode} after observed PostgreSQL lock`,async()=>{
 const {f,a,db,principals:p}=await replyFixture();let lock,pending;
 try{
  const scope={coupleId:a,membershipEpoch:1};
  const original={...scope,commandId:randomUUID(),expectedVersion:0,label:'Synthetic locked',localDate:'2031-01-01',localTime:'12:00',timezone:'UTC',offset:'+00:00'};
  const created=await saveArrivalPlan(db,p[0],original);assert.equal(created.ok,true);const partingId=created.value.plan.id;
  if(mode==='expiry')await f.authPool.query(`UPDATE "session" SET "expiresAt"=clock_timestamp()+interval '2 seconds' WHERE id=$1`,[p[0].sessionId]);
  lock=await f.domainPool.connect();await lock.query('BEGIN');const locker=(await lock.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  // Expiry advances during the target wait; revocation holds the session row before its authorization lock.
  // Once the application owns a session SHARE lock, concurrent revocation must serialize behind it.
  if(mode==='expiry')await lock.query('SELECT id FROM couples WHERE id=$1 FOR UPDATE',[a]);
  else await lock.query('SELECT id FROM "session" WHERE id=$1 FOR UPDATE',[p[0].sessionId]);
  let waiter,privateQueries=0;
  const tracked={...db,transaction:work=>db.transaction(async tx=>{waiter=(await tx.query('SELECT pg_backend_pid() pid')).rows[0].pid;return work({query(sql,args){if(sql.includes('FROM arrival_plans')||sql.includes('INTO arrival_plans')||sql.includes('UPDATE arrival_plans')||sql.includes('arrival_plan_commands'))privateQueries++;return tx.query(sql,args);}});})};
  pending=operation==='read'?getArrivalPlan(tracked,p[0],scope):operation==='retry'?saveArrivalPlan(tracked,p[0],original):operation==='edit'?saveArrivalPlan(tracked,p[0],{...original,commandId:randomUUID(),expectedVersion:1,label:'Must not apply'}):saveArrivalPlan(tracked,p[0],{...original,commandId:randomUUID(),localDate:'2032-01-01'});
  let observed=false;for(let n=0;n<200;n++){if(waiter){const row=(await f.domainPool.query(`SELECT wait_event_type='Lock' AND $2=ANY(pg_blocking_pids(pid)) blocked FROM pg_stat_activity WHERE pid=$1`,[waiter,locker])).rows[0];if(row?.blocked){observed=true;break;}}await delay(10);}assert.equal(observed,true);
  if(mode==='expiry')await delay(2100);
  else await lock.query('DELETE FROM "session" WHERE id=$1',[p[0].sessionId]);
  await lock.query('COMMIT');assert.deepEqual(await pending,{ok:false,error:'unavailable'});pending=null;
  assert.equal(privateQueries,0,'deny before any period or receipt access');assert.deepEqual((await f.domainPool.query('SELECT label,version FROM arrival_plans WHERE id=$1',[partingId])).rows[0],{label:'Synthetic locked',version:1});
 }finally{if(lock){await lock.query('ROLLBACK').catch(()=>{});lock.release();}if(pending)await pending.catch(()=>{});await f.close();}
});
test('arrival_plans edit rechecks after observed target row wait before reading title',async()=>{
 const {f,a,db,principals:p}=await replyFixture();let lock,pending;
 try{
  const original={coupleId:a,membershipEpoch:1,commandId:randomUUID(),expectedVersion:0,label:'Private target',localDate:'2033-01-01',localTime:'12:00',timezone:'UTC',offset:'+00:00'};
  const created=await saveArrivalPlan(db,p[0],original);assert.equal(created.ok,true);const partingId=created.value.plan.id;
  await f.authPool.query(`UPDATE "session" SET "expiresAt"=clock_timestamp()+interval '2 seconds' WHERE id=$1`,[p[0].sessionId]);
  lock=await f.domainPool.connect();await lock.query('BEGIN');const locker=(await lock.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  await lock.query('SELECT id FROM arrival_plans WHERE id=$1 FOR UPDATE',[partingId]);let waiter,privateReads=0;
  const tracked={...db,transaction:work=>db.transaction(async tx=>{waiter=(await tx.query('SELECT pg_backend_pid() pid')).rows[0].pid;return work({query(sql,args){if(sql.startsWith('SELECT id,couple_id,creator_id'))privateReads++;return tx.query(sql,args);}});})};
  pending=saveArrivalPlan(tracked,p[0],{...original,commandId:randomUUID(),expectedVersion:1,label:'Not applied'});
  let observed=false;for(let n=0;n<200;n++){if(waiter){const r=(await f.domainPool.query(`SELECT wait_event_type='Lock' AND $2=ANY(pg_blocking_pids(pid)) blocked FROM pg_stat_activity WHERE pid=$1`,[waiter,locker])).rows[0];if(r?.blocked){observed=true;break;}}await delay(10);}assert.equal(observed,true);
  await delay(2100);await lock.query('COMMIT');assert.deepEqual(await pending,{ok:false,error:'unavailable'});pending=null;assert.equal(privateReads,0);
 }finally{if(lock){await lock.query('ROLLBACK').catch(()=>{});lock.release();}if(pending)await pending.catch(()=>{});await f.close();}
});
