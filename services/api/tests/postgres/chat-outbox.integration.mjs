import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { replyFixture } from './chat-replies-fixture.mjs';
import { sendMessage } from '../../src/chat.ts';
import { simulateChatOutbox as run } from '../../src/chat-outbox.ts';
import { saveNotificationPreferences as save } from '../../src/notification-preferences.ts';
import { setChatVisibility } from '../../src/chat-visibility.ts';
import { deleteChatMessage } from '../../src/chat-deletion.ts';
import { leavePair } from '../../src/pair-leave.ts';
test('chat event has single atomic context, private simulation dedupe, current privacy and historical replay',async()=>{
 const {f,a,db,principals:p}=await replyFixture();const scope={coupleId:a,membershipEpoch:1};
 try{
  await f.domainPool.query('UPDATE couples SET next_chat_seq=1000 WHERE id=$1',[a]);
  const cmd={...scope,clientId:randomUUID(),body:'Synthetic'};
  const sends=await Promise.all(Array.from({length:4},()=>sendMessage(db,p[0],cmd)));
  assert.equal(sends.filter(r=>r.ok&&!r.value.replay).length,1);
  const mid=sends[0].value.message.id;
  const e=(await f.domainPool.query('SELECT id FROM outbox_events WHERE message_id=$1',[mid])).rows[0].id;
  assert.equal((await f.domainPool.query('SELECT event_id FROM chat_notification_context WHERE event_id=$1',[e])).rowCount,1);
  assert.equal((await save(db,p[1],{...scope,commandId:randomUUID(),expectedVersion:0,care:false,chat:true,letter:false,quiet:null})).ok,true);
  const results=await Promise.all(Array.from({length:6},()=>run(db,e)));
  assert.equal(results.filter(r=>r.ok&&!r.value.replay).length,1);assert.ok(results.every(r=>r.value.reason==='allowed'));
  assert.equal((await f.domainPool.query('SELECT processed_at FROM outbox_events WHERE id=$1',[e])).rows[0].processed_at,null);
  const send=async()=>{const r=await sendMessage(db,p[0],{...cmd,clientId:randomUUID()});return {mid:r.value.message.id,e:(await f.domainPool.query('SELECT id FROM outbox_events WHERE message_id=$1',[r.value.message.id])).rows[0].id};};
  const hidden=await send();assert.equal((await setChatVisibility(db,p[1],{...scope,messageId:hidden.mid,commandId:randomUUID(),expectedVersion:0,hidden:true})).ok,true);
  assert.equal((await run(db,hidden.e)).value.reason,'hidden');
  const deleted=await send();assert.equal((await deleteChatMessage(db,p[0],{...scope,messageId:deleted.mid,commandId:randomUUID(),expectedVersion:1,scope:'everyone'})).ok,true);
  assert.equal((await run(db,deleted.e)).value.reason,'deleted');
  const last=await send();assert.equal((await leavePair(db,p[0],{...scope,commandId:randomUUID(),confirm:true})).ok,true);
  assert.equal((await run(db,last.e)).value.reason,'unavailable');assert.equal((await run(db,e)).value.reason,'allowed');
  await assert.rejects(f.domainPool.query('DELETE FROM chat_notification_context'));
  await assert.rejects(f.domainPool.query('UPDATE chat_notification_simulations SET evaluated_at=now()'));
 }finally{await f.close();}
});
