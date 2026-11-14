import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {replyFixture} from './chat-replies-fixture.mjs';
import {commandMorning} from '../../src/morning-commands.ts';
import {draftMorning} from '../../src/morning-draft.ts';
import {draftMorningV2} from '../../src/morning-draft-v2.ts';
import {readMorning} from '../../src/morning-read.ts';
test('private draft delete real PostgreSQL CAS race, rollback, replay canonical and terminal SQL',async()=>{
 const {f,a,db,principals:p}=await replyFixture();
 try {
  const scope={coupleId:a,membershipEpoch:1};
  assert.equal((await commandMorning(db,p[1],{...scope,commandId:randomUUID(),expectedVersion:0,timezone:'UTC',localTime:'09:00'},'preference')).ok,true);
  const scheduled=await commandMorning(db,p[0],{...scope,commandId:randomUUID(),preferenceVersion:1,localDate:new Date(Date.now()+5*86400000).toISOString().slice(0,10),offset:'+00:00'},'schedule');
  assert.equal(scheduled.ok,true);const slotId=scheduled.value.slot.id,read={...scope,slotId,readId:randomUUID()};
  const create={...scope,slotId,commandId:randomUUID(),expectedVersion:0,body:'Private initial'};
  assert.equal((await draftMorning(db,p[0],create,true)).ok,true);
  const recipient=(await readMorning(db,p[1],read)).value.slot;
  const remove={...scope,slotId,commandId:randomUUID(),expectedVersion:1,confirm:true};
  const bad={...db,transaction:work=>db.transaction(tx=>work({query(sql,args){if(sql.includes('INSERT INTO morning_draft_delete_receipts'))throw Error('receipt rollback');return tx.query(sql,args);}}))};
  await assert.rejects(draftMorningV2(bad,p[0],remove,'delete'),/receipt rollback/);
  assert.equal((await draftMorning(db,p[0],read,false)).value.version,1);
  const edit={...create,commandId:randomUUID(),expectedVersion:1,body:'Contending private edit'};
  const race=await Promise.all([draftMorningV2(db,p[0],edit,'save'),draftMorningV2(db,p[0],remove,'delete')]);
  assert.equal(race.filter(r=>r.ok).length,1);
  assert.ok(['draft_deleted','version_conflict'].includes(race.find(r=>!r.ok).error));
  let tombstone=(await draftMorningV2(db,p[0],read,'read')).value;
  let deletion=remove;
  if(tombstone.state!=='deleted') {
   deletion={...remove,commandId:randomUUID(),expectedVersion:tombstone.version};
   assert.equal((await draftMorningV2(db,p[0],deletion,'delete')).ok,true);
   tombstone=(await draftMorningV2(db,p[0],read,'read')).value;
  }
  assert.equal(tombstone.state,'deleted');assert.equal(tombstone.body,null);
  assert.equal((await draftMorningV2(db,p[0],create,'save')).value.state,'deleted');
  assert.equal((await draftMorningV2(db,p[0],deletion,'delete')).value.replay,true);
  assert.deepEqual(await draftMorning(db,p[0],create,true),{ok:false,error:'draft_deleted'});
  for(const actor of [p[1],p[2]]) assert.equal((await draftMorningV2(db,actor,read,'read')).error,'unavailable');
  assert.deepEqual((await readMorning(db,p[1],read)).value.slot,recipient);
  await assert.rejects(f.domainPool.query("UPDATE morning_drafts SET state='live',body='Revival',version=version+1 WHERE slot_id=$1",[slotId]),/immutable_morning_draft_identity/);
  await assert.rejects(f.domainPool.query('DELETE FROM morning_drafts WHERE slot_id=$1',[slotId]),/immutable_morning_draft_identity/);
  assert.equal((await f.domainPool.query('SELECT body FROM morning_drafts WHERE slot_id=$1',[slotId])).rows[0].body,null);
 }finally{await f.close();}
});
