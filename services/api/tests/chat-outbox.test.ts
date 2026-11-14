import { readFile } from 'node:fs/promises';
import { afterAll,beforeAll,expect,it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { simulateChatOutbox as run } from '../src/chat-outbox.ts';
import { sendMessage,closeCouple } from '../src/chat.ts';
import { sendChatReply } from '../src/chat-replies.ts';
import { setChatVisibility as hide } from '../src/chat-visibility.ts';
import { deleteChatMessage as remove } from '../src/chat-deletion.ts';
import { editChatMessage as edit } from '../src/chat-editing.ts';
import { saveNotificationPreferences as save } from '../src/notification-preferences.ts';
import { adapter,c1,c2,createFixture,id,identityPrincipal,principal,u2,u3,failOn } from './fixtures.ts';
let pg:PGlite,seq=880; const scope={coupleId:c1,membershipEpoch:1};
const clock=new Date('2090-01-01T12:00:00Z');const db=()=>({...adapter(pg),now:()=>clock});
async function make(pair=c1,who=principal){
 const sent=await sendMessage(db(),who,{coupleId:pair,membershipEpoch:1,clientId:id(seq++),body:'Synthetic'});expect(sent.ok).toBe(true);
 const messageId=sent.ok?sent.value.message.id:'';
 const eventId=(await pg.query<{id:string}>('SELECT id FROM outbox_events WHERE message_id=$1',[messageId])).rows[0].id;
 return {messageId,eventId};
}
async function visibility(messageId:string,hidden:boolean,who=identityPrincipal(u2),expectedVersion=0){
 expect(await hide(db(),who,{...scope,messageId,commandId:id(seq++),expectedVersion,hidden})).toMatchObject({ok:true});
}
beforeAll(async()=>{pg=await createFixture();for(const f of ['012_shared_dates.sql','020_chat_replies.sql','021_chat_deletion_receipts.sql','022_chat_message_edits.sql','023_chat_personal_visibility.sql','032_notification_preferences.sql','034_chat_notification_simulations.sql'])await pg.exec(await readFile(new URL('../migrations/'+f,import.meta.url),'utf8'));});
afterAll(async()=>{await pg.close();});
it('default-disabled historical simulation, private opt-in, replay and unrelated pair isolation',async()=>{
 const first=await make();const result=await run(db(),first.eventId);
 expect(result).toMatchObject({ok:true,value:{reason:'disabled',preferenceVersion:0,messageVersion:1,historicalObservation:true}});
 expect(await save(db(),identityPrincipal(u2),{...scope,commandId:id(seq++),expectedVersion:0,care:false,chat:true,letter:false,quiet:null})).toMatchObject({ok:true});
 expect(await run(db(),first.eventId)).toEqual(result.ok?{ok:true,value:{...result.value,replay:true}}:null);
 expect(await run(db(),(await make()).eventId)).toMatchObject({ok:true,value:{reason:'allowed',preferenceVersion:1}});
 expect(await run(db(),(await make(c2,identityPrincipal(u3))).eventId)).toMatchObject({ok:true,value:{reason:'disabled',coupleId:c2}});
 expect((await pg.query('SELECT id FROM outbox_events WHERE processed_at IS NOT NULL')).rows).toHaveLength(0);
});
it('sender hide does not affect recipient, recipient hide suppresses and restore before processing is respected',async()=>{
 const a=await make();await visibility(a.messageId,true,principal);expect(await run(db(),a.eventId)).toMatchObject({ok:true,value:{reason:'allowed'}});
 const b=await make();await visibility(b.messageId,true);expect(await run(db(),b.eventId)).toMatchObject({ok:true,value:{reason:'hidden',preferenceVersion:null}});
 await visibility(b.messageId,false,identityPrincipal(u2),1);expect(await run(db(),b.eventId)).toMatchObject({ok:true,value:{reason:'hidden',replay:true}});
 const c=await make();await visibility(c.messageId,true);await visibility(c.messageId,false,identityPrincipal(u2),1);
 expect(await run(db(),c.eventId)).toMatchObject({ok:true,value:{reason:'allowed'}});
});
it('global deletion suppresses; reply parent is never used and edits evaluate current metadata',async()=>{
 const parent=await make();const reply=await sendChatReply(db(),principal,{...scope,clientId:id(seq++),body:'Synthetic reply',replyToId:parent.messageId});expect(reply.ok).toBe(true);
 expect(await remove(db(),principal,{...scope,messageId:parent.messageId,scope:'everyone',commandId:id(seq++),expectedVersion:1})).toMatchObject({ok:true});
 expect(await run(db(),parent.eventId)).toMatchObject({ok:true,value:{reason:'deleted',preferenceVersion:null,messageVersion:2}});
 const replyId=reply.ok?reply.value.message.id:'';
 const e=(await pg.query<{id:string}>('SELECT id FROM outbox_events WHERE message_id=$1',[replyId])).rows[0].id;
 expect(await run(db(),e)).toMatchObject({ok:true,value:{reason:'allowed'}});
 const edited=await make();expect(await edit(db(),principal,{...scope,messageId:edited.messageId,commandId:id(seq++),expectedVersion:1,body:'Synthetic edited'})).toMatchObject({ok:true});
 expect(await run(db(),edited.eventId)).toMatchObject({ok:true,value:{reason:'allowed',messageVersion:2}});
});
it('latest quiet policy, future/invalid clock, rollback and missing event fail safely',async()=>{
 expect(await save(db(),identityPrincipal(u2),{...scope,commandId:id(seq++),expectedVersion:1,care:false,chat:true,letter:false,quiet:{start:'11:00',end:'13:00',timezone:'UTC'}})).toMatchObject({ok:true});
 const e=await make();await expect(run({...db(),now:()=>new Date(NaN)},e.eventId)).rejects.toThrow('invalid_server_clock');
 expect(await run({...db(),now:()=>new Date('2000-01-01')},e.eventId)).toMatchObject({ok:true,value:{reason:'unavailable'}});
 const q=await make();expect(await run(db(),q.eventId)).toMatchObject({ok:true,value:{reason:'quiet_hours',preferenceVersion:2}});
 const rollback=await make();await expect(run(failOn(db(),'INSERT INTO chat_notification_simulations'),rollback.eventId)).rejects.toThrow('simulated_failure');
 expect((await pg.query('SELECT id FROM chat_notification_simulations WHERE event_id=$1',[rollback.eventId])).rows).toHaveLength(0);
 expect(await run(db(),rollback.eventId)).toMatchObject({ok:true});
 expect(await run(db(),'bad')).toEqual({ok:false,error:'invalid_request'});expect(await run(db(),id(99000))).toEqual({ok:false,error:'not_found'});
});
it('closed scope suppresses fresh evaluation but cannot reinterpret historical replay',async()=>{
 const old=await make(),pending=await make();const oldResult=await run(db(),old.eventId);
 await closeCouple(db(),principal,c1,1);expect(await run(db(),pending.eventId)).toMatchObject({ok:true,value:{reason:'unavailable',messageVersion:null,preferenceVersion:null}});
 expect(await run(db(),old.eventId)).toEqual(oldResult.ok?{ok:true,value:{...oldResult.value,replay:true}}:null);
});
