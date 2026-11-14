import {readFile} from 'node:fs/promises';
import {afterAll,beforeAll,expect,it} from 'vitest';
import type {PGlite} from '@electric-sql/pglite';
import {createParting,editParting,listPartings} from '../src/partings.ts';
import {createPartingsHandler} from '../src/partings-http.ts';
import {partingRange} from '../../../packages/domain/partings/range.ts';
import {bindSessionAuthority} from '../src/auth-authority.ts';
import {createSyntheticAuthority} from '../src/synthetic-authority.ts';
import {adapter,c1,c2,createFixture,id,identityPrincipal,outsider,principal,u2,waiting} from './fixtures.ts';
let pg:PGlite; const scope={coupleId:c1,membershipEpoch:1};const db=()=>adapter(pg);
const command={...scope,commandId:id(901),title:'Synthetic period',startDate:'2028-03-10',endDate:'2028-03-13',timezone:'America/New_York'};
let resource:string;
beforeAll(async()=>{pg=await createFixture();for(const f of ['012_shared_dates.sql','030_partings.sql'])await pg.exec(await readFile(new URL('../migrations/'+f,import.meta.url),'utf8'));});
afterAll(async()=>{await pg.close();});
it('validates bounded labels and unique civil midnight; DST changes actual duration',()=>{
 expect(partingRange('2028-03-11','2028-03-12','America/New_York')).toEqual({startsAt:'2028-03-11T05:00:00.000Z',endsAt:'2028-03-13T04:00:00.000Z'});
 for(const args of [[null,'2028-01-01','UTC'],['1999-12-31','2000-01-01','UTC'],['2100-01-01','2101-01-01','UTC'],['2028-02-30','2028-03-01','UTC'],['2028-03-02','2028-03-01','UTC'],['2028-03-01','2028-03-02','bad'],['2011-12-30','2011-12-30','Pacific/Apia'],['2026-11-01','2026-11-01','America/Havana'],['2026-03-07','2026-03-07','America/Havana']])expect(partingRange(...args as [unknown,unknown,unknown])).toBeNull();
});
it('create/list/partner edit, unchanged save, canonical immutable replay and overlap',async()=>{
 expect(await listPartings(db(),principal,scope)).toMatchObject({ok:true,value:{partings:[],limit:100}});
 const first=await createParting(db(),principal,command);expect(first.ok).toBe(true);if(!first.ok)throw Error('fixture');resource=first.value.parting.id;
 expect(first.value.parting).toMatchObject({version:1,creatorId:principal.userId,startDate:command.startDate});
 expect(await createParting(db(),principal,command)).toMatchObject({ok:true,value:{replay:true,parting:{id:resource,version:1}}});
 const edit={...command,commandId:id(902),partingId:resource,expectedVersion:1};
 expect(await editParting(db(),identityPrincipal(u2),edit)).toMatchObject({ok:true,value:{parting:{version:1}}});
 expect(await editParting(db(),identityPrincipal(u2),{...edit,commandId:id(903),title:'Changed'})).toMatchObject({ok:true,value:{parting:{version:2}}});
 expect(await createParting(db(),principal,command)).toMatchObject({ok:true,value:{replay:true,parting:{version:2,title:'Changed'}}});
 expect(await editParting(db(),principal,{...edit,commandId:id(904)})).toEqual({ok:false,error:'version_conflict'});
 expect(await editParting(db(),principal,{...edit,partingId:id(999)})).toEqual({ok:false,error:'unavailable'});
 for(const delta of [{title:'Other'},{endDate:'2028-03-14'},{startDate:'2028-03-09'},{timezone:'UTC'}])expect(await createParting(db(),principal,{...command,...delta})).toEqual({ok:false,error:'idempotency_conflict'});
 expect(await createParting(db(),principal,{...command,commandId:id(905)})).toEqual({ok:false,error:'overlap'});
 expect(await listPartings(db(),identityPrincipal(u2),scope)).toMatchObject({ok:true,value:{partings:[{id:resource,title:'Changed'}]}});
 const next={...command,commandId:id(906),startDate:'2028-03-14',endDate:'2028-03-14'};
 expect(await createParting(db(),principal,next)).toMatchObject({ok:true});
 await expect(pg.query('UPDATE partings SET creator_id=$1 WHERE id=$2',[u2,resource])).rejects.toThrow();
 await expect(pg.query('DELETE FROM partings WHERE id=$1',[resource])).rejects.toThrow();
 await expect(pg.query('UPDATE parting_commands SET title=$1',['bad'])).rejects.toThrow();
});
it('rejects malformed identity, auth, stale scope and unreachable clock',async()=>{
 for(const bad of [null,[],{}, {...command,x:1},{...command,coupleId:'bad'},{...command,membershipEpoch:0},{...command,commandId:'bad'},{...command,title:''},{...command,timezone:'america/new_york'}])expect(await createParting(db(),principal,bad)).toEqual({ok:false,error:'invalid_request'});
 for(const delta of [{partingId:'bad'},{expectedVersion:0},{expectedVersion:2147483647}])expect(await editParting(db(),principal,{...command,partingId:resource,expectedVersion:2,...delta})).toEqual({ok:false,error:'invalid_request'});
 expect(await listPartings(db(),principal,command)).toEqual({ok:false,error:'invalid_request'});
 for(const operation of [createParting,listPartings]){
 const input=operation===createParting?command:scope;
 expect(await operation(db(),{...principal,userId:'bad'},input)).toEqual({ok:false,error:'unavailable'});
 for(const coupleId of [c2,waiting,id(999)])expect(await operation(db(),principal,{...input,coupleId})).toEqual({ok:false,error:'unavailable'});
 expect(await operation(db(),identityPrincipal(outsider),input)).toEqual({ok:false,error:'unavailable'});
 expect(await operation(db(),principal,{...input,membershipEpoch:2})).toEqual({ok:false,error:'stale_membership'});
 }
 const source=db();await expect(listPartings(bindSessionAuthority({...source,now:()=>new Date(NaN)},{...source.sessionAuthority,recheck:async()=>true}),principal,scope)).rejects.toThrow('invalid_server_clock');
});
const path=`http://localhost/v1/couples/${c1}/partings`;
const body={command_id:id(950),membership_epoch:1,title:'HTTP period',start_date:'2030-01-01',end_date:'2030-01-02',timezone:'UTC'};
const req=(method='POST',data:unknown=body,suffix='',headers:Record<string,string>={})=>new Request(path+suffix,{method,headers:{authorization:'Bearer fixture','content-type':'application/json','idempotency-key':id(950),...headers},...(['POST','PATCH'].includes(method)?{body:JSON.stringify(data)}:{})});
it('strict HTTP route, schemas, keys, responses and redacted errors',async()=>{
 const h=createPartingsHandler(bindSessionAuthority(db(),createSyntheticAuthority(async()=>principal)));
 expect((await h(new Request('http://localhost/unknown'))).status).toBe(404);
 expect((await h(req('DELETE'))).status).toBe(405);
 expect((await h(req('GET',null,'?membership_epoch=1'))).status).toBe(200);
 for(const suffix of ['', '?membership_epoch=0','?membership_epoch=1&membership_epoch=1'])expect((await h(req('GET',null,suffix))).status).toBe(400);
 expect((await h(req('POST',body,'?x=1'))).status).toBe(400);
 expect((await h(req('POST',body,'',{'content-type':'text/plain'}))).status).toBe(415);
 for(const bad of [null,[],{}, {...body,x:1},{...body,command_id:'bad'},{...body,command_id:id(900)}])expect((await h(req('POST',bad))).status).toBe(400);
 expect((await h(new Request(path,{method:'POST',headers:{authorization:'Bearer fixture','content-type':'application/json'},body:'{'}))).status).toBe(400);
 const saved=await h(req());expect(saved.status).toBe(201);expect(saved.headers.get('cache-control')).toBe('no-store');
 const value=await saved.json() as {value:{parting:{id:string}}};const r=value.value.parting.id;
 expect((await h(req())).status).toBe(200);
 expect((await h(req('PATCH',{...body,expected_version:1},'/'+r))).status).toBe(409);
 expect((await h(req('PATCH',{...body,command_id:id(951),expected_version:1},'/'+r,{'idempotency-key':id(951)}))).status).toBe(200);
 expect((await h(req('POST',{...body,title:'conflict'}))).status).toBe(409);
 expect((await h(req('POST',{...body,membership_epoch:0}))).status).toBe(400);
 expect((await createPartingsHandler(bindSessionAuthority(db(),createSyntheticAuthority(async()=>null)))(req())).status).toBe(401);
 expect((await createPartingsHandler(bindSessionAuthority(db(),createSyntheticAuthority(async()=>identityPrincipal(outsider))))(req())).status).toBe(403);
 const source=db();expect((await createPartingsHandler(bindSessionAuthority({...source,transaction:async()=>{throw Error('private');}},createSyntheticAuthority(async()=>principal)))(req())).status).toBe(503);
});
it('complete bounded capacity and raw SQL boundary guards fail without silent truncation',async()=>{
 const count=(await pg.query<{n:number}>('SELECT count(*)::int n FROM partings WHERE couple_id=$1',[c1])).rows[0].n;
 await pg.query(`INSERT INTO partings(couple_id,creator_id,membership_epoch,title,start_date,end_date,timezone,starts_at,ends_at,created_at)
 SELECT $1,$2,1,'Synthetic capacity',to_char(d,'YYYY-MM-DD'),to_char(d,'YYYY-MM-DD'),'UTC',d AT TIME ZONE 'UTC',(d+interval '1 day') AT TIME ZONE 'UTC',now()
 FROM generate_series('2040-01-01'::timestamp,'2041-01-01'::timestamp,interval '2 days') d LIMIT $3`,[c1,principal.userId,100-count]);
 const list=await listPartings(db(),principal,scope);expect(list.ok && list.value.partings).toHaveLength(100);
 expect(await createParting(db(),principal,{...command,commandId:id(991),startDate:'2050-01-01',endDate:'2050-01-01'})).toEqual({ok:false,error:'capacity_limit'});
 await expect(pg.query(`INSERT INTO partings(couple_id,creator_id,membership_epoch,title,start_date,end_date,timezone,starts_at,ends_at,created_at) VALUES($1,$2,1,'extra','2050-01-01','2050-01-01','UTC','2050-01-01Z','2050-01-02Z',now())`,[c1,principal.userId])).rejects.toThrow();
});
