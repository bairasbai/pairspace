import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { replyFixture } from './chat-replies-fixture.mjs';
import { saveArrivalPlan, getArrivalPlan } from '../../src/arrival-plan.ts';
test('arrival singleton concurrency/CAS, canonical retries, SQL identity and atomic receipts',async()=>{
 const {f,a,b,db,principals:p}=await replyFixture();
 try {
  const c={coupleId:a,membershipEpoch:1,commandId:randomUUID(),expectedVersion:0,label:'',localDate:'2028-11-05',localTime:'01:30',timezone:'America/New_York',offset:'-04:00'};
  assert.equal((await getArrivalPlan(db,p[0],{coupleId:a,membershipEpoch:1})).value.plan,null);
  const cmds=[c,{...c,commandId:randomUUID()}];
  const results=await Promise.all(cmds.map((cmd,i)=>saveArrivalPlan(db,p[i],cmd)));
  assert.equal(results.filter(x=>x.ok).length,1);assert.equal(results.find(x=>!x.ok).error,'version_conflict');
  const win=results[0].ok?0:1,row=results[win].value.plan;
  const edit={...c,expectedVersion:1,commandId:randomUUID(),label:'Changed plan',offset:'-05:00'};
  const edits=await Promise.all([saveArrivalPlan(db,p[0],edit),saveArrivalPlan(db,p[1],{...edit,commandId:randomUUID(),label:'Other plan'})]);
  assert.equal(edits.filter(x=>x.ok).length,1);assert.equal(edits.find(x=>!x.ok).error,'version_conflict');
  const canonical=(await getArrivalPlan(db,p[0],{coupleId:a,membershipEpoch:1})).value.plan;
  assert.equal(canonical.version,2);assert.equal(canonical.id,row.id);assert.equal(canonical.arrivesAt,'2028-11-05T06:30:00.000Z');
  assert.deepEqual((await saveArrivalPlan(db,p[win],cmds[win])).value.plan,canonical);
  assert.equal((await getArrivalPlan(db,p[2],{coupleId:a,membershipEpoch:1})).error,'unavailable');
  assert.equal((await getArrivalPlan(db,p[0],{coupleId:b,membershipEpoch:1})).error,'unavailable');
  await assert.rejects(f.domainPool.query('UPDATE arrival_plans SET creator_id=$1,version=version+1 WHERE id=$2',[p[1-win].userId,row.id]));
  await assert.rejects(f.domainPool.query('DELETE FROM arrival_plans WHERE id=$1',[row.id]));
  await assert.rejects(f.domainPool.query("UPDATE arrival_plans SET arrives_at=arrives_at+interval '1 hour',version=version+1 WHERE id=$1",[row.id]));
  const broken={...db,transaction:work=>db.transaction(tx=>work({query(sql,args){if(sql.startsWith('INSERT INTO arrival_plan_commands'))throw Error('receipt failure');return tx.query(sql,args);}}))};
  await assert.rejects(saveArrivalPlan(broken,p[0],{...edit,expectedVersion:2,commandId:randomUUID(),label:'Must rollback'}));
  assert.deepEqual((await getArrivalPlan(db,p[0],{coupleId:a,membershipEpoch:1})).value.plan,canonical);
 } finally { await f.close(); }
});
