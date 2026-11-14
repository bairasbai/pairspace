import assert from 'node:assert/strict';
import test from 'node:test';
import { closeMobile } from './mobile-invitations-fixture.mjs';
import { morningsFixture, morningAccount } from './mobile-mornings-fixture.mjs';
const tables=['chat_messages','care_signals','morning_slots','morning_content','morning_drafts','morning_openings','partings','arrival_plans'];
async function snapshot(f){const value={};for(const t of tables)value[t]=(await f.domainPool.query(`SELECT row_to_json(t)::text value FROM ${t} t ORDER BY row_to_json(t)::text`)).rows;return value;}
test('private future notification rules real HTTP, lost ACK, newer draft and no event/delivery effects',async()=>{
 const {f,pairA}=await morningsFixture({enableSyntheticNotificationPreferences:true});const accounts=[],commands=[];let lose=true;
 try{
  const before=await snapshot(f);
  const a=await morningAccount(f,0,{beforeRequest:async(r,input)=>{if(r.path.endsWith('/notification-preferences')&&r.method==='PUT')commands.push(await input.clone().json());},afterResponse:async(r,response)=>{if(r.path.endsWith('/notification-preferences')&&r.method==='PUT'&&response.status===200&&lose){lose=false;throw Error('Synthetic lost ACK');}}});accounts.push(a);
  const same=await morningAccount(f,0);accounts.push(same);const partner=await morningAccount(f,1);accounts.push(partner);
  const c=a.controller.notificationPreferences,other=same.controller.notificationPreferences,peer=partner.controller.notificationPreferences;
  await c.load();assert.equal(c.getSnapshot().preferences.version,0);assert.equal(c.getSnapshot().preferences.care,false);
  c.beginEdit();c.setCategory('care',true);await c.save();assert.equal(c.getSnapshot().status,'retry');c.setCategory('letter',true);
  await other.load();other.beginEdit();other.setCategory('chat',true);await other.save();assert.equal(other.getSnapshot().preferences.version,2);
  await c.retry();assert.deepEqual(commands[0],commands[1]);assert.equal(c.getSnapshot().preferences.version,2);assert.equal(c.getSnapshot().fields.letter,true);assert.equal(c.getSnapshot().preferences.letter,false);
  await peer.load();assert.equal(peer.getSnapshot().preferences.version,0);assert.equal(peer.getSnapshot().preferences.chat,false);
  await c.preview('care');assert.equal(c.getSnapshot().policyPreview.simulationOnly,true);assert.equal(c.getSnapshot().policyPreview.reason,'allowed');
  await peer.preview('care');assert.equal(peer.getSnapshot().policyPreview.reason,'disabled');
  c.beginEdit();await c.save();assert.equal(c.getSnapshot().preferences.version,2,'no-op stable');
  c.beginEdit();c.setCategory('care',false);await c.save();assert.equal(c.getSnapshot().preferences.version,3);await c.preview('care');assert.equal(c.getSnapshot().policyPreview.reason,'disabled');
  assert.deepEqual(await snapshot(f),before,'settings/simulation never mutate communication resources');
  const paths=[`/notification-preferences?membership_epoch=1&user_id=${peer.getSnapshot().preferences.userId}`, '/notification-preferences/preview?membership_epoch=1&category=care&body=secret'];
  for(const path of paths){const r=await fetch(`${f.baseURL}/v1/couples/${pairA}${path}`,{headers:{cookie:await a.connection.getCookie(),origin:f.baseURL}});assert.equal(r.status,400);}
  await a.controller.signOut();assert.equal(c.getSnapshot().available,false);assert.equal(c.getSnapshot().preferences,null);assert.equal(c.getSnapshot().policyPreview,null);
 }finally{await closeMobile(f,accounts);}
});
