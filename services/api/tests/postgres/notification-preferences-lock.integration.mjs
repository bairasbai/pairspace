import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {replyFixture} from './chat-replies-fixture.mjs';
import {saveNotificationPreferences,getNotificationPreferences,previewNotificationPreferences} from '../../src/notification-preferences.ts';
for(const mode of ['expiry','revocation'])for(const operation of ['read','preview','create','edit','retry'])test(`notification_preferences ${operation} denies ${mode} after observed PostgreSQL lock`,async()=>{
 const {f,a,db,principals:p}=await replyFixture();let lock,pending;
 try{
  const scope={coupleId:a,membershipEpoch:1};
  const original={...scope,commandId:randomUUID(),expectedVersion:0,care:true,chat:false,letter:false,quiet:null};
  const created=await saveNotificationPreferences(db,p[0],original);assert.equal(created.ok,true);const partingId=p[0].userId;
  if(mode==='expiry')await f.authPool.query(`UPDATE "session" SET "expiresAt"=clock_timestamp()+interval '2 seconds' WHERE id=$1`,[p[0].sessionId]);
  lock=await f.domainPool.connect();await lock.query('BEGIN');const locker=(await lock.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  // Expiry advances during the target wait; revocation holds the session row before its authorization lock.
  // Once the application owns a session SHARE lock, concurrent revocation must serialize behind it.
  if(mode==='expiry')await lock.query('SELECT id FROM couples WHERE id=$1 FOR UPDATE',[a]);
  else await lock.query('SELECT id FROM "session" WHERE id=$1 FOR UPDATE',[p[0].sessionId]);
  let waiter,privateQueries=0;
  const tracked={...db,transaction:work=>db.transaction(async tx=>{waiter=(await tx.query('SELECT pg_backend_pid() pid')).rows[0].pid;return work({query(sql,args){if(sql.includes('FROM notification_preferences')||sql.includes('INTO notification_preferences')||sql.includes('UPDATE notification_preferences')||sql.includes('notification_preference_commands'))privateQueries++;return tx.query(sql,args);}});})};
  pending=operation==='preview'?previewNotificationPreferences(tracked,p[0],{...scope,category:'care'}):operation==='read'?getNotificationPreferences(tracked,p[0],scope):operation==='retry'?saveNotificationPreferences(tracked,p[0],original):operation==='edit'?saveNotificationPreferences(tracked,p[0],{...original,commandId:randomUUID(),expectedVersion:1,care:false}):saveNotificationPreferences(tracked,p[0],{...original,commandId:randomUUID(),chat:true});
  let observed=false;for(let n=0;n<200;n++){if(waiter){const row=(await f.domainPool.query(`SELECT wait_event_type='Lock' AND $2=ANY(pg_blocking_pids(pid)) blocked FROM pg_stat_activity WHERE pid=$1`,[waiter,locker])).rows[0];if(row?.blocked){observed=true;break;}}await delay(10);}assert.equal(observed,true);
  if(mode==='expiry')await delay(2100);
  else await lock.query('DELETE FROM "session" WHERE id=$1',[p[0].sessionId]);
  await lock.query('COMMIT');assert.deepEqual(await pending,{ok:false,error:'unavailable'});pending=null;
  assert.equal(privateQueries,0,'deny before any period or receipt access');assert.deepEqual((await f.domainPool.query('SELECT care,version FROM notification_preferences WHERE user_id=$1',[partingId])).rows[0],{care:true,version:1});
 }finally{if(lock){await lock.query('ROLLBACK').catch(()=>{});lock.release();}if(pending)await pending.catch(()=>{});await f.close();}
});
test('notification_preferences edit rechecks after observed target row wait before reading title',async()=>{
 const {f,a,db,principals:p}=await replyFixture();let lock,pending;
 try{
  const original={coupleId:a,membershipEpoch:1,commandId:randomUUID(),expectedVersion:0,care:true,chat:false,letter:false,quiet:null};
  const created=await saveNotificationPreferences(db,p[0],original);assert.equal(created.ok,true);const partingId=p[0].userId;
  await f.authPool.query(`UPDATE "session" SET "expiresAt"=clock_timestamp()+interval '2 seconds' WHERE id=$1`,[p[0].sessionId]);
  lock=await f.domainPool.connect();await lock.query('BEGIN');const locker=(await lock.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  await lock.query('SELECT user_id FROM notification_preferences WHERE user_id=$1 FOR UPDATE',[partingId]);let waiter,privateReads=0;
  const tracked={...db,transaction:work=>db.transaction(async tx=>{waiter=(await tx.query('SELECT pg_backend_pid() pid')).rows[0].pid;return work({query(sql,args){if(sql.startsWith('SELECT couple_id,user_id'))privateReads++;return tx.query(sql,args);}});})};
  pending=saveNotificationPreferences(tracked,p[0],{...original,commandId:randomUUID(),expectedVersion:1,care:false});
  let observed=false;for(let n=0;n<200;n++){if(waiter){const r=(await f.domainPool.query(`SELECT wait_event_type='Lock' AND $2=ANY(pg_blocking_pids(pid)) blocked FROM pg_stat_activity WHERE pid=$1`,[waiter,locker])).rows[0];if(r?.blocked){observed=true;break;}}await delay(10);}assert.equal(observed,true);
  await delay(2100);await lock.query('COMMIT');assert.deepEqual(await pending,{ok:false,error:'unavailable'});pending=null;assert.equal(privateReads,0);
 }finally{if(lock){await lock.query('ROLLBACK').catch(()=>{});lock.release();}if(pending)await pending.catch(()=>{});await f.close();}
});
