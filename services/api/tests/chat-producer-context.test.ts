import {readFile} from 'node:fs/promises';
import {expect,it} from 'vitest';
import {adapter,c1,c2,createFixture,id,principal,u1,u2,u3} from './fixtures.ts';
import {sendMessage} from '../src/chat.ts';
import {sendChatReply} from '../src/chat-replies.ts';
const migrate=async(pg:Awaited<ReturnType<typeof createFixture>>,name:string)=>pg.exec(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8'));
const scope={coupleId:c1,membershipEpoch:1};
it('captures original plain and reply events atomically, without historical backfill or duplicate replay',async()=>{
 const pg=await createFixture();try{
  const db=adapter(pg),old={...scope,clientId:id(9101),body:'Synthetic original'};
  const first=await sendMessage(db,principal,old);if(!first.ok)throw Error('fixture');
  await migrate(pg,'020_chat_replies.sql');await migrate(pg,'034_chat_notification_simulations.sql');
  expect((await pg.query('SELECT * FROM chat_notification_context')).rows).toHaveLength(0);
  expect((await sendMessage(db,principal,old)).ok).toBe(true);
  expect((await pg.query('SELECT * FROM chat_notification_context')).rows).toHaveLength(0);
  const plain={...scope,clientId:id(9102),body:'Synthetic new'};
  const reply={...scope,clientId:id(9103),body:'Synthetic reply',replyToId:first.value.message.id};
  expect((await sendMessage(db,principal,plain)).ok).toBe(true);
  expect((await sendChatReply(db,principal,reply)).ok).toBe(true);
  expect((await sendMessage(db,principal,plain)).ok).toBe(true);
  expect((await sendChatReply(db,principal,reply)).ok).toBe(true);
  const contexts=(await pg.query('SELECT couple_id,sender_id,recipient_id,membership_epoch FROM chat_notification_context')).rows;
  expect(contexts).toEqual([0,1].map(()=>({couple_id:c1,sender_id:u1,recipient_id:u2,membership_epoch:1})));
  expect((await pg.query('SELECT id FROM outbox_events')).rows).toHaveLength(3);
  expect((await pg.query('SELECT id FROM chat_notification_simulations')).rows).toHaveLength(0);
  await pg.exec(`CREATE FUNCTION synthetic_capture_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic_capture_failure'; END $$;
    CREATE TRIGGER fail_context BEFORE INSERT ON chat_notification_context FOR EACH ROW EXECUTE FUNCTION synthetic_capture_failure();`);
  await expect(sendMessage(db,principal,{...plain,clientId:id(9104)})).rejects.toThrow('synthetic_capture_failure');
  await expect(sendChatReply(db,principal,{...reply,clientId:id(9105)})).rejects.toThrow('synthetic_capture_failure');
  expect((await pg.query('SELECT id FROM chat_messages')).rows).toHaveLength(3);
  expect((await pg.query('SELECT id FROM outbox_events')).rows).toHaveLength(3);
 }finally{await pg.close();}
});
it('guards context/source immutability and simulation scope/shape; shared processed_at remains independent',async()=>{
 const pg=await createFixture();try{
  await migrate(pg,'034_chat_notification_simulations.sql');
  expect((await sendMessage(adapter(pg),principal,{...scope,clientId:id(9201),body:'Synthetic'})).ok).toBe(true);
  const context=(await pg.query<{event_id:string;message_id:string}>('SELECT * FROM chat_notification_context')).rows[0];
  for(const sql of ['UPDATE chat_notification_context SET membership_epoch=2','DELETE FROM chat_notification_context',
   "UPDATE outbox_events SET type='couple.closed',message_id=NULL",'DELETE FROM outbox_events'])await expect(pg.exec(sql)).rejects.toThrow();
  await expect(pg.query(`INSERT INTO chat_notification_context(event_id,couple_id,message_id,sender_id,recipient_id,membership_epoch)
   VALUES($1,$2,$3,$4,$5,1)`,[id(9202),c1,context.message_id,u1,u2])).rejects.toThrow('chat_context_capture_only');
  const insert=(couple:string,recipient:string,epoch:number,state:string,reason:string,pref:number|null,version:number|null)=>pg.query(`INSERT INTO chat_notification_simulations
   (event_id,couple_id,recipient_id,membership_epoch,state,reason,evaluated_at,preference_version,message_version)
   VALUES($1,$2,$3,$4,$5,$6,'2026-11-10',$7,$8)`,[context.event_id,couple,recipient,epoch,state,reason,pref,version]);
  for(const args of [[c2,u3,1,'simulation_blocked','unavailable',null,null],
   [c1,u1,1,'simulation_blocked','unavailable',null,null],[c1,u2,2,'simulation_blocked','unavailable',null,null],
   [c1,u2,1,'simulation_eligible','disabled',0,1],[c1,u2,1,'simulation_blocked','unavailable',0,null],
   [c1,u2,1,'simulation_blocked','hidden',0,1],[c1,u2,1,'simulation_blocked','deleted',null,null],
   [c1,u2,1,'simulation_eligible','allowed',null,1],[c1,u2,1,'simulation_eligible','allowed',0,0]] as const)
   await expect(insert(args[0],args[1],args[2],args[3],args[4],args[5],args[6])).rejects.toThrow();
  await insert(c1,u2,1,'simulation_eligible','allowed',0,1);
  await expect(insert(c1,u2,1,'simulation_eligible','allowed',0,1)).rejects.toThrow();
  await expect(pg.exec('UPDATE chat_notification_simulations SET preference_version=1')).rejects.toThrow('chat_simulation_immutable');
  await expect(pg.exec('DELETE FROM chat_notification_simulations')).rejects.toThrow('chat_simulation_immutable');
  expect((await pg.query('SELECT processed_at FROM outbox_events')).rows).toEqual([{processed_at:null}]);
  await pg.exec("UPDATE outbox_events SET processed_at='2026-11-11'");
  expect((await pg.query('SELECT id FROM chat_notification_simulations')).rows).toHaveLength(1);
 }finally{await pg.close();}
});
for(const kind of ['plain','reply'] as const)it(`${kind} final session denial rolls back sequence/source/outbox/context, unrelated exceptions propagate`,async()=>{
 const pg=await createFixture();try{
  await migrate(pg,'020_chat_replies.sql');await migrate(pg,'034_chat_notification_simulations.sql');
  const db=adapter(pg),parent=await sendMessage(db,principal,{...scope,clientId:id(9300),body:'Synthetic parent'});
  if(!parent.ok)throw Error('fixture');
  const snapshot=async()=>({seq:(await pg.query('SELECT next_chat_seq FROM couples WHERE id=$1',[c1])).rows,
   messages:(await pg.query('SELECT id FROM chat_messages ORDER BY id')).rows,
   events:(await pg.query('SELECT id FROM outbox_events ORDER BY id')).rows,
   contexts:(await pg.query('SELECT event_id FROM chat_notification_context ORDER BY event_id')).rows});
  const before=await snapshot();
  const run=(source:typeof db)=>kind==='plain'?sendMessage(source,principal,{...scope,clientId:id(9301),body:'Synthetic new'}):
   sendChatReply(source,principal,{...scope,clientId:id(9301),body:'Synthetic reply',replyToId:parent.value.message.id});
  for(const mode of ['deny','throw'] as const){
   let checks=0;
   // Same message as internal sentinel must NOT be mistaken for its object identity.
   const external=new Error('chat_session_expired_after_capture');
   const guarded={...db,sessionAuthority:{...db.sessionAuthority,recheck:async(...args:Parameters<typeof db.sessionAuthority.recheck>)=>{
    checks++;
    if(checks===3){if(mode==='throw')throw external;return false;}
    return db.sessionAuthority.recheck(...args);
   }}};
   if(mode==='deny')expect(await run(guarded)).toEqual({ok:false,error:'unavailable'});
   else await expect(run(guarded)).rejects.toBe(external);
   expect(checks).toBe(3);expect(await snapshot()).toEqual(before);
  }
  expect((await run(db)).ok).toBe(true);
  expect((await pg.query('SELECT event_id FROM chat_notification_context')).rows).toHaveLength(2);
 }finally{await pg.close();}
});
