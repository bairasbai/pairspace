import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createHardQuestionsFixture } from './hard-questions-fixture.mjs';
import { client } from './composed-fixture.mjs';
import { mobile, password, closeMobile } from './mobile-invitations-fixture.mjs';

test('real HTTP/mobile hard question: private seal, lost open ACK, refresh/close/retry, explicit reread, removal and epoch ACL',async()=>{
  const f=await createHardQuestionsFixture(),accounts=[],identities=[],seals=[],opens=[];
  const body='🦉'.repeat(1000)+'\n\n'+'Ж'.repeat(998);let loseSeal=true,loseOpen=true;
  try{
    for(let n=0;n<4;n++){
      const c=client(f.baseURL);const result=await c.auth.signUp.email({email:`hard-mobile-${n}@example.test`,password,name:'Synthetic'});
      assert.equal(result.error===null,true,'official synthetic signup succeeds');identities.push(result.data.user.id);
    }
    const a=randomUUID(),b=randomUUID();await f.provision(identities.slice(0,2),a);await f.provision(identities.slice(2),b);
    const path=`/v1/couples/${a}/hard-questions`;
    const hooks=recipient=>({email:`hard-mobile-${recipient?1:0}@example.test`,signup:false,
      beforeRequest:async(record,request)=>{
        if(!record.path.includes('/hard-questions')||record.method==='GET')return;
        const payload=await request.clone().json();assert.equal(request.headers.get('idempotency-key'),payload.command_id);
        if(record.path===path&&record.method==='POST')seals.push(payload);
        if(record.path.endsWith('/open')){assert.equal(payload.confirm,true);opens.push(payload);}
      },
      afterResponse:async(record,response)=>{
        if(!record.path.includes('/hard-questions')||response.status!==200)return;
        const value=(await response.clone().json()).value;
        if(record.path===path){assert.equal(Object.hasOwn(value,'text'),false);const metadata=value.questions??[value.question];assert.equal(metadata.every(q=>!Object.hasOwn(q,'text')),true);}
        if(!recipient&&record.path===path&&record.method==='POST'&&loseSeal){loseSeal=false;throw Error('Synthetic lost sealed ACK');}
        if(recipient&&record.path.endsWith('/open')&&loseOpen){assert.equal(value.text===body,true);loseOpen=false;throw Error('Synthetic lost committed opening ACK');}
      }});
    accounts.push(await mobile(f,0,hooks(false)),await mobile(f,1,hooks(true)),await mobile(f,2,{email:'hard-mobile-2@example.test',signup:false}));
    const [author,recipient,foreign]=accounts.map(account=>account.controller);
    assert.equal(accounts.every(account=>!account.requests.some(r=>r.path.includes('/hard-questions'))),true);
    await author.hardQuestions.load();author.hardQuestions.setDraft(body);
    await recipient.hardQuestions.load();assert.equal(recipient.hardQuestions.getSnapshot().questions.length,0,'draft stays in RAM');
    await author.hardQuestions.seal();assert.equal(author.hardQuestions.getSnapshot().status,'retry');
    author.hardQuestions.setDraft('Synthetic newer unsent question');await author.hardQuestions.retry();assert.deepEqual(seals[0],seals[1]);
    assert.equal(author.hardQuestions.getSnapshot().draft,'Synthetic newer unsent question');
    const q=author.hardQuestions.getSnapshot().questions[0];
    await author.hardQuestions.read(q.id);assert.equal(author.hardQuestions.getSnapshot().reader.text===body,true);
    assert.equal(author.hardQuestions.getSnapshot().questions[0].decisionState,'sealed');
    await recipient.hardQuestions.load();assert.equal(recipient.hardQuestions.getSnapshot().reader,null);
    const headers=async n=>({cookie:await accounts[n].connection.getCookie(),origin:f.baseURL});
    const detail=f.baseURL+path+`/${q.id}/text?membership_epoch=1`;
    assert.equal('text'in(await(await fetch(detail,{headers:await headers(1)})).json()).value,false);
    assert.equal((await fetch(detail,{headers:await headers(2)})).status,403);assert.equal((await fetch(detail,{headers:{origin:f.baseURL}})).status,401);
    await recipient.hardQuestions.open(q.id,false);assert.equal(opens.length,0);
    await recipient.hardQuestions.open(q.id,true);assert.equal(recipient.hardQuestions.getSnapshot().status,'retry');
    await recipient.hardQuestions.load();assert.equal(recipient.hardQuestions.getSnapshot().questions[0].decisionState,'opened');
    recipient.hardQuestions.close();await recipient.hardQuestions.retry();assert.deepEqual(opens[0],opens[1]);
    assert.equal(recipient.hardQuestions.getSnapshot().pending,false);assert.equal(recipient.hardQuestions.getSnapshot().reader,null,'close remains respected after canonical open retry');
    await recipient.hardQuestions.read(q.id);assert.equal(recipient.hardQuestions.getSnapshot().reader.text===body,true);
    recipient.hardQuestions.close();await recipient.hardQuestions.read(q.id);assert.equal(recipient.hardQuestions.getSnapshot().reader.text===body,true,'opened state supports later explicit reads');
    await author.hardQuestions.remove(q.id,true);assert.equal(author.hardQuestions.getSnapshot().status,'conflict','stale sealed metadata cannot silently remove opened question');
    await author.hardQuestions.load();await author.hardQuestions.remove(q.id,true);assert.equal(author.hardQuestions.getSnapshot().status,'saved');
    await recipient.hardQuestions.load();assert.equal(recipient.hardQuestions.getSnapshot().reader,null);
    const removed=recipient.hardQuestions.getSnapshot().questions[0];assert.equal(removed.contentState,'removed');assert.equal(removed.decisionState,'opened');
    const replay=await fetch(f.baseURL+path+`/${q.id}/open`,{method:'POST',headers:{...await headers(1),'content-type':'application/json','idempotency-key':opens[0].command_id},body:JSON.stringify(opens[0])});
    assert.equal(replay.status,200);const canonical=(await replay.json()).value;assert.equal(canonical.replay,true);assert.equal('text'in canonical,false);assert.deepEqual(canonical.question,removed);
    assert.equal('text'in(await(await fetch(detail,{headers:await headers(0)})).json()).value,false);
    assert.equal((await f.domainPool.query('SELECT body FROM hard_questions WHERE id=$1',[q.id])).rows[0].body,null);
    await foreign.hardQuestions.load();assert.equal(foreign.hardQuestions.getSnapshot().questions.length,0);
    const leave=await fetch(f.baseURL+'/v1/pair/leave',{method:'POST',headers:{...await headers(0),'content-type':'application/json'},body:JSON.stringify({coupleId:a,membershipEpoch:1,commandId:randomUUID(),confirm:true})});assert.equal(leave.status,200);
    await recipient.hardQuestions.load();assert.equal(recipient.hardQuestions.getSnapshot().available,false);assert.equal(recipient.hardQuestions.getSnapshot().reader,null);
    await author.refresh();assert.equal(author.hardQuestions.getSnapshot().draft,'');assert.equal((await fetch(detail,{headers:await headers(0)})).status,403);
  }finally{await closeMobile(f,accounts);}
});
