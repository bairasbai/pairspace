import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {replyFixture} from './chat-replies-fixture.mjs';
import {createParting,editParting,listPartings} from '../../src/partings.ts';

test('partings real concurrent overlap/CAS, current replay, SQL identity and rollback',async()=>{
 const {f,a,db,principals:p}=await replyFixture();
 try{
  const base={coupleId:a,membershipEpoch:1,title:'Synthetic period',startDate:'2028-01-01',endDate:'2028-01-02',timezone:'UTC'};
  const c={...base,commandId:randomUUID()};
  const results=await Promise.all([createParting(db,p[0],c),createParting(db,p[1],{...c,commandId:randomUUID()})]);
  assert.equal(results.filter(x=>x.ok).length,1);assert.equal(results.find(x=>!x.ok).error,'overlap');
  const win=results[0].ok?0:1, row=results[win].value.parting;
  const edit={...base,partingId:row.id,expectedVersion:1,commandId:randomUUID(),title:'Edited once'};
  const edits=await Promise.all([editParting(db,p[0],edit),editParting(db,p[1],{...edit,commandId:randomUUID(),title:'Other edit'})]);
  assert.equal(edits.filter(x=>x.ok).length,1);assert.equal(edits.find(x=>!x.ok).error,'version_conflict');
  assert.equal((await listPartings(db,p[0],{coupleId:a,membershipEpoch:1})).value.partings[0].version,2);
  if(win===0)assert.equal((await createParting(db,p[0],c)).value.parting.version,2);
  const overlap={...base,startDate:'2028-01-03',endDate:'2028-01-03',timezone:'Pacific/Kiritimati',commandId:randomUUID()};
  assert.equal((await createParting(db,p[0],overlap)).error,'overlap'); // different calendar labels but real intervals overlap
  await assert.rejects(f.domainPool.query('UPDATE partings SET creator_id=$1,version=version+1 WHERE id=$2',[p[1-win].userId,row.id]));
  await assert.rejects(f.domainPool.query('DELETE FROM partings WHERE id=$1',[row.id]));
  await assert.rejects(f.domainPool.query(`INSERT INTO partings(couple_id,creator_id,membership_epoch,title,start_date,end_date,timezone,starts_at,ends_at,created_at) SELECT couple_id,creator_id,membership_epoch,title,start_date,end_date,timezone,starts_at,ends_at,created_at FROM partings WHERE id=$1`,[row.id]));
  const broken={...db,transaction:work=>db.transaction(tx=>work({query(sql,args){if(sql.startsWith('INSERT INTO parting_commands'))throw Error('receipt failure');return tx.query(sql,args);}}))};
  await assert.rejects(createParting(broken,p[0],{...base,startDate:'2029-01-01',endDate:'2029-01-02',commandId:randomUUID()}));
  assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM partings')).rows[0].n,1);
 }finally{await f.close();}
});
