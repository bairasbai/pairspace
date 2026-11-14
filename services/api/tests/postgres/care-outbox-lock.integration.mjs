import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {replyFixture} from './chat-replies-fixture.mjs';
import {sendCareSignal} from '../../src/care-signals.ts';
import {simulateCareOutbox} from '../../src/care-outbox.ts';
import {saveNotificationPreferences} from '../../src/notification-preferences.ts';
import {leavePair} from '../../src/pair-leave.ts';
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
for(const action of ['preference','leave'])for(const first of ['mutation','simulation'])test(`care simulation serializes ${action}, ${first} obtains pair lock first`,async()=>{
 const {f,a,db,principals:p}=await replyFixture();let holder,firstWork,secondWork;
 try{
  const scope={coupleId:a,membershipEpoch:1};
  const pref={...scope,commandId:randomUUID(),expectedVersion:0,care:true,chat:false,letter:false,quiet:null};
  assert.equal((await saveNotificationPreferences(db,p[1],pref)).ok,true);
  const signal=await sendCareSignal(db,p[0],{...scope,clientId:randomUUID()});assert.equal(signal.ok,true);
  const event=(await f.domainPool.query('SELECT id FROM outbox_events WHERE care_signal_id=$1',[signal.value.signal.id])).rows[0].id;
  const mutate=source=>action==='preference'?saveNotificationPreferences(source,p[1],{...pref,commandId:randomUUID(),expectedVersion:1,care:false}):leavePair(source,p[0],{...scope,commandId:randomUUID(),confirm:true});
  holder=trackedDatabase(db,{hold:true});const waiter=trackedDatabase(db);
  firstWork=first==='mutation'?mutate(holder.db):simulateCareOutbox(holder.db,event);
  await holder.ready;
  secondWork=first==='mutation'?simulateCareOutbox(waiter.db,event):mutate(waiter.db);
  await observedWait(f.domainPool,waiter.state,holder.state);
  if(first==='mutation')assert.equal(waiter.state.preferenceReads,0,'worker must not read prefs before obtaining pair lock');
  holder.release();const firstResult=await firstWork;firstWork=null;const secondResult=await secondWork;secondWork=null;
  assert.equal(firstResult.ok,true);assert.equal(secondResult.ok,true);
  const simulation=first==='simulation'?firstResult:secondResult;
  assert.equal(simulation.value.reason,first==='simulation'?'allowed':action==='preference'?'disabled':'unavailable');
  assert.equal(simulation.value.preferenceVersion,first==='simulation'?1:action==='preference'?2:null);
  if(first==='mutation'&&action==='leave')assert.equal(waiter.state.preferenceReads,0,'closed pair denied before recipient preference read');
  const replay=await simulateCareOutbox(db,event);assert.equal(replay.value.id,simulation.value.id);assert.equal(replay.value.reason,simulation.value.reason);assert.equal(replay.value.replay,true);
  const rows=await f.domainPool.query('SELECT id FROM care_notification_simulations WHERE event_id=$1',[event]);assert.equal(rows.rowCount,1);
 }finally{holder?.release();if(firstWork)await firstWork.catch(()=>{});if(secondWork)await secondWork.catch(()=>{});await f.close();}
});
