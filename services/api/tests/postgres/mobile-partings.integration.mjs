import assert from 'node:assert/strict';
import test from 'node:test';
import { closeMobile } from './mobile-invitations-fixture.mjs';
import { morningsFixture, morningAccount, morningRequest, morningValue, morningCommand, setMorningPreference, futureDate } from './mobile-mornings-fixture.mjs';

const tables = ['morning_preferences','morning_slots','morning_content','morning_command_receipts',
  'morning_openings','morning_discussion_messages','morning_discussion_receipts','morning_prepared_receipts',
  'morning_drafts','morning_draft_receipts','morning_draft_delete_receipts'];
async function snapshot(f) {
  const result = {};
  for (const table of tables) result[table] = (await f.domainPool.query(`SELECT row_to_json(t)::text value FROM ${table} t ORDER BY row_to_json(t)::text`)).rows;
  return result;
}
function form(controller, title, start, end, zone = 'UTC') {
  controller.setDraft(title); controller.setStartDate(start); controller.setEndDate(end); controller.setTimezone(zone);
}

test('partings connected real HTTP lost ACK/current retry, equal actors, no morning mutation', async () => {
  const {f, pairA, connections} = await morningsFixture({enableSyntheticPartings:true});
  const accounts = [], commands = []; let lose = true;
  try {
    await setMorningPreference(f, connections[1], pairA);
    const slot = morningValue(await morningRequest(f, connections[0], pairA, '/slots', {method:'POST',
      body:morningCommand({preference_version:1, local_date:futureDate(), offset:'+00:00'})})).slot;
    morningValue(await morningRequest(f, connections[0], pairA, `/slots/${slot.id}/draft-v2`, {method:'PUT', body:morningCommand({expected_version:0,body:'Synthetic saved private text'})}));
    morningValue(await morningRequest(f, connections[0], pairA, `/slots/${slot.id}/body`, {method:'PUT', body:morningCommand({body:'Synthetic sealed letter'})}));
    const before = await snapshot(f);
    const sealed = morningValue(await morningRequest(f, connections[1], pairA, `/slots/${slot.id}`));
    const a = await morningAccount(f,0,{
      beforeRequest:async(record,input)=>{if(record.path.includes('/partings')&&record.method!=='GET')commands.push(await input.clone().json());},
      afterResponse:async(record,response)=>{if(record.path.endsWith('/partings')&&record.method==='POST'&&response.status===201&&lose){lose=false;throw Error('Synthetic lost committed ACK');}},
    }); accounts.push(a);
    const b = await morningAccount(f,1); accounts.push(b);
    const c=a.controller.partings, other=b.controller.partings;
    await c.list();assert.equal(c.getSnapshot().partings.length,0);
    form(c,'First period','2028-01-01','2028-01-03');await c.create();assert.equal(c.getSnapshot().status,'retry');
    c.setDraft('New unsaved title');
    await other.list();assert.equal(other.getSnapshot().partings.length,1);
    const initial=other.getSnapshot().partings[0];other.beginEdit(initial.id);other.setDraft('Partner edited');await other.create();
    assert.equal(other.getSnapshot().partings[0].version,2);
    await c.retry();assert.deepEqual(commands[1],commands[0]);assert.equal(c.getSnapshot().status,'saved');
    assert.equal(c.getSnapshot().draft,'New unsaved title');assert.equal(c.getSnapshot().partings[0].title,'Partner edited');
    assert.equal(c.getSnapshot().partings[0].id,initial.id);assert.equal(c.getSnapshot().partings[0].version,2);
    c.beginEdit(initial.id);c.setStartDate('2026-01-01');c.setEndDate('2029-01-01');c.setTimezone('America/New_York');await c.create();
    assert.equal(c.getSnapshot().partings[0].version,3);assert.equal(c.getSnapshot().partings[0].id,initial.id);
    c.beginEdit(initial.id);await c.create();assert.equal(c.getSnapshot().partings[0].version,3,'no-op retains version');
    assert.deepEqual(await snapshot(f),before,'period changes never remap/number/release/alter morning resources');
    const afterSealed = morningValue(await morningRequest(f, connections[1], pairA, `/slots/${slot.id}`));
    assert.deepEqual(Object.keys(afterSealed).sort(), ['readId','serverNow','slot']);
    assert.deepEqual(afterSealed.slot,sealed.slot,'sealed recipient resource stays unchanged');
    assert.equal(afterSealed.slot.state,'sealed');
    const denied=await fetch(`${f.baseURL}/v1/couples/${pairA}/partings?membership_epoch=1`,{headers:{cookie:await connections[2].getCookie(),origin:f.baseURL}});
    assert.equal(denied.status,403);
    await a.controller.signOut();assert.equal(c.getSnapshot().available,false);assert.equal(c.getSnapshot().partings.length,0);assert.equal(c.getSnapshot().draft,'');
  } finally {await closeMobile(f,accounts);}
});
