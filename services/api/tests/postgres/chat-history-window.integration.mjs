import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createFixture } from './fixture.mjs';
import { readChatWindow } from '../../src/chat-history-window.ts';
import { closeCouple } from '../../src/chat.ts';
import { observeTask, withDeadline } from './async-bounds.mjs';
const origin='http://localhost:3123';
async function setup(){
 const f=await createFixture();
 try{
  const accounts=[];
  for(let i=0;i<4;i++){
   const response=await f.call('sign-up/email',{name:'Synthetic',email:`window-${i}@example.test`,password:'Synthetic-window-password-42!'});
   assert.equal(response.status,200);accounts.push({...await response.json(),cookie:response.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ')});
  }
  const a=randomUUID(),b=randomUUID(),usersA=await f.provision(accounts.slice(0,2).map(x=>x.user.id),a),usersB=await f.provision(accounts.slice(2).map(x=>x.user.id),b),db=f.database();
  const principals=await Promise.all(accounts.map(x=>db.sessionAuthority.authenticate(new Request(origin,{headers:{origin,cookie:x.cookie}}))));
  for(const [pair,user] of [[a,usersA[0]],[b,usersB[0]]])await f.domainPool.query(`INSERT INTO chat_messages(couple_id,sender_id,client_message_id,seq,body,created_at) SELECT $1,$2,gen_random_uuid(),n*3,'Synthetic '||n,'2026-01-01' FROM generate_series(1,251)n`,[pair,user]);
  return {f,a,b,db,principals,usersA};
 }catch(error){await f.close();throw error;}
}
const input=(coupleId,direction='latest',cursor)=>({coupleId,membershipEpoch:1,readId:randomUUID(),direction,...(cursor?{anchorId:cursor.id,anchorSeq:cursor.seq}:{})});
test('native bounded windows visit 251 messages, gaps/timestamp ties, foreign same-seq anchors and new insertion',async()=>{
 const {f,a,b,db,principals:p,usersA}=await setup();
 try{
  let page=await readChatWindow(db,p[0],input(a,'oldest'));const all=[];
  while(page.ok){assert.ok(page.value.messages.length<=50);all.push(...page.value.messages);if(!page.value.newerCursor)break;page=await readChatWindow(db,p[1],input(a,'after',page.value.newerCursor));}
  assert.deepEqual(all.map(m=>m.seq),Array.from({length:251},(_,i)=>(i+1)*3));
  const latest=await readChatWindow(db,p[0],input(a));assert.equal(latest.ok,true);assert.deepEqual(latest.value.messages,all.slice(-50));
  const older=await readChatWindow(db,p[0],input(a,'before',latest.value.olderCursor));assert.equal(older.ok,true);assert.deepEqual(older.value.messages,all.slice(-100,-50));
  const foreign=(await f.domainPool.query('SELECT id,seq::int seq FROM chat_messages WHERE couple_id=$1 AND seq=3',[b])).rows[0];
  for(const cursor of [foreign,{id:randomUUID(),seq:3},{id:all[0].id,seq:6}])assert.deepEqual(await readChatWindow(db,p[0],input(a,'after',cursor)),{ok:false,error:'invalid_cursor'});
  assert.deepEqual(await readChatWindow(db,p[2],input(a)),{ok:false,error:'unavailable'});
  assert.deepEqual(await readChatWindow(db,p[0],{...input(a),membershipEpoch:2}),{ok:false,error:'stale_membership'});
  await f.domainPool.query("INSERT INTO chat_messages(couple_id,sender_id,client_message_id,seq,body)VALUES($1,$2,$3,900,'New synthetic')",[a,usersA[0],randomUUID()]);
  const next=await readChatWindow(db,p[0],input(a,'after',{id:all.at(-1).id,seq:753}));assert.equal(next.ok,true);assert.deepEqual(next.value.messages.map(m=>m.seq),[900]);
  assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM outbox_events')).rows[0].n,0,'read-only windows create no events');
  assert.equal((await closeCouple(db,p[0],a,1)).ok,true);assert.deepEqual(await readChatWindow(db,p[1],input(a)),{ok:false,error:'unavailable'});
 }finally{await f.close();}
});
test('session expiry is rechecked after proven PostgreSQL pair-lock wait',async()=>{
 const {f,a,db,principals:p}=await setup();const held=await f.domainPool.connect();let task;
 try{
  await f.authPool.query('UPDATE "session" SET "expiresAt"=clock_timestamp()+interval \'2 seconds\' WHERE id=$1',[p[0].sessionId]);
  await held.query('BEGIN');await held.query('SELECT id FROM couples WHERE id=$1 FOR UPDATE',[a]);const blocker=(await held.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  let reader;const tracked={...db,transaction:work=>db.transaction(async tx=>{reader=(await tx.query('SELECT pg_backend_pid() pid')).rows[0].pid;return work(tx);})};
  task=observeTask(readChatWindow(tracked,p[0],input(a)));
  await withDeadline((async()=>{for(;;){if(reader){const r=await f.admin.query("SELECT wait_event_type,pg_blocking_pids(pid) blockers FROM pg_stat_activity WHERE pid=$1",[reader]);if(r.rows[0]?.wait_event_type==='Lock'&&r.rows[0].blockers.includes(blocker))return;}await new Promise(r=>setTimeout(r,10));}})(),1500,'actual pair lock wait');
  await new Promise(r=>setTimeout(r,2100));await held.query('COMMIT');assert.deepEqual(await task,{ok:false,error:'unavailable'});
 }finally{await held.query('ROLLBACK');held.release();if(task)await withDeadline(task,5000,'cleanup');await f.close();}
});
