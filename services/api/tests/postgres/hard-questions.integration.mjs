import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { replyFixture } from './chat-replies-fixture.mjs';
import { listHardQuestions, readHardQuestion, sealHardQuestion, openHardQuestion, declineHardQuestion, removeHardQuestion } from '../../src/hard-questions.ts';
import { leavePair } from '../../src/pair-leave.ts';
const migrate = async f => f.domainPool.query(await readFile(new URL('../../migrations/041_hard_questions.sql', import.meta.url), 'utf8'));
async function observedWait(f, pid, locker) {
  for (let n = 0; n < 150; n++) {
    const waiter = pid();
    if (waiter) {
      const r = (await f.domainPool.query('SELECT $2=ANY(pg_blocking_pids(pid)) blocked FROM pg_stat_activity WHERE pid=$1', [waiter, locker])).rows[0];
      if (r?.blocked) return;
    }
    await delay(10);
  }
  assert.fail('Expected real PostgreSQL lock wait was not observed');
}
test('real hard questions: sealed projection, single opening, CAS choice/removal races, current replay and lifetime capacity', async () => {
  const { f, a, b, db, principals: p } = await replyFixture();
  try {
    await migrate(f); const scope = { coupleId: a, membershipEpoch: 1 };
    const seal = (text = 'Synthetic private native question') => ({ ...scope, commandId: randomUUID(), text });
    const action = q => ({ ...scope, questionId: q.id, commandId: randomUUID(), expectedVersion: q.version, confirm: true });
    const original = seal('🦉'.repeat(2000));
    const duplicates = await Promise.all(Array.from({ length: 4 }, () => sealHardQuestion(db, p[0], original)));
    assert.equal(duplicates.every(r => r.ok), true); assert.equal(duplicates.filter(r => !r.value.replay).length, 1);
    const question = duplicates[0].value.question; let bodyQueries = 0;
    const observed = { ...db, transaction: work => db.transaction(tx => work({ query(sql, args) {
      if (sql.startsWith('SELECT body FROM hard_questions')) bodyQueries++;
      return tx.query(sql, args);
    } })) };
    const detail = { ...scope, questionId: question.id };
    assert.equal((await listHardQuestions(observed, p[1], scope)).value.questions.some(q => 'text' in q), false);
    assert.equal('text' in (await readHardQuestion(observed, p[1], detail)).value, false); assert.equal(bodyQueries, 0);
    assert.equal((await readHardQuestion(observed, p[0], detail)).value.text === original.text, true); assert.equal(bodyQueries, 1);
    assert.equal((await readHardQuestion(db, p[2], detail)).error, 'unavailable');
    assert.equal((await listHardQuestions(db, p[0], { ...scope, coupleId: b })).error, 'unavailable');
    assert.equal((await openHardQuestion(db, p[0], action(question))).error, 'unavailable');
    const opening = action(question), opened = await Promise.all(Array.from({ length: 4 }, () => openHardQuestion(db, p[1], opening)));
    assert.equal(opened.every(r => r.ok && r.value.text === original.text), true); assert.equal(opened.filter(r => !r.value.replay).length, 1);
    const canonical = opened[0].value.question;
    assert.equal((await readHardQuestion(db, p[1], detail)).value.text === original.text, true);
    assert.equal((await openHardQuestion(db, p[1], action(canonical))).error, 'version_conflict');
    assert.equal((await removeHardQuestion(db, p[1], action(canonical))).error, 'unavailable');
    const removed = await removeHardQuestion(db, p[0], action(canonical)); assert.equal(removed.ok, true);
    assert.equal(removed.value.question.decisionState, 'opened'); assert.equal(removed.value.question.openedAt, canonical.openedAt);
    assert.equal('text' in (await openHardQuestion(db, p[1], opening)).value, false);
    assert.deepEqual((await sealHardQuestion(db, p[0], original)).value.question, removed.value.question);
    assert.equal('text' in (await readHardQuestion(db, p[0], detail)).value, false);
    assert.equal((await f.domainPool.query('SELECT body FROM hard_questions WHERE id=$1', [question.id])).rows[0].body, null);
    await assert.rejects(f.domainPool.query('DELETE FROM hard_questions WHERE id=$1', [question.id]), { code: '23514' });
    for (const competing of ['decline', 'withdraw']) {
      const q = (await sealHardQuestion(db, p[0], seal())).value.question;
      const race = await Promise.all([openHardQuestion(db, p[1], action(q)), competing === 'decline'
        ? declineHardQuestion(db, p[1], action(q)) : removeHardQuestion(db, p[0], action(q))]);
      assert.equal(race.filter(r => r.ok).length, 1); assert.equal(race.find(r => !r.ok).error, 'version_conflict');
    }
    const declinedQuestion = (await sealHardQuestion(db, p[0], seal())).value.question;
    const declining = action(declinedQuestion); assert.equal((await declineHardQuestion(db, p[1], declining)).ok, true);
    bodyQueries = 0;
    assert.equal('text' in (await readHardQuestion(observed, p[1], { ...scope, questionId: declinedQuestion.id })).value, false);
    assert.equal(bodyQueries, 0); assert.equal((await readHardQuestion(db, p[0], { ...scope, questionId: declinedQuestion.id })).value.text === 'Synthetic private native question', true);
    await assert.rejects(f.domainPool.query(`INSERT INTO hard_questions(couple_id,author_id,recipient_id,membership_epoch,sequence,version,created_at,content_state,decision_state,body)
      VALUES($1,$2,$3,1,(SELECT count(*)+1 FROM hard_questions WHERE couple_id=$1),1,clock_timestamp(),'active','sealed',$4)`, [a,p[0].userId,p[1].userId,String.fromCodePoint(0xa0)+'Not canonical'+String.fromCodePoint(0xa0)]), { code: '23514' });
    let used = (await listHardQuestions(db, p[0], scope)).value.used;
    for (; used < 99; used++) assert.equal((await sealHardQuestion(db, p[0], seal())).ok, true);
    const cap = await Promise.all([sealHardQuestion(db, p[0], seal('Last A')), sealHardQuestion(db, p[0], seal('Last B'))]);
    assert.equal(cap.filter(r => r.ok).length, 1); assert.equal(cap.find(r => !r.ok).error, 'capacity_reached');
    const history = (await listHardQuestions(db, p[1], scope)).value;
    assert.equal(history.used, 100); assert.equal(history.questions.length, 100);
    assert.deepEqual(history.questions.map(q => q.sequence).sort((x,y) => x-y), Array.from({length:100},(_,n)=>n+1));
    const last = history.questions.find(q => q.decisionState === 'sealed');
    const lastOpen = await openHardQuestion(db, p[1], action(last)); assert.equal(lastOpen.ok, true);
    assert.equal((await removeHardQuestion(db, p[0], action(lastOpen.value.question))).ok, true);
    assert.equal((await leavePair(db, p[1], { ...scope, commandId: randomUUID(), confirm: true })).ok, true);
    assert.equal((await listHardQuestions(db, p[0], scope)).error, 'unavailable');
    assert.equal((await readHardQuestion(db, p[1], detail)).error, 'unavailable');
    assert.equal((await openHardQuestion(db, p[1], opening)).error, 'unavailable');
  } finally { await f.close(); }
});
test('real hard opening receipt FK wait: expiry rolls back consent/time/version/receipt before any body selection', async () => {
  const { f, a, db, principals: p, usersA } = await replyFixture(); let holder, pending;
  try {
    await migrate(f); const scope = { coupleId: a, membershipEpoch: 1 };
    const q = (await sealHardQuestion(db, p[0], { ...scope, commandId: randomUUID(), text: 'Synthetic receipt boundary' })).value.question;
    holder = await f.domainPool.connect(); await holder.query('BEGIN');
    const locker = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    await holder.query('SELECT user_id FROM couple_members WHERE couple_id=$1 AND user_id=$2 FOR UPDATE', [a,usersA[1]]);
    let waiter, receipt = false, bodies = 0;
    const tracked = { ...db, transaction: work => db.transaction(async tx => {
      waiter = (await tx.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      return work({ query(sql,args) { if(sql.startsWith('INSERT INTO hard_question_commands'))receipt=true;
        if(sql.startsWith('SELECT body FROM hard_questions'))bodies++;return tx.query(sql,args); } });
    }) };
    const limited = { ...p[1], tokenExpiresAt: Math.floor(Date.now()/1000)+2 };
    const opening = { ...scope, questionId:q.id, commandId:randomUUID(),expectedVersion:1,confirm:true };
    pending = openHardQuestion(tracked,limited,opening); pending.catch(()=>{});
    await observedWait(f,()=>receipt?waiter:null,locker);
    assert.equal(bodies,0); while(Date.now()<limited.tokenExpiresAt*1000)await delay(10);
    await holder.query('COMMIT');holder.release();holder=null;
    assert.deepEqual(await pending,{ok:false,error:'unavailable'});pending=null;assert.equal(bodies,0);
    assert.deepEqual((await listHardQuestions(db,p[0],scope)).value.questions,[q]);
    assert.equal((await f.domainPool.query('SELECT command_id FROM hard_question_commands WHERE command_id=$1',[opening.commandId])).rowCount,0);
    assert.equal((await f.domainPool.query('SELECT opened_at FROM hard_questions WHERE id=$1',[q.id])).rows[0].opened_at,null);
  } finally { if(holder){await holder.query('ROLLBACK');holder.release();}if(pending)await pending.catch(()=>{});await f.close(); }
});
test('real hard private GET checks actual expiry after observed question-row wait, before selecting text', async () => {
  const { f,a,db,principals:p }=await replyFixture();let holder,pending;
  try {
    await migrate(f);const scope={coupleId:a,membershipEpoch:1};
    const q=(await sealHardQuestion(db,p[0],{...scope,commandId:randomUUID(),text:'Synthetic private row boundary'})).value.question;
    assert.equal((await openHardQuestion(db,p[1],{...scope,questionId:q.id,commandId:randomUUID(),expectedVersion:1,confirm:true})).ok,true);
    await f.authPool.query(`UPDATE "session" SET "expiresAt"=clock_timestamp()+interval '2 seconds' WHERE id=$1`,[p[1].sessionId]);
    holder=await f.domainPool.connect();await holder.query('BEGIN');const locker=(await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    await holder.query('SELECT id FROM hard_questions WHERE id=$1 FOR UPDATE',[q.id]);let waiter,bodies=0;
    const tracked={...db,transaction:work=>db.transaction(async tx=>{waiter=(await tx.query('SELECT pg_backend_pid() pid')).rows[0].pid;return work({query(sql,args){if(sql.startsWith('SELECT body FROM hard_questions'))bodies++;return tx.query(sql,args);}});})};
    pending=readHardQuestion(tracked,p[1],{...scope,questionId:q.id});pending.catch(()=>{});await observedWait(f,()=>waiter,locker);
    await delay(2100);
    assert.equal((await f.domainPool.query('SELECT "expiresAt"<=clock_timestamp() expired FROM "session" WHERE id=$1',[p[1].sessionId])).rows[0].expired,true);
    await holder.query('COMMIT');holder.release();holder=null;
    assert.deepEqual(await pending,{ok:false,error:'unavailable'});pending=null;assert.equal(bodies,0);
    assert.equal((await readHardQuestion(db,p[0],{...scope,questionId:q.id})).value.text==='Synthetic private row boundary',true);
  }finally{if(holder){await holder.query('ROLLBACK');holder.release();}if(pending)await pending.catch(()=>{});await f.close();}
});
test('real hard private GET denies provider revocation after session-row wait, before question or body access', async()=>{
  const {f,a,db,principals:p}=await replyFixture();let holder,pending;
  try{
    await migrate(f);const scope={coupleId:a,membershipEpoch:1};const q=(await sealHardQuestion(db,p[0],{...scope,commandId:randomUUID(),text:'Synthetic revocation boundary'})).value.question;
    holder=await f.domainPool.connect();await holder.query('BEGIN');const locker=(await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    // Provider SHARE locks serialize revocation. Hold before authorization, then delete under this actual UPDATE lock.
    await holder.query('SELECT id FROM "session" WHERE id=$1 FOR UPDATE',[p[0].sessionId]);let waiter,privateQueries=0;
    const tracked={...db,transaction:work=>db.transaction(async tx=>{waiter=(await tx.query('SELECT pg_backend_pid() pid')).rows[0].pid;return work({query(sql,args){if(sql.includes('FROM hard_questions'))privateQueries++;return tx.query(sql,args);}});})};
    pending=readHardQuestion(tracked,p[0],{...scope,questionId:q.id});pending.catch(()=>{});await observedWait(f,()=>waiter,locker);
    await holder.query('DELETE FROM "session" WHERE id=$1',[p[0].sessionId]);await holder.query('COMMIT');holder.release();holder=null;
    assert.deepEqual(await pending,{ok:false,error:'unavailable'});pending=null;assert.equal(privateQueries,0);
    assert.equal((await f.domainPool.query('SELECT version FROM hard_questions WHERE id=$1',[q.id])).rows[0].version,1);
  }finally{if(holder){await holder.query('ROLLBACK');holder.release();}if(pending)await pending.catch(()=>{});await f.close();}
});
