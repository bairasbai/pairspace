import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { replyFixture } from './chat-replies-fixture.mjs';
import { createQuestion, answerQuestion, skipQuestion, removeQuestion, removeAnswer, listQuestions } from '../../src/asks.ts';
import { leavePair } from '../../src/pair-leave.ts';

test('ask real actor/CAS races, split removal, canonical retries, capacity and receipt-lock expiry', async () => {
  const {f,a,b,db,principals:p,usersA}=await replyFixture();let holder,pending;
  const scope={coupleId:a,membershipEpoch:1};
  const create=(text='Synthetic question')=>({...scope,commandId:randomUUID(),text});
  const action=(question)=>({...scope,commandId:randomUUID(),questionId:question.id,expectedVersion:question.version});
  const read=async id=>(await listQuestions(db,p[0],scope)).value.questions.find(q=>q.id===id);
  try {
    const original=create();
    const dupes=await Promise.all(Array.from({length:4},()=>createQuestion(db,p[0],original)));
    assert.ok(dupes.every(r=>r.ok));assert.equal(dupes.filter(r=>!r.value.replay).length,1);
    const first=dupes[0].value.question;
    assert.equal(first.recipientId,p[1].userId);assert.equal(first.authorId,p[0].userId);
    assert.equal((await listQuestions(db,p[2],scope)).error,'unavailable');
    assert.equal((await listQuestions(db,p[0],{...scope,coupleId:b})).error,'unavailable');
    assert.equal((await answerQuestion(db,p[0],{...action(first),text:'Self'})).error,'unavailable');
    assert.equal((await removeQuestion(db,p[1],action(first))).error,'unavailable');
    const answer={...action(first),text:'Synthetic partner answer'};
    const saved=await answerQuestion(db,p[1],answer);assert.equal(saved.ok,true);
    const answered=saved.value.question;assert.equal(answered.responseState,'answered');assert.ok(answered.answeredAt);
    assert.equal((await removeAnswer(db,p[0],action(answered))).error,'unavailable');
    const split=await Promise.all([removeQuestion(db,p[0],action(answered)),removeAnswer(db,p[1],action(answered))]);
    assert.equal(split.filter(r=>r.ok).length,1);assert.equal(split.find(r=>!r.ok).error,'version_conflict');
    let middle=split.find(r=>r.ok).value.question;
    if(middle.questionState==='removed'){
      assert.equal(middle.answer,answer.text);assert.equal(middle.responseState,'answered');
      middle=(await removeAnswer(db,p[1],action(middle))).value.question;
    }else{
      assert.equal(middle.question,original.text);assert.equal(middle.responseState,'answer_removed');
      middle=(await removeQuestion(db,p[0],action(middle))).value.question;
    }
    assert.equal(middle.questionState,'removed');assert.equal(middle.responseState,'answer_removed');
    assert.equal(middle.answeredAt,answered.answeredAt);assert.equal(middle.version,4);
    assert.equal('question' in middle,false);assert.equal('answer' in middle,false);
    assert.deepEqual((await createQuestion(db,p[0],original)).value.question,middle);
    assert.deepEqual((await answerQuestion(db,p[1],answer)).value.question,middle);
    assert.equal((await answerQuestion(db,p[1],{...action(middle),text:'Re-answer'})).error,'version_conflict');
    const erased=(await f.domainPool.query('SELECT question,answer FROM asks WHERE id=$1',[middle.id])).rows[0];
    assert.deepEqual(erased,{question:null,answer:null});
    await assert.rejects(f.domainPool.query("UPDATE asks SET response_state='waiting',question_state='active',question='Revive',answered_at=NULL,version=version+1 WHERE id=$1",[middle.id]));
    await assert.rejects(f.domainPool.query('DELETE FROM asks WHERE id=$1',[middle.id]));

    const second=(await createQuestion(db,p[0],create())).value.question;
    const skip=action(second);
    const skipped=(await skipQuestion(db,p[1],skip)).value.question;
    const skippedRemoved=(await removeQuestion(db,p[0],action(skipped))).value.question;
    assert.equal(skippedRemoved.responseState,'skipped');assert.equal(skippedRemoved.questionState,'removed');
    assert.equal('answeredAt' in skippedRemoved,false);
    assert.deepEqual((await skipQuestion(db,p[1],skip)).value.question,skippedRemoved);
    assert.equal((await answerQuestion(db,p[1],{...action(skippedRemoved),text:'No'})).error,'version_conflict');

    for(const competing of ['skip','withdraw']){
      const q=(await createQuestion(db,p[0],create())).value.question;
      const results=await Promise.all([answerQuestion(db,p[1],{...action(q),text:'Race answer'}),
        competing==='skip'?skipQuestion(db,p[1],action(q)):removeQuestion(db,p[0],action(q))]);
      assert.equal(results.filter(r=>r.ok).length,1);assert.equal(results.find(r=>!r.ok).error,'version_conflict');
      const now=await read(q.id);
      assert.ok(['answered',competing==='skip'?'skipped':'withdrawn'].includes(now.responseState));
      if(now.responseState==='withdrawn')assert.equal('question' in now,false);
    }

    // Receipt membership FK is a real wait AFTER answer UPDATE. Expiring here must
    // roll back the answer, timestamp, version and receipt as one transaction.
    const waiting=(await createQuestion(db,p[0],create())).value.question;
    holder=await f.domainPool.connect();await holder.query('BEGIN');
    const blocker=(await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    await holder.query('SELECT user_id FROM couple_members WHERE couple_id=$1 AND user_id=$2 FOR UPDATE',[a,usersA[1]]);
    const limited={...p[1],tokenExpiresAt:Math.floor(Date.now()/1000)+2};let pid,receiptRequested=false;
    const waitingDb={...db,transaction:work=>db.transaction(async tx=>{
      pid=(await tx.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      return work({query(sql,args){if(sql.startsWith('INSERT INTO ask_commands'))receiptRequested=true;return tx.query(sql,args);}});
    })};
    const delayed={...action(waiting),text:'Must roll back'};
    pending=answerQuestion(waitingDb,limited,delayed);pending.catch(()=>{});
    let observed=false;
    for(let n=0;n<150;n++){
      if(pid&&receiptRequested)observed=(await f.domainPool.query('SELECT $2=ANY(pg_blocking_pids(pid)) blocked FROM pg_stat_activity WHERE pid=$1',[pid,blocker])).rows[0]?.blocked;
      if(observed)break;await delay(10);
    }
    assert.equal(observed,true,'actual receipt FK blocks after answer UPDATE');
    while(Date.now()<limited.tokenExpiresAt*1000)await delay(10);
    await holder.query('COMMIT');holder.release();holder=null;
    assert.deepEqual(await pending,{ok:false,error:'unavailable'});pending=null;
    assert.deepEqual(await read(waiting.id),waiting);
    assert.equal((await f.domainPool.query('SELECT command_id FROM ask_commands WHERE command_id=$1',[delayed.commandId])).rowCount,0);

    let used=(await listQuestions(db,p[0],scope)).value.used;
    for(;used<100;used++)assert.equal((await createQuestion(db,p[0],create(`Synthetic ${used}`))).ok,true);
    const all=(await listQuestions(db,p[0],scope)).value;
    assert.equal(all.questions.length,100);assert.equal(all.used,100);assert.equal(all.capacity,100);
    let terminal=false;
    for(const q of all.questions){if(q.responseState!=='waiting')terminal=true;else assert.equal(terminal,false,'waiting first complete history');}
    assert.equal((await createQuestion(db,p[0],create())).error,'capacity_reached');
    const rolledBackClock={...db,now:()=>new Date('2000-01-01T00:00:00.000Z')};
    const atCap=(await answerQuestion(rolledBackClock,p[1],{...action(waiting),text:'Still allowed at cap'})).value.question;
    assert.equal(atCap.answeredAt,waiting.createdAt,'logical answer timestamp cannot precede question under clock rollback');
    await assert.rejects(f.domainPool.query("UPDATE asks SET answered_at=created_at-interval '1 second',version=version+1 WHERE id=$1",[atCap.id]));
    assert.equal(atCap.responseState,'answered');
    assert.equal((await removeAnswer(db,p[1],action(atCap))).ok,true);
    assert.equal((await listQuestions(db,p[0],scope)).value.used,100);
    assert.equal((await leavePair(db,p[1],{...scope,commandId:randomUUID(),confirm:true})).ok,true);
    assert.equal((await listQuestions(db,p[0],scope)).error,'unavailable');
    assert.equal((await answerQuestion(db,p[1],answer)).error,'unavailable');
  }finally{
    if(holder){await holder.query('ROLLBACK');holder.release();}
    if(pending)await pending.catch(()=>{});
    await f.close();
  }
});
