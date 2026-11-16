import { readFile } from 'node:fs/promises';
import { beforeEach, afterEach, it, expect } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import type { AuthorizedDatabase } from '../src/contracts.ts';
import { createCapsule as create, resealCapsule as reseal, removeCapsule as remove, readCapsule as read, listCapsules as list } from '../src/capsules.ts';
import { adapter, createFixture, id, principal, identityPrincipal, u2, outsider, c1, c2, waiting } from './fixtures.ts';
let pg:PGlite, seq=151000;
const scope={coupleId:c1,membershipEpoch:1}, partner=identityPrincipal(u2);
const start='2026-11-10T00:00:00.000Z', due='2026-11-11T06:00:00.000Z';
const clock=(s=start)=>()=>new Date(s);
const schedule={localDate:'2026-11-11',localTime:'09:00',timezone:'Europe/Moscow',offset:'+03:00'}, later={...schedule,localDate:'2026-11-13'};
const db=()=>adapter(pg), command=()=>({...scope,commandId:id(++seq),confirm:true}), creation=()=>({...command(),text:'Synthetic sealed text',schedule});
beforeEach(async()=>{pg=await createFixture();await pg.exec(await readFile(new URL('../migrations/044_capsules.sql',import.meta.url),'utf8'));});
afterEach(async()=>pg.close());
async function make(){const input=creation(),r=await create(db(),principal,input,clock());if(!r.ok)throw Error('fixture');return {input,q:r.value.capsule,action:{...command(),capsuleId:r.value.capsule.id,expectedVersion:1}};}
function distort(base:AuthorizedDatabase,prefix:string,change:(rows:unknown[])=>unknown[]):AuthorizedDatabase{return {...base,transaction:work=>base.transaction(tx=>work({query:async<T>(sql:string,args?:unknown[])=>{const r=await tx.query<T>(sql,args);return sql.startsWith(prefix)?{rows:change(r.rows) as T[]}:r;}}))};}
function observe(base:AuthorizedDatabase,action:(sql:string)=>void):AuthorizedDatabase{return {...base,transaction:work=>base.transaction(tx=>work({query:async<T>(sql:string,args?:unknown[])=>{const r=await tx.query<T>(sql,args);action(sql);return r;}}))};}
const receipt='SELECT fingerprint,capsule_id,operation,applied FROM capsule_commands';
it('owner-only metadata, due-only body, reseal/current replay, removal/terminal capacity',async()=>{
 expect(await list(db(),principal,scope,clock())).toMatchObject({value:{capsules:[],capacity:1,used:0}});
 const {input,q,action}=await make(),detail={...scope,capsuleId:q.id};let bodies=0;const tracked=observe(db(),s=>{if(s.startsWith('SELECT body'))bodies++;});
 expect(await list(tracked,partner,scope,clock())).toMatchObject({value:{capsules:[],used:0}});
 expect(await read(tracked,partner,detail,clock(due))).toEqual({ok:false,error:'unavailable'});
 expect(await read(tracked,principal,detail,clock())).not.toHaveProperty('value.text');expect(bodies).toBe(0);
 expect(await read(tracked,principal,detail,clock(due))).toHaveProperty('value.text',input.text);expect(bodies).toBe(1);
 const change={...action,text:'New synthetic',schedule:later};expect(await reseal(db(),principal,change,clock())).toMatchObject({value:{capsule:{version:2}}});
 expect(await create(db(),principal,input,clock())).toMatchObject({value:{replay:true,capsule:{version:2}}});
 expect(await reseal(db(),principal,change,clock(due))).toMatchObject({value:{replay:true}});
 const deletion={...action,commandId:id(++seq),expectedVersion:2};expect(await remove(db(),principal,deletion,clock())).toMatchObject({value:{capsule:{version:3,contentState:'removed'}}});
 expect(await remove(db(),principal,deletion,clock())).toMatchObject({value:{replay:true}});
 expect(await read(tracked,principal,detail,clock('2026-12-01'))).not.toHaveProperty('value.text');expect(bodies).toBe(1);
 expect(await create(db(),principal,creation(),clock())).toEqual({ok:false,error:'capacity_reached'});
 expect(await create(db(),principal,{...input,text:'different'},clock())).toEqual({ok:false,error:'idempotency_conflict'});
 expect((await pg.query('SELECT body FROM capsules')).rows).toEqual([{body:null}]);
});
it('exact inputs and live principal/membership gates apply to every entry point',async()=>{
 const {input,q,action}=await make();const cases=[[create,input],[list,scope],[read,{...scope,capsuleId:q.id}],[reseal,{...action,text:'New',schedule:later}],[remove,action]] as const;
 for(const [op,request] of cases){
  for(const actor of [identityPrincipal(outsider),{...principal,userId:'bad'},{...principal,tokenExpiresAt:1}])expect(await op(db(),actor,request,clock())).toEqual({ok:false,error:'unavailable'});
  for(const coupleId of [c2,waiting,id(999)])expect(await op(db(),principal,{...request,coupleId},clock())).toEqual({ok:false,error:'unavailable'});
  expect(await op(db(),principal,{...request,membershipEpoch:2},clock())).toEqual({ok:false,error:'stale_membership'});
  for(const bad of [null,[],{},{...request,extra:true},{...request,coupleId:'bad'},{...request,membershipEpoch:0}])expect(await op(db(),principal,bad,clock())).toEqual({ok:false,error:'invalid_request'});
 }
 for(const patch of [{text:''},{text:'a\rb'},{schedule:{}},{confirm:false},{commandId:'bad'}])expect(await create(db(),principal,{...input,...patch},clock())).toEqual({ok:false,error:'invalid_request'});
 for(const patch of [{confirm:false},{commandId:'bad'},{expectedVersion:0},{expectedVersion:2147483646},{expectedVersion:'1'},{capsuleId:'bad'}])expect(await remove(db(),principal,{...action,...patch},clock())).toEqual({ok:false,error:'invalid_request'});
 expect(await read(db(),principal,{...scope,capsuleId:'bad'},clock())).toEqual({ok:false,error:'invalid_request'});
 expect(await remove(db(),principal,{...action,capsuleId:id(999)},clock())).toEqual({ok:false,error:'unavailable'});
 expect(await remove(db(),partner,action,clock())).toEqual({ok:false,error:'unavailable'});
 expect(await remove(db(),principal,{...action,expectedVersion:2},clock())).toEqual({ok:false,error:'version_conflict'});
 expect(await reseal(db(),principal,{...action,text:'New',schedule:later},clock(due))).toEqual({ok:false,error:'version_conflict'});
});
it('invalid clocks, pre-seal time and post-body rollback never release text',async()=>{
 const {input,q,action}=await make(),detail={...scope,capsuleId:q.id};
 for(const [op,request] of [[list,scope],[create,input],[read,detail],[remove,action]] as const){
  expect(await op(db(),principal,request,clock('2026-11-09T00:00:00.000Z'))).toEqual({ok:false,error:'unavailable'});
  await expect(op(db(),principal,request,()=>new Date('bad'))).rejects.toThrow('invalid_capsule_clock');
 }
 let instant=due;expect(await read(observe(db(),s=>{if(s.startsWith('SELECT body'))instant=start;}),principal,detail,()=>new Date(instant))).toEqual({ok:false,error:'unavailable'});
});
it('malformed metadata, excess rows and malformed body projections fail closed',async()=>{
 const {q}=await make(),detail={...scope,capsuleId:q.id};
 await expect(list(distort(db(),'SELECT id,couple_id',r=>[...r,...r]),principal,scope,clock())).rejects.toThrow('invalid_capsule_capacity');
 await expect(list(distort(db(),'SELECT id,couple_id',r=>[{...(r[0] as object),version:0}]),principal,scope,clock())).rejects.toThrow('invalid_capsule_record');
 for(const rows of [[],[{body:null}],[{body:' noncanonical '}],[{body:'a'},{body:'b'}]])await expect(read(distort(db(),'SELECT body',()=>rows),principal,detail,clock(due))).rejects.toThrow('invalid_capsule_body');
});
it('replay needs original operation, identity, schedule, version and no hidden body',async()=>{
 const {input,q,action}=await make();
 for(const patch of [{operation:'remove'},{applied:{}},{applied:{...q,id:id(999)}},{applied:{...q,body:'smuggled'}},{applied:{...q,version:2}},{applied:{...q,...later,releaseAt:'2026-11-13T06:00:00.000Z'}}])await expect(create(distort(db(),receipt,r=>[{...(r[0] as object),...patch}]),principal,input,clock())).rejects.toThrow('invalid_capsule_replay');
 expect(await create(distort(db(),'SELECT id,couple_id',()=>[]),principal,input,clock())).toEqual({ok:false,error:'unavailable'});
 const change={...action,text:'New',schedule:later};await reseal(db(),principal,change,clock());
 await expect(reseal(distort(db(),receipt,r=>[{...(r[0] as object),applied:q}]),principal,change,clock())).rejects.toThrow('invalid_capsule_replay');
});
it('tampered writes and receipts roll back database effects',async()=>{
 const input=creation();const attempts:[string,(r:unknown[])=>unknown[],string][]=[
 ['INSERT INTO capsules(',()=>[],'invalid_capsule_write'],['INSERT INTO capsules(',r=>[{...(r[0] as object),version:2}],'invalid_capsule_applied_state'],
 ['INSERT INTO capsule_commands',()=>[],'invalid_capsule_receipt'],
 ...[{fingerprint:'bad'},{capsule_id:id(999)},{operation:'remove'},{applied:{}}].map(p=>['INSERT INTO capsule_commands',(r:unknown[])=>[{...(r[0] as object),...p}],'invalid_capsule_receipt'] as [string,(r:unknown[])=>unknown[],string])];
 for(const [prefix,change,error] of attempts){await expect(create(distort(db(),prefix,change),principal,input,clock())).rejects.toThrow(error);expect((await pg.query('SELECT id FROM capsules')).rows).toEqual([]);expect((await pg.query('SELECT command_id FROM capsule_commands')).rows).toEqual([]);}
});
it('late session, midnight and reseal deadline failures roll back both state and receipt',async()=>{
 const input=creation(),base=db();let written=false;
 const expired=observe({...base,sessionAuthority:{...base.sessionAuthority,recheck:async(...args)=>!written&&base.sessionAuthority.recheck(...args)}},s=>{if(s.startsWith('INSERT INTO capsule_commands'))written=true;});
 expect(await create(expired,principal,input,clock())).toEqual({ok:false,error:'unavailable'});
 let instant=start;const crossing=observe(db(),s=>{if(s.startsWith('INSERT INTO capsule_commands'))instant=due;});
 expect(await create(crossing,principal,input,()=>new Date(instant))).toEqual({ok:false,error:'unavailable'});expect((await pg.query('SELECT id FROM capsules')).rows).toEqual([]);
 const {q,action}=await make();instant=start;
 expect(await reseal(crossing,principal,{...action,text:'Never committed',schedule:later},()=>new Date(instant))).toEqual({ok:false,error:'unavailable'});
 expect((await pg.query('SELECT version,body FROM capsules WHERE id=$1',[q.id])).rows).toEqual([{version:1,body:'Synthetic sealed text'}]);
});
it('session loss after list, count, receipt, target and body query denies output',async()=>{
 const {input,q,action}=await make(),detail={...scope,capsuleId:q.id};
 const checks=[[list,scope,'SELECT id,couple_id'],[read,detail,'SELECT id,couple_id'],[read,detail,'SELECT body'],[create,input,receipt],[create,input,'SELECT id,couple_id'],[create,creation(),'SELECT count(*)'],[remove,action,'SELECT id,couple_id']] as const;
 for(const [op,request,prefix] of checks){const base=db();let stopped=false;const tracked=observe({...base,sessionAuthority:{...base.sessionAuthority,recheck:async(...args)=>!stopped&&base.sessionAuthority.recheck(...args)}},s=>{if(s.startsWith(prefix))stopped=true;});expect(await op(tracked,principal,request,clock(due))).toEqual({ok:false,error:'unavailable'});}
});
it('selected day must remain future and receipt trigger never selects body',async()=>{
 expect(await create(db(),principal,creation(),clock(due))).toEqual({ok:false,error:'invalid_request'});
 const sql=await readFile(new URL('../migrations/044_capsules.sql',import.meta.url),'utf8'),trigger=sql.slice(sql.indexOf('CREATE FUNCTION guard_capsule_command()'));
 expect(trigger).not.toMatch(/SELECT\s+\*/i);const projection=trigger.match(/SELECT ([\s\S]+?)INTO p FROM capsules/);expect(projection).not.toBeNull();expect(projection![1]).not.toMatch(/\bbody\b/);
});
it('database rejects invalid identities, control/NFC bodies, malformed receipts and resurrection',async()=>{
 const {q}=await make();
 for(const sql of ["UPDATE capsules SET author_id='44444444-4444-4444-8444-444444444444',version=2 WHERE id=$1",
 "UPDATE capsules SET version=0 WHERE id=$1","UPDATE capsules SET version=2,body=E'bad\\ttext' WHERE id=$1",
 "UPDATE capsules SET version=2,body=U&'e\\0301' WHERE id=$1","UPDATE capsules SET version=2,content_state='removed' WHERE id=$1",
 'DELETE FROM capsules WHERE id=$1'])await expect(pg.query(sql,[q.id])).rejects.toMatchObject({code:'23514'});
 await expect(pg.query('UPDATE capsule_commands SET fingerprint=fingerprint')).rejects.toMatchObject({code:'23514'});
 await expect(pg.query('DELETE FROM capsule_commands')).rejects.toMatchObject({code:'23514'});
 await expect(pg.query(`INSERT INTO capsule_commands(actor_user_id,command_id,couple_id,membership_epoch,capsule_id,fingerprint,operation,applied) VALUES($1,$2,$3,1,$4,repeat('a',64),'create','{}')`,[principal.userId,id(++seq),c1,q.id])).rejects.toMatchObject({code:'23514'});
 await remove(db(),principal,{...command(),capsuleId:q.id,expectedVersion:1},clock());
 await expect(pg.query("UPDATE capsules SET content_state='active',body='resurrection',version=3 WHERE id=$1",[q.id])).rejects.toMatchObject({code:'23514'});
});
it('replay survives multiple reseals and terminal removal while late removal clock rollback preserves text',async()=>{
 const {input,q,action}=await make();const first={...action,text:'Second',schedule:later};
 await reseal(db(),principal,first,clock());
 const second={...command(),capsuleId:q.id,expectedVersion:2,text:'Third',schedule:{...later,localDate:'2026-11-15'}};
 await reseal(db(),principal,second,clock('2026-11-11T07:00:00.000Z'));
 let instant='2026-11-11T07:00:00.000Z';const rollback=observe(db(),s=>{if(s.startsWith('INSERT INTO capsule_commands'))instant=start;});
 const deletion={...command(),capsuleId:q.id,expectedVersion:3};
 expect(await remove(rollback,principal,deletion,()=>new Date(instant))).toEqual({ok:false,error:'unavailable'});
 expect((await pg.query('SELECT version,body FROM capsules')).rows).toEqual([{version:3,body:'Third'}]);
 expect(await remove(db(),principal,deletion,clock('2026-11-11T07:00:00.000Z'))).toMatchObject({value:{capsule:{version:4}}});
 for(const [op,request] of [[create,input],[reseal,first],[reseal,second]] as const)expect(await op(db(),principal,request,clock('2026-11-16T00:00:00.000Z'))).toMatchObject({value:{replay:true,capsule:{version:4,contentState:'removed'}}});
});
