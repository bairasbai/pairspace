import {Pool} from 'pg';
import {leavePair} from '../../src/pair-leave.ts';
import assert from 'node:assert/strict';
import {password} from './profile-fixture.mjs';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {simulateMorningSlot as simulate} from '../../src/morning-notifications.ts';

function traced(db) {
 const state={pid:null,sql:[]};
 return {state,db:{...db,now:()=>{throw Error('application clock must not be used');},transaction:work=>db.transaction(async tx=>{
  state.pid=(await tx.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  return work({query(sql,args){state.sql.push(sql);assert.doesNotMatch(sql,/\b(body|morning_drafts|morning_openings)\b/i);return tx.query(sql,args);}});
 })}};
}
async function addSlot(x,pair,sender,recipient,release,{version=1,alternate=false}={}) {
 const iso=new Date(release).toISOString(),hours=new Date(release).getUTCHours()>=10?14:-12;
 const local=new Date(release+(alternate?hours*3600000:0)).toISOString();
 const zone=alternate?(hours===14?'Etc/GMT-14':'Etc/GMT+12'):'UTC',offset=alternate?(hours===14?'+14:00':'-12:00'):'+00:00';
 if(version===1)await x.f.domainPool.query(`INSERT INTO morning_preferences(couple_id,membership_epoch,user_id,timezone,local_time,version) VALUES($1,1,$2,$3,$4,1)`,[pair,recipient,zone,local.slice(11,16)]);
 else await x.f.domainPool.query('UPDATE morning_preferences SET timezone=$3,local_time=$4,version=$5 WHERE couple_id=$1 AND user_id=$2',[pair,recipient,zone,local.slice(11,16),version]);
 const id=randomUUID();
 await x.f.domainPool.query(`INSERT INTO morning_slots(id,couple_id,membership_epoch,sender_id,recipient_id,local_date,local_time,timezone,utc_offset,release_at,preference_version,created_at)
 VALUES($1,$2,1,$3,$4,$5,$6,$7,$8,$9,$10,date_trunc('milliseconds',clock_timestamp()))`,[id,pair,sender,recipient,local.slice(0,10),local.slice(11,16),zone,offset,iso,version]);
 return id;
}
async function fill(x,id){await x.f.domainPool.query("INSERT INTO morning_content(slot_id,body,filled_at) VALUES($1,'Synthetic notification boundary',clock_timestamp())",[id]);}
async function preference(x,pair,user,quiet,release){
 const start=new Date(release).toISOString().slice(11,16),end=new Date(release+3600000).toISOString().slice(11,16);
 await x.f.domainPool.query(`INSERT INTO notification_preferences(couple_id,user_id,membership_epoch,version,letter,quiet_start,quiet_end,timezone)
 VALUES($1,$2,1,1,true,$3,$4,$5)`,[pair,user,quiet?start:null,quiet?end:null,quiet?'UTC':null]);
}
export async function setupMorningNotificationLive(x,release){
 const {f,pairB,usersB}=x,db=f.database();
 const pairC=randomUUID(),usersC=[randomUUID(),randomUUID()];
 const tx=await f.domainPool.connect();
 try {await tx.query('BEGIN');for(const user of usersC)await tx.query('INSERT INTO users(id) VALUES($1)',[user]);
  await tx.query("INSERT INTO couples(id,status) VALUES($1,'waiting_partner')",[pairC]);
  for(let i=0;i<2;i++)await tx.query("INSERT INTO couple_members(couple_id,user_id,slot,status) VALUES($1,$2,$3,'active')",[pairC,usersC[i],i+1]);
  await tx.query("UPDATE couples SET status='active' WHERE id=$1",[pairC]);await tx.query('COMMIT');
 }catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}
 const filled=await addSlot(x,pairB,usersB[0],usersB[1],release);
 const empty=await addSlot(x,pairB,usersB[1],usersB[0],release);
 const pendingLeave=await addSlot(x,pairB,usersB[1],usersB[0],release,{version:2,alternate:true});
 const draft=await addSlot(x,pairB,usersB[0],usersB[1],release,{version:2,alternate:true});
 await fill(x,filled);
 await f.domainPool.query("INSERT INTO morning_drafts(slot_id,actor_id,body,version) VALUES($1,$2,'Synthetic private draft',1)",[draft,usersB[0]]);
 const slotWait=await addSlot(x,pairC,usersC[0],usersC[1],release);await fill(x,slotWait);
 const allowed=await addSlot(x,pairC,usersC[1],usersC[0],release);await fill(x,allowed);
 await preference(x,pairB,usersB[1],true,release);await preference(x,pairC,usersC[1],true,release);await preference(x,pairC,usersC[0],false,release);
 const traces=[];
 for(const id of [filled,empty,draft]){
  const t=traced(db);const result=await simulate(t.db,id);
  assert.deepEqual(result,{ok:true,value:{state:'not_due',simulationOnly:true}});
  for(const sql of t.state.sql)assert.doesNotMatch(sql,/morning_content|notification_preferences|morning_notification_simulations/);
  traces.push(t.state.sql);
 }
 assert.deepEqual(traces[0],traces[1]);assert.deepEqual(traces[1],traces[2]);
 assert.deepEqual(await simulate({...db,now:()=>new Date('2100-01-01')},filled),{ok:true,value:{state:'not_due',simulationOnly:true}});
 assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM morning_notification_simulations')).rows[0].n,0);
 return {filled,empty,draft,slotWait,allowed,pendingLeave,pairC,usersC,outcomes:null};
}
async function holdAcrossBoundary(x,release,data,kind){
 // Independent bounded connections: never starve the existing prepared-boundary pool.
 // pg marks password non-enumerable, so preserve it explicitly without logging options.
 const options=x.f.domainPool.options;
 const pool=new Pool({...options,password:options.password,max:2,application_name:'ps-morning-notification-'+kind});
 const db={now:()=>new Date(),transaction:async work=>{
  const connection=await pool.connect();let begun=false;
  try{await connection.query('BEGIN');begun=true;const result=await work({query:(sql,args)=>connection.query(sql,args)});
   await connection.query('COMMIT');begun=false;return result;
  }finally{try{if(begun)await connection.query('ROLLBACK');}finally{connection.release();}}
 }};
 let holder,pending;const trace=traced(db);
 try{
  holder=await pool.connect();
  await holder.query('BEGIN');const blocker=(await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  if(kind==='slot')await holder.query('SELECT id FROM morning_slots WHERE id=$1 FOR UPDATE',[data.slotWait]);
  else await holder.query('SELECT user_id FROM couple_members WHERE couple_id=$1 AND user_id=$2 FOR UPDATE',[x.pairB,x.usersB[1]]);
  assert.ok(Date.now()<release,'notification holder starts before actual release');
  pending=simulate(trace.db,kind==='slot'?data.slotWait:data.filled);
  let blocked=false;
  for(let i=0;i<100;i++){
   if(trace.state.pid){
    // pg_stat_activity snapshots are transaction-cached; blocking PIDs are live.
    // Refresh before pairing the exact waiter query with its current blocker.
    await holder.query('SELECT pg_stat_clear_snapshot()');
    const row=(await holder.query("SELECT wait_event_type='Lock' AND $2=ANY(pg_blocking_pids(pid)) blocked,query FROM pg_stat_activity WHERE pid=$1",[trace.state.pid,blocker])).rows[0];
    if(row?.blocked){assert.match(row.query,kind==='slot'?/FROM morning_slots.*FOR UPDATE/s:/FROM couple_members.*FOR SHARE/s);blocked=true;break;}}
   await delay(5);
  }
  assert.ok(blocked,'actual precise notification lock waiter observed before release');
  assert.ok(Date.now()<release);assert.equal(trace.state.sql.some(sql=>sql.includes('clock_timestamp')),false,'worker clock is after final contended lock');
  await delay(Math.max(0,release-Date.now()+40));await holder.query('COMMIT');
  const result=await pending;pending=null;
  assert.equal(result.ok,true);assert.equal(result.value.reason,'quiet_hours');assert.equal(result.value.preferenceVersion,1);
  assert.ok(Date.parse(result.value.asOf)>=release);assert.equal(trace.state.sql.filter(sql=>sql.includes('clock_timestamp')).length,1);
  return result;
 }finally{try{if(holder){try{await holder.query('ROLLBACK');}finally{holder.release();}}if(pending)await pending.catch(()=>{});}finally{await pool.end();}}
}
export async function exerciseMorningNotificationBoundary(x,release,data){
 const results=await Promise.allSettled(['slot','member'].map(kind=>holdAcrossBoundary(x,release,data,kind)));
 // Both holders/workers finish cleanup before a failed assertion propagates.
 for(const result of results)if(result.status==='rejected')throw result.reason;
 data.outcomes=results.map(result=>result.value);
}
export function registerMorningNotificationLive(context){
 test('morning notification real release: observed slot/member waits cross quiet start; drafts remain missed and no opening occurs',async()=>{
  const {x,release,data,slot}=context();assert.ok(data.outcomes);assert.ok(Date.now()>=release);
  const db=x.f.database(),openings=(await x.f.domainPool.query('SELECT * FROM morning_openings ORDER BY slot_id')).rows;
  const outbox=(await x.f.domainPool.query('SELECT * FROM outbox_events ORDER BY id')).rows;
  for(const id of [data.empty,data.draft]){const t=traced(db);const result=await simulate(t.db,id);assert.equal(result.value.reason,'missed');assert.equal(result.value.preferenceVersion,null);assert.equal(t.state.sql.some(sql=>sql.includes('FROM notification_preferences')),false);}
  const defaults=await simulate(traced(db).db,slot.id);assert.equal(defaults.value.reason,'disabled');assert.equal(defaults.value.preferenceVersion,0);
  const broken={...db,transaction:work=>db.transaction(tx=>work({query(sql,args){if(sql.includes('INSERT INTO morning_notification_simulations'))throw Error('synthetic_observation_failure');return tx.query(sql,args);}}))};
  await assert.rejects(simulate(broken,data.allowed),/synthetic_observation_failure/);
  assert.equal((await x.f.domainPool.query('SELECT id FROM morning_notification_simulations WHERE slot_id=$1',[data.allowed])).rowCount,0);
  const results=await Promise.all(Array.from({length:4},()=>simulate(traced(db).db,data.allowed)));
  assert.equal(results.filter(r=>!r.value.replay).length,1);assert.ok(results.every(r=>r.value.reason==='allowed'));
  for(const old of data.outcomes){const result=await simulate(traced(db).db,old.value.slotId);assert.equal(result.value.replay,true);assert.equal(result.value.id,old.value.id);assert.equal(result.value.asOf,old.value.asOf);}
  assert.deepEqual((await x.f.domainPool.query('SELECT * FROM morning_openings ORDER BY slot_id')).rows,openings);
  assert.deepEqual((await x.f.domainPool.query('SELECT * FROM outbox_events ORDER BY id')).rows,outbox);
 });
 test('morning notification actual pair leave invalidates pending epoch but preserves historical observation',async()=>{
  const {x,data}=context(),db=x.f.database();
  // Earlier connected scenarios deliberately sign this account out; obtain fresh fixture authority.
  const login=await x.f.call('sign-in/email',{email:'reply-2@example.test',password});
  assert.equal(login.status,200);
  const cookie=login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
  const principal=await db.sessionAuthority.authenticate(new Request('http://localhost:3123/read',{
   headers:{origin:'http://localhost:3123',cookie}
  }));
  assert.ok(principal);assert.equal(principal.userId,x.usersB[0]);
  assert.equal((await leavePair(db,principal,{coupleId:x.pairB,membershipEpoch:1,commandId:randomUUID(),confirm:true})).ok,true);
  assert.deepEqual((await x.f.domainPool.query('SELECT status,membership_epoch FROM couples WHERE id=$1',[x.pairB])).rows,[{status:'closed',membership_epoch:2}]);
  const t=traced(db),result=await simulate(t.db,data.pendingLeave);
  assert.equal(result.value.reason,'unavailable');assert.equal(result.value.preferenceVersion,null);
  for(const sql of t.state.sql)assert.doesNotMatch(sql,/morning_content|notification_preferences/);
  const old=data.outcomes.find(r=>r.value.slotId===data.filled).value;
  const replay=await simulate(traced(db).db,data.filled);
  assert.equal(replay.value.replay,true);assert.equal(replay.value.reason,old.reason);
  assert.equal(replay.value.id,old.id);assert.equal(replay.value.asOf,old.asOf);
 });

}
