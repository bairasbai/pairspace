import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {replyFixture} from './chat-replies-fixture.mjs';
import {createParting,editParting,listPartings} from '../../src/partings.ts';
for(const mode of ['expiry','revocation'])for(const operation of ['read','create','edit','retry'])test(`partings ${operation} denies ${mode} after observed PostgreSQL lock`,async()=>{
 const {f,a,db,principals:p}=await replyFixture();let lock,pending;
 try{
  const scope={coupleId:a,membershipEpoch:1};
  const original={...scope,commandId:randomUUID(),title:'Synthetic locked',startDate:'2031-01-01',endDate:'2031-01-02',timezone:'UTC'};
  const created=await createParting(db,p[0],original);assert.equal(created.ok,true);const partingId=created.value.parting.id;
  if(mode==='expiry')await f.authPool.query(`UPDATE "session" SET "expiresAt"=clock_timestamp()+interval '2 seconds' WHERE id=$1`,[p[0].sessionId]);
  lock=await f.domainPool.connect();await lock.query('BEGIN');const locker=(await lock.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  // Expiry advances during the target wait; revocation holds the session row before its authorization lock.
  // Once the application owns a session SHARE lock, concurrent revocation must serialize behind it.
  if(mode==='expiry')await lock.query('SELECT id FROM couples WHERE id=$1 FOR UPDATE',[a]);
  else await lock.query('SELECT id FROM "session" WHERE id=$1 FOR UPDATE',[p[0].sessionId]);
  let waiter,privateQueries=0;
  const tracked={...db,transaction:work=>db.transaction(async tx=>{waiter=(await tx.query('SELECT pg_backend_pid() pid')).rows[0].pid;return work({query(sql,args){if(sql.includes('FROM partings')||sql.includes('INTO partings')||sql.includes('UPDATE partings')||sql.includes('parting_commands'))privateQueries++;return tx.query(sql,args);}});})};
  pending=operation==='read'?listPartings(tracked,p[0],scope):operation==='retry'?createParting(tracked,p[0],original):operation==='edit'?editParting(tracked,p[0],{...original,commandId:randomUUID(),partingId,expectedVersion:1,title:'Must not apply'}):createParting(tracked,p[0],{...original,commandId:randomUUID(),startDate:'2032-01-01',endDate:'2032-01-02'});
  let observed=false;for(let n=0;n<200;n++){if(waiter){const row=(await f.domainPool.query(`SELECT wait_event_type='Lock' AND $2=ANY(pg_blocking_pids(pid)) blocked FROM pg_stat_activity WHERE pid=$1`,[waiter,locker])).rows[0];if(row?.blocked){observed=true;break;}}await delay(10);}assert.equal(observed,true);
  if(mode==='expiry')await delay(2100);
  else await lock.query('DELETE FROM "session" WHERE id=$1',[p[0].sessionId]);
  await lock.query('COMMIT');assert.deepEqual(await pending,{ok:false,error:'unavailable'});pending=null;
  assert.equal(privateQueries,0,'deny before any period or receipt access');assert.deepEqual((await f.domainPool.query('SELECT title,version FROM partings WHERE id=$1',[partingId])).rows[0],{title:'Synthetic locked',version:1});
 }finally{if(lock){await lock.query('ROLLBACK').catch(()=>{});lock.release();}if(pending)await pending.catch(()=>{});await f.close();}
});
test('partings edit rechecks after observed target row wait before reading title',async()=>{
 const {f,a,db,principals:p}=await replyFixture();let lock,pending;
 try{
  const original={coupleId:a,membershipEpoch:1,commandId:randomUUID(),title:'Private target',startDate:'2033-01-01',endDate:'2033-01-02',timezone:'UTC'};
  const created=await createParting(db,p[0],original);assert.equal(created.ok,true);const partingId=created.value.parting.id;
  await f.authPool.query(`UPDATE "session" SET "expiresAt"=clock_timestamp()+interval '2 seconds' WHERE id=$1`,[p[0].sessionId]);
  lock=await f.domainPool.connect();await lock.query('BEGIN');const locker=(await lock.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  await lock.query('SELECT id FROM partings WHERE id=$1 FOR UPDATE',[partingId]);let waiter,privateReads=0;
  const tracked={...db,transaction:work=>db.transaction(async tx=>{waiter=(await tx.query('SELECT pg_backend_pid() pid')).rows[0].pid;return work({query(sql,args){if(sql.startsWith('SELECT id,couple_id,creator_id'))privateReads++;return tx.query(sql,args);}});})};
  pending=editParting(tracked,p[0],{...original,commandId:randomUUID(),partingId,expectedVersion:1,title:'Not applied'});
  let observed=false;for(let n=0;n<200;n++){if(waiter){const r=(await f.domainPool.query(`SELECT wait_event_type='Lock' AND $2=ANY(pg_blocking_pids(pid)) blocked FROM pg_stat_activity WHERE pid=$1`,[waiter,locker])).rows[0];if(r?.blocked){observed=true;break;}}await delay(10);}assert.equal(observed,true);
  await delay(2100);await lock.query('COMMIT');assert.deepEqual(await pending,{ok:false,error:'unavailable'});pending=null;assert.equal(privateReads,0);
 }finally{if(lock){await lock.query('ROLLBACK').catch(()=>{});lock.release();}if(pending)await pending.catch(()=>{});await f.close();}
});
