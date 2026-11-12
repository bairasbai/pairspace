import { beforeAll, afterAll, it, expect } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { adapter, createFixture, c1, c2, u1, principal, identityPrincipal, u3, id, failOn } from './fixtures.ts';
import { readChatWindow } from '../src/chat-history-window.ts';
import { createChatWindowHandler } from '../src/chat-history-window-http.ts';
import { bindSessionAuthority } from '../src/auth-authority.ts';
import { createSyntheticAuthority } from '../src/synthetic-authority.ts';
let pg: PGlite;
const input = { coupleId:c1,membershipEpoch:1,readId:id(9000),direction:'latest' };
beforeAll(async()=>{
  pg=await createFixture();
  await pg.query(`INSERT INTO chat_messages(couple_id,sender_id,client_message_id,seq,body,created_at)
    SELECT $1,$2,gen_random_uuid(),n*3,'Synthetic '||n,'2026-01-01' FROM generate_series(1,251) n`,[c1,u1]);
});
afterAll(async()=>{await pg.close();});
it('walks all 251 rows both ways with stable seq despite identical timestamps and gaps',async()=>{
  const db=adapter(pg), get=async(direction:string,anchorSeq?:number)=>{const anchor=anchorSeq===undefined?undefined:(await pg.query<{id:string}>('SELECT id FROM chat_messages WHERE couple_id=$1 AND seq=$2',[c1,anchorSeq])).rows[0];return readChatWindow(db,principal,{...input,direction,...(anchorSeq===undefined?{}:{anchorSeq,anchorId:anchor?.id})});};
  const latest=await get('latest');if(!latest.ok)throw Error('fixture');
  expect(latest.value.messages.map(m=>m.seq)).toEqual(Array.from({length:50},(_,i)=>(202+i)*3));
  expect(latest.value).toMatchObject({hasOlder:true,hasNewer:false,newerCursor:null});
  let page=await get('oldest');const seq:number[]=[];
  while(page.ok){seq.push(...page.value.messages.map(m=>m.seq));if(!page.value.newerCursor)break;page=await get('after',page.value.newerCursor.seq);}
  expect(seq).toEqual(Array.from({length:251},(_,i)=>(i+1)*3));
  const previous=await get('before',606);if(!previous.ok)throw Error('fixture');
  expect(previous.value.messages.map(m=>m.seq)).toEqual(Array.from({length:50},(_,i)=>(152+i)*3));
  expect(await get('before',3)).toMatchObject({ok:true,value:{messages:[],hasOlder:false,hasNewer:false}});
  expect(await get('after',753)).toMatchObject({ok:true,value:{messages:[],hasOlder:false,hasNewer:false}});
  await pg.query("INSERT INTO chat_messages(couple_id,sender_id,client_message_id,seq,body) VALUES($1,$2,$3,900,'New')",[c1,u1,id(9001)]);
  expect(await get('after',753)).toMatchObject({ok:true,value:{messages:[{seq:900}],hasOlder:true,hasNewer:false}});
});
it('strict scopes and cursors fail closed, before and after authorization',async()=>{
 const db=adapter(pg);
 for(const value of [null,[],{}, {...input,extra:true},{...input,readId:'bad'},{...input,membershipEpoch:0},{...input,direction:'first'}])expect(await readChatWindow(db,principal,value)).toEqual({ok:false,error:'invalid_request'});
 for(const anchorSeq of [-1,0,1.2,Number.MAX_SAFE_INTEGER+1,'3',4])expect(await readChatWindow(db,principal,{...input,direction:'after',anchorSeq,anchorId:id(9002)})).toEqual({ok:false,error:'invalid_cursor'});
 expect(await readChatWindow(db,identityPrincipal(u3),input)).toEqual({ok:false,error:'unavailable'});
 expect(await readChatWindow(db,principal,{...input,coupleId:c2})).toEqual({ok:false,error:'unavailable'});
 expect(await readChatWindow(db,principal,{...input,membershipEpoch:2})).toEqual({ok:false,error:'stale_membership'});
 expect(await readChatWindow(db,{...principal,userId:'invalid'},input)).toEqual({ok:false,error:'unavailable'});
 expect(await readChatWindow(db,{...principal,tokenExpiresAt:1},input)).toEqual({ok:false,error:'unavailable'});
 let checks=0;const revoked={...db,sessionAuthority:{...db.sessionAuthority,recheck:async()=>++checks===1}};
 expect(await readChatWindow(revoked,principal,input)).toEqual({ok:false,error:'unavailable'});
});
it('HTTP nonce echo, malformed queries, authentication and failure mapping',async()=>{
 const db=adapter(pg),handler=createChatWindowHandler(bindSessionAuthority(db,createSyntheticAuthority(async()=>principal)));
 const base=`http://localhost/v1/couples/${c1}/chat/history-window`;
 const request=(query='membership_epoch=1&direction=latest&read_id='+id(9000),method='GET')=>new Request(base+'?'+query,{method,headers:{authorization:'Bearer synthetic'}});
 expect((await handler(request())).status).toBe(200);
 for(const query of ['', 'membership_epoch=1&direction=latest&read_id=bad','membership_epoch=1&direction=latest&read_id='+id(9000)+'&extra=x','membership_epoch=1&direction=latest&read_id='+id(9000)+'&anchor_id='+id(9002)+'&read_id='+id(9000)])expect((await handler(request(query))).status).toBe(400);
 for(const anchor of ['no','4','9007199254740992'])expect((await handler(request('membership_epoch=1&direction=after&anchor_seq='+anchor+'&anchor_id='+id(9002)+'&read_id='+id(9000)))).status).toBe(400);
 expect((await handler(request('membership_epoch=2&direction=latest&read_id='+id(9000)))).status).toBe(409);
 expect(await (await handler(request(undefined,'POST'))).json()).toMatchObject({error:'method_not_allowed',readId:id(9000)});
 expect((await handler(new Request(base+'/other'))).status).toBe(404);
 const denied=createChatWindowHandler(bindSessionAuthority(db,createSyntheticAuthority(async()=>null)));
 expect((await denied(request())).status).toBe(401);
 const foreign=createChatWindowHandler(bindSessionAuthority(db,createSyntheticAuthority(async()=>identityPrincipal(u3))));
 expect((await foreign(request())).status).toBe(403);
 const broken=createChatWindowHandler(bindSessionAuthority(failOn(db,'FROM couples'),createSyntheticAuthority(async()=>principal)));
 expect(await (await broken(request())).json()).toMatchObject({error:'temporarily_unavailable',readId:id(9000)});
});
