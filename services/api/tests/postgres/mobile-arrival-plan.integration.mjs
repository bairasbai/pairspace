import assert from 'node:assert/strict';
import test from 'node:test';
import { closeMobile } from './mobile-invitations-fixture.mjs';
import { morningsFixture, morningAccount, morningRequest, morningValue, morningCommand, setMorningPreference, futureDate } from './mobile-mornings-fixture.mjs';
const tables=['morning_preferences','morning_slots','morning_content','morning_command_receipts','morning_openings','morning_discussion_messages','morning_discussion_receipts','morning_prepared_receipts','morning_drafts','morning_draft_receipts','morning_draft_delete_receipts','partings','parting_commands'];
async function snapshot(f){const result={};for(const table of tables)result[table]=(await f.domainPool.query(`SELECT row_to_json(t)::text value FROM ${table} t ORDER BY row_to_json(t)::text`)).rows;return result;}
function form(c,label,date='2028-11-05',time='01:30',zone='America/New_York',offset='-04:00'){for(const [k,v]of Object.entries({label,localDate:date,localTime:time,timezone:zone,offset}))c.setField(k,v);}
test('arrival real HTTP lost ACK/current retry, empty label, equal actors and resource isolation',async()=>{
 const {f,pairA,connections}=await morningsFixture({enableSyntheticArrivalPlan:true,enableSyntheticPartings:true});
 const accounts=[],commands=[];let lose=true;
 try{
  await setMorningPreference(f,connections[1],pairA);
  const slot=morningValue(await morningRequest(f,connections[0],pairA,'/slots',{method:'POST',body:morningCommand({preference_version:1,local_date:futureDate(),offset:'+00:00'})})).slot;
  morningValue(await morningRequest(f,connections[0],pairA,`/slots/${slot.id}/draft-v2`,{method:'PUT',body:morningCommand({expected_version:0,body:'Synthetic private draft'})}));
  morningValue(await morningRequest(f,connections[0],pairA,`/slots/${slot.id}/body`,{method:'PUT',body:morningCommand({body:'Synthetic sealed letter'})}));
  const a=await morningAccount(f,0,{beforeRequest:async(r,input)=>{if(r.path.endsWith('/arrival-plan')&&r.method==='PUT')commands.push(await input.clone().json());},afterResponse:async(r,response)=>{if(r.path.endsWith('/arrival-plan')&&r.method==='PUT'&&response.status===200&&lose){lose=false;throw Error('Synthetic lost ACK');}}});accounts.push(a);
  const b=await morningAccount(f,1);accounts.push(b);
  const periods=a.controller.partings;periods.setDraft('Synthetic separation');periods.setStartDate('2028-11-01');periods.setEndDate('2028-11-09');periods.setTimezone('UTC');await periods.create();assert.equal(periods.getSnapshot().status,'saved');
  const before=await snapshot(f),c=a.controller.arrival,other=b.controller.arrival;
  await c.load();assert.equal(c.getSnapshot().plan,null);c.beginEdit();form(c,'');await c.save();assert.equal(c.getSnapshot().status,'retry');
  c.setField('label','New unsaved input');await other.load();other.beginEdit();form(other,'Partner update','2028-11-05','01:30','America/New_York','-05:00');await other.save();assert.equal(other.getSnapshot().plan.version,2);
  await c.retry();assert.deepEqual(commands[1],commands[0]);assert.equal(c.getSnapshot().status,'saved');assert.equal(c.getSnapshot().fields.label,'New unsaved input');assert.equal(c.getSnapshot().plan.label,'Partner update');assert.equal(c.getSnapshot().plan.version,2);
  c.beginEdit();form(c,'Earlier plan','2000-01-01','00:00','UTC','+00:00');await c.save();assert.equal(c.getSnapshot().plan.version,3);
  c.beginEdit();await c.save();assert.equal(c.getSnapshot().plan.version,3);
  assert.deepEqual(await snapshot(f),before,'arrival never changes period or morning resources');
  const sealed=morningValue(await morningRequest(f,connections[1],pairA,`/slots/${slot.id}`));assert.equal(sealed.slot.state,'sealed');assert.deepEqual(Object.keys(sealed).sort(),['readId','serverNow','slot']);
  const denied=await fetch(`${f.baseURL}/v1/couples/${pairA}/arrival-plan?membership_epoch=1`,{headers:{cookie:await connections[2].getCookie(),origin:f.baseURL}});assert.equal(denied.status,403);
  await a.controller.signOut();assert.equal(c.getSnapshot().available,false);assert.equal(c.getSnapshot().plan,null);assert.equal(c.getSnapshot().fields.label,'');
 }finally{await closeMobile(f,accounts);}
});
