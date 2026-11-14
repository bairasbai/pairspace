import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { replyFixture } from './chat-replies-fixture.mjs';
import { sendMessage } from '../../src/chat.ts';
import { sendChatReply } from '../../src/chat-replies.ts';
for(const mode of ['plain','reply'])test(`chat ${mode} rolls back source/sequence/outbox/context when authority expires during capture recipient lock`,async()=>{
 const {f,a,db,principals:p,usersA}=await replyFixture();let holder,pending;
 try{
  await f.domainPool.query('UPDATE couples SET next_chat_seq=1000 WHERE id=$1',[a]);
  const before=(await f.domainPool.query('SELECT next_chat_seq FROM couples WHERE id=$1',[a])).rows[0].next_chat_seq;
  const parent=(await f.domainPool.query('SELECT id FROM chat_messages WHERE couple_id=$1 ORDER BY seq LIMIT 1',[a])).rows[0].id;
  await f.domainPool.query('UPDATE "session" SET "expiresAt"=clock_timestamp()+interval \'3 seconds\' WHERE id=$1',[p[0].sessionId]);
  holder=await f.domainPool.connect();await holder.query('BEGIN');
  const holderPid=(await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  await holder.query('SELECT user_id FROM couple_members WHERE couple_id=$1 AND user_id=$2 FOR UPDATE',[a,usersA[1]]);
  let pid,captureRequested=false;
  const blocked={...db,transaction:work=>db.transaction(async tx=>{
   pid=(await tx.query('SELECT pg_backend_pid() pid')).rows[0].pid;
   return work({query(sql,args){if(sql.includes('INSERT INTO outbox_events'))captureRequested=true;return tx.query(sql,args);}});
  })};
  const clientId=randomUUID();const command={coupleId:a,membershipEpoch:1,clientId,body:'Synthetic'};
  pending=mode==='plain'?sendMessage(blocked,p[0],command):sendChatReply(blocked,p[0],{...command,replyToId:parent});
  pending.catch(()=>{}); // Attach rejection handler immediately while observing the lock.
  let observed=false;
  for(let n=0;n<200;n++){
   if(pid&&captureRequested){const r=(await f.domainPool.query('SELECT $2=ANY(pg_blocking_pids(pid)) blocked FROM pg_stat_activity WHERE pid=$1',[pid,holderPid])).rows[0];if(r?.blocked){observed=true;break;}}
   await delay(10);
  }
  assert.ok(observed,'actual recipient lock wait during outbox capture');
  for(let n=0;n<400;n++){
   const expired=(await f.domainPool.query('SELECT "expiresAt"<=clock_timestamp() expired FROM "session" WHERE id=$1',[p[0].sessionId])).rows[0].expired;
   if(expired)break;
   assert.notEqual(n,399,'expiry observed');await delay(10);
  }
  await holder.query('COMMIT');holder.release();holder=null;
  const result=await pending;pending=null;assert.deepEqual(result,{ok:false,error:'unavailable'});
  assert.equal((await f.domainPool.query('SELECT next_chat_seq FROM couples WHERE id=$1',[a])).rows[0].next_chat_seq,before);
  assert.equal((await f.domainPool.query('SELECT id FROM chat_messages WHERE client_message_id=$1',[clientId])).rowCount,0);
  assert.equal((await f.domainPool.query('SELECT event_id FROM chat_notification_context')).rowCount,0);
  assert.equal((await f.domainPool.query("SELECT id FROM outbox_events WHERE type='chat.message_created'")).rowCount,0);
 }finally{if(holder){await holder.query('ROLLBACK');holder.release();}if(pending)await pending.catch(()=>{});await f.close();}
});
