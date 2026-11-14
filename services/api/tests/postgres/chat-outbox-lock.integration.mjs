import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {replyFixture} from './chat-replies-fixture.mjs';
import {sendMessage} from '../../src/chat.ts';
import {simulateChatOutbox} from '../../src/chat-outbox.ts';
import {saveNotificationPreferences} from '../../src/notification-preferences.ts';
import {deleteChatMessage} from '../../src/chat-deletion.ts';
import {setChatVisibility} from '../../src/chat-visibility.ts';
function trackedDatabase(db,{hold=false}={}) {
 let release,entered;const gate=new Promise(r=>{release=r;}),ready=new Promise(r=>{entered=r;});
 const state={pid:null,preferenceReads:0};
 const tracked={...db,transaction:work=>db.transaction(async tx=>{
  state.pid=(await tx.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  return work({async query(sql,args){
   if(sql.includes('FROM notification_preferences'))state.preferenceReads++;
   const result=await tx.query(sql,args);
   if(hold&&sql.includes('FROM couples')&&sql.includes('FOR UPDATE')){entered();await gate;}
   return result;
  }});
 })};
 return {db:tracked,state,ready,release};
}
async function observedWait(pool,waiter,blocker) {
 for(let n=0;n<200;n++){
  if(waiter.pid&&blocker.pid){const row=(await pool.query("SELECT wait_event_type='Lock' AND $2=ANY(pg_blocking_pids(pid)) blocked FROM pg_stat_activity WHERE pid=$1",[waiter.pid,blocker.pid])).rows[0];if(row?.blocked)return;}
  await delay(10);
 }
 assert.fail('expected PostgreSQL pair-lock wait was not observed');
}
for(const action of ['delete','hide'])for(const first of ['mutation','simulation'])test(`chat simulation serializes ${action}, ${first} obtains pair lock first`,async()=>{
 const {f,a,db,principals:p}=await replyFixture();let holder,firstWork,secondWork;
 try{
  const scope={coupleId:a,membershipEpoch:1};
  const pref={...scope,commandId:randomUUID(),expectedVersion:0,care:false,chat:true,letter:false,quiet:null};
  assert.equal((await saveNotificationPreferences(db,p[1],pref)).ok,true);
  const message=await sendMessage(db,p[0],{...scope,clientId:randomUUID(),body:'Synthetic'});assert.equal(message.ok,true);
  const messageId=message.value.message.id;
  const event=(await f.domainPool.query('SELECT id FROM outbox_events WHERE message_id=$1',[messageId])).rows[0].id;
  const mutate=source=>action==='delete'?deleteChatMessage(source,p[0],{...scope,messageId,commandId:randomUUID(),expectedVersion:1,scope:'everyone'}):setChatVisibility(source,p[1],{...scope,messageId,commandId:randomUUID(),expectedVersion:0,hidden:true});
  holder=trackedDatabase(db,{hold:true});const waiter=trackedDatabase(db);
  firstWork=first==='mutation'?mutate(holder.db):simulateChatOutbox(holder.db,event);
  await holder.ready;
  secondWork=first==='mutation'?simulateChatOutbox(waiter.db,event):mutate(waiter.db);
  await observedWait(f.domainPool,waiter.state,holder.state);
  if(first==='mutation')assert.equal(waiter.state.preferenceReads,0,'worker must not read prefs before obtaining pair lock');
  holder.release();const firstResult=await firstWork;firstWork=null;const secondResult=await secondWork;secondWork=null;
  assert.equal(firstResult.ok,true);assert.equal(secondResult.ok,true);
  const simulation=first==='simulation'?firstResult:secondResult;
  assert.equal(simulation.value.reason,first==='simulation'?'allowed':action==='delete'?'deleted':'hidden');
  assert.equal(simulation.value.preferenceVersion,first==='simulation'?1:null);
  assert.equal(simulation.value.messageVersion,first==='mutation'&&action==='delete'?2:1);
  if(first==='mutation')assert.equal(waiter.state.preferenceReads,0,'deleted/hidden denied before recipient preference read');
  const replay=await simulateChatOutbox(db,event);assert.equal(replay.value.id,simulation.value.id);assert.equal(replay.value.reason,simulation.value.reason);assert.equal(replay.value.replay,true);
  const rows=await f.domainPool.query('SELECT id FROM chat_notification_simulations WHERE event_id=$1',[event]);assert.equal(rows.rowCount,1);
  assert.equal((await f.domainPool.query('SELECT processed_at FROM outbox_events WHERE id=$1',[event])).rows[0].processed_at,null);
 }finally{holder?.release();if(firstWork)await firstWork.catch(()=>{});if(secondWork)await secondWork.catch(()=>{});await f.close();}
});
