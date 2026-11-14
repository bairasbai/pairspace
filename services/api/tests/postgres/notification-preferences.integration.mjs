import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { leavePair } from '../../src/pair-leave.ts';
import { replyFixture } from './chat-replies-fixture.mjs';
import { getNotificationPreferences as get, saveNotificationPreferences as save, previewNotificationPreferences as preview } from '../../src/notification-preferences.ts';
test('private notification rules singleton CAS/replay, aliases, rollback and leave denial',async()=>{
 const {f,a,b,db,principals:p}=await replyFixture();
 try{
  const scope={coupleId:a,membershipEpoch:1},c={...scope,commandId:randomUUID(),expectedVersion:0,care:true,chat:false,letter:false,quiet:{start:'01:00',end:'02:00',timezone:'US/Eastern'}};
  const cmds=[c,{...c,commandId:randomUUID(),care:false}];
  const result=await Promise.all(cmds.map(cmd=>save(db,p[0],cmd)));assert.equal(result.filter(r=>r.ok).length,1);assert.equal(result.find(r=>!r.ok).error,'version_conflict');
  const win=result[0].ok?0:1;
  const edits=await Promise.all([save(db,p[0],{...c,commandId:randomUUID(),expectedVersion:1,chat:true}),save(db,p[0],{...c,commandId:randomUUID(),expectedVersion:1,letter:true})]);
  assert.equal(edits.filter(r=>r.ok).length,1);assert.equal(edits.find(r=>!r.ok).error,'version_conflict');
  const canonical=(await get(db,p[0],scope)).value.preferences;assert.equal(canonical.version,2);assert.equal(canonical.quiet.timezone,'US/Eastern');
  assert.deepEqual((await save(db,p[0],cmds[win])).value.preferences,canonical);
  const partner=(await get(db,p[1],scope)).value.preferences;assert.equal(partner.version,0);assert.equal(partner.care,false);assert.equal(partner.quiet,null);
  assert.equal((await preview(db,p[1],{...scope,category:'care'})).value.reason,'disabled');
  for(const who of [p[2],{...p[0],userId:p[2].userId}])assert.equal((await get(db,who,scope)).error,'unavailable');
  assert.equal((await get(db,p[0],{...scope,coupleId:b})).error,'unavailable');
  const broken={...db,transaction:work=>db.transaction(tx=>work({query(sql,args){if(sql.startsWith('INSERT INTO notification_preference_commands'))throw Error('receipt failure');return tx.query(sql,args);}}))};
  await assert.rejects(save(broken,p[0],{...c,commandId:randomUUID(),expectedVersion:2,care:false,quiet:null}));assert.deepEqual((await get(db,p[0],scope)).value.preferences,canonical);
  await assert.rejects(f.domainPool.query('UPDATE notification_preferences SET user_id=$1,version=version+1 WHERE user_id=$2',[p[1].userId,p[0].userId]));
  await assert.rejects(f.domainPool.query('DELETE FROM notification_preferences'));
  assert.equal((await leavePair(db,p[0],{...scope,commandId:randomUUID(),confirm:true})).ok,true);
  assert.equal((await preview(db,p[0],{...scope,category:'care'})).error,'unavailable');assert.equal((await save(db,p[0],cmds[win])).error,'unavailable');
 }finally{await f.close();}
});
