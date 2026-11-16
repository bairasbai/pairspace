import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDailyQuestionsMobileFixture } from './daily-question-mobile-fixture.mjs';
import { client } from './composed-fixture.mjs';
import { mobile, password, closeMobile } from './mobile-invitations-fixture.mjs';
import { barrierOrCompletion, observeTask } from './async-bounds.mjs';

// Actual controller + HTTP + official Better Auth + PostgreSQL. Not native/device I/O.
test('daily mobile: explicit reciprocal reads, immutable retries, tombstones, historical disclosure and lifecycle fences', async () => {
 const f = await createDailyQuestionsMobileFixture(), accounts = [], identities = [], writes = [], tasks = [];
 let loseCreate = true, loseRewrite = true, loseRemove = true, holdRead = false, releaseRead, readReady;
 const reached = new Promise(resolve => { readReady = resolve; }), held = new Promise(resolve => { releaseRead = resolve; });
 try {
  for (let n = 0; n < 4; n++) {
   const result = await client(f.baseURL).auth.signUp.email({ email: `daily-mobile-${n}@example.test`, password, name: 'Synthetic' });
   assert.equal(result.error === null, true); identities.push(result.data.user.id);
  }
  const pair = randomUUID();
  await f.provision(identities.slice(0, 2), pair); await f.provision(identities.slice(2), randomUUID());
  const path = `/v1/couples/${pair}/daily-questions`;
  const hooks = index => ({ email: `daily-mobile-${index}@example.test`, signup: false,
   beforeRequest: async (record, request) => {
    if (!record.path.includes('/daily-questions') || record.method === 'GET') return;
    const payload = await request.clone().json(); writes.push({ actor: index, path: record.path, method: record.method, payload });
    assert.equal(request.headers.get('idempotency-key'), payload.command_id);
    for (const forbidden of ['timezone', 'clock', 'trustedNow', 'day', 'prompt_id']) assert.equal(Object.hasOwn(payload, forbidden), false);
   },
   afterResponse: async (record, response) => {
    if (!record.path.includes('/daily-questions') || response.status !== 200) return;
    assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    if (!record.path.endsWith('/text')) assert.equal(/"(?:text|body)":/.test(JSON.stringify((await response.clone().json()).value)), false);
    if (index === 0 && record.method === 'POST' && loseCreate) { loseCreate = false; throw Error('Synthetic lost create ACK'); }
    if (index === 0 && record.method === 'PUT' && loseRewrite) { loseRewrite = false; throw Error('Synthetic lost rewrite ACK'); }
    if (index === 0 && record.method === 'DELETE' && loseRemove) { loseRemove = false; throw Error('Synthetic lost removal ACK'); }
    if (record.path.endsWith('/text') && holdRead) { holdRead = false; readReady(); await held; }
   } });
  accounts.push(await mobile(f, 0, hooks(0)), await mobile(f, 1, hooks(1)),
   await mobile(f, 2, { email: 'daily-mobile-2@example.test', signup: false }));
  const [author, partner, foreign] = accounts.map(account => account.controller.dailyQuestions);
  const headers = async index => ({ cookie: await accounts[index].connection.getCookie(), origin: f.baseURL });
  assert.equal(accounts.every(account => !account.requests.some(record => record.path.includes('/daily-questions'))), true);
  await author.refresh(); await partner.refresh();
  assert.equal(author.getSnapshot().today.day, '2026-11-10');
  partner.setDraft('Synthetic partner answer'); await partner.create(true);
  const partnerAnswer = partner.getSnapshot().slots[0].answers.find(answer => answer.authorId === partner.getSnapshot().userId);
  assert.ok(partnerAnswer);
  await author.refresh(); assert.equal(author.getSnapshot().reader, null);
  const beforeSkipped = accounts[0].requests.length; await author.read(partnerAnswer.id);
  author.setDraft('Synthetic unsubmitted draft'); await author.read(partnerAnswer.id); author.cancelDraft(); await author.read(partnerAnswer.id);
  assert.equal(accounts[0].requests.length, beforeSkipped, 'skip and draft never unlock or trigger body GET');
  author.setDraft('Synthetic original own answer'); await author.create(false); assert.equal(writes.filter(write => write.actor === 0).length, 0);
  await author.create(true); assert.equal(author.getSnapshot().pending, true); assert.equal(author.getSnapshot().draft, '');
  const beforeUnknownRead = accounts[0].requests.length; await author.read(partnerAnswer.id); assert.equal(accounts[0].requests.length, beforeUnknownRead);
  author.setDraft('Synthetic distinct newer draft'); await author.retry();
  assert.equal(author.getSnapshot().draft, 'Synthetic distinct newer draft'); assert.equal(author.getSnapshot().reader, null);
  const creates = writes.filter(write => write.actor === 0 && write.method === 'POST'); assert.deepEqual(creates[0].payload, creates[1].payload);
  const own = author.getSnapshot().slots[0].answers.find(answer => answer.authorId === author.getSnapshot().userId); assert.ok(own);
  await author.read(partnerAnswer.id); assert.equal(author.getSnapshot().reader?.text, 'Synthetic partner answer');
  assert.equal(author.getSnapshot().reader.answer.id, partnerAnswer.id); author.close();
  const beforeRewrite = writes.length; author.setDraft('Synthetic own replacement'); await author.rewrite(own.id, true);
  assert.equal(writes.length, beforeRewrite, 'rewrite requires explicit own current-version read');
  await author.read(own.id); assert.equal(author.getSnapshot().reader?.text, 'Synthetic original own answer');
  assert.equal(author.getSnapshot().draft, 'Synthetic own replacement', 'read does not seed or overwrite a draft');
  await author.rewrite(own.id, true); assert.equal(author.getSnapshot().pending, true); assert.equal(author.getSnapshot().reader, null);
  // Another client can rewrite today. The original retry must return CURRENT metadata,
  // not replay the old body or overwrite the later revision.
  const rawCommand = randomUUID();
  const rawRewrite = await fetch(`${f.baseURL}${path}/answers/${own.id}`, { method: 'PUT',
   headers: { ...await headers(0), 'content-type': 'application/json', 'idempotency-key': rawCommand },
   body: JSON.stringify({ membership_epoch: 1, command_id: rawCommand, expected_version: 2, confirm: true, text: 'Synthetic externally rewritten answer' }) });
  assert.equal(rawRewrite.status, 200); await author.retry();
  assert.equal(author.getSnapshot().slots[0].answers.find(answer => answer.id === own.id).version, 3);
  const rewrites = writes.filter(write => write.actor === 0 && write.method === 'PUT'); assert.deepEqual(rewrites[0].payload, rewrites[1].payload);
  assert.equal(author.getSnapshot().reader, null);
  await author.read(partnerAnswer.id); assert.notEqual(author.getSnapshot().reader, null);
  await author.remove(own.id, true); assert.equal(author.getSnapshot().reader, null); assert.equal(author.getSnapshot().status, 'retry');
  const beforePendingRead = accounts[0].requests.length; await author.read(partnerAnswer.id); assert.equal(accounts[0].requests.length, beforePendingRead);
  author.leaveScreen(); assert.equal(author.getSnapshot().pending, false); assert.equal(author.getSnapshot().draft, '');
  const beforeRetry = writes.length; await author.retry(); assert.equal(writes.length, beforeRetry);
  await author.refresh();
  assert.equal(author.getSnapshot().slots[0].answers.find(answer => answer.id === own.id).contentState, 'removed');
  const beforeRemovedRead = accounts[0].requests.length; await author.read(partnerAnswer.id); assert.equal(accounts[0].requests.length, beforeRemovedRead);
  assert.equal((await f.domainPool.query('SELECT text FROM daily_question_answers WHERE id=$1', [own.id])).rows[0].text, null);
  author.setDraft('Cannot recreate terminal answer'); await author.create(true); assert.equal(writes.length, beforeRetry);
  const rawRead = async index => fetch(`${f.baseURL}${path}/answers/${partnerAnswer.id}/text?membership_epoch=1`,
   { headers: index === null ? { origin: f.baseURL } : await headers(index) });
  assert.equal((await rawRead(2)).status, 403); assert.equal((await rawRead(null)).status, 401);
  const hidden = await rawRead(0); assert.equal(hidden.status, 200); assert.equal(Object.hasOwn((await hidden.json()).value, 'text'), false);
  // Next shared day opens historical active answers even after one's own deletion.
  f.setFeatureTime('2026-11-11T00:00:00.000Z'); await author.refresh(); await author.read(partnerAnswer.id);
  assert.equal(author.getSnapshot().reader?.text, 'Synthetic partner answer'); author.close();
  holdRead = true; const delayed = observeTask(author.read(partnerAnswer.id)); tasks.push(delayed);
  await barrierOrCompletion(reached, delayed); author.leaveScreen(); releaseRead(); await delayed;
  assert.equal(author.getSnapshot().reader, null); assert.equal(author.getSnapshot().slots.length, 0);
  await author.refresh(); author.setDraft('Synthetic stale-day creation');
  f.setFeatureTime('2026-11-12T00:00:00.000Z');
  await author.create(true); assert.equal(author.getSnapshot().status, 'conflict'); assert.equal(author.getSnapshot().pending, false);
  assert.equal(author.getSnapshot().requiresRefresh, true); assert.equal(author.getSnapshot().draft, '');
  assert.equal(Number((await f.domainPool.query('SELECT count(*) n FROM daily_question_slots')).rows[0].n), 1, 'stale create never silently moves to new day');
  await author.refresh(); assert.equal(author.getSnapshot().today.day, '2026-11-12'); assert.equal(author.getSnapshot().slots.length, 1);
  // A later unknown create must also scrub its private retry payload on screen exit.
  loseCreate = true; author.setDraft('Synthetic new-day unknown payload'); await author.create(true); assert.equal(author.getSnapshot().pending, true);
  author.leaveScreen(); const writesBeforeExitRetry = writes.length; await author.retry(); assert.equal(writes.length, writesBeforeExitRetry);
  await author.refresh(); assert.equal(author.getSnapshot().slots.length, 2); assert.equal(author.getSnapshot().draft, '');
  await foreign.refresh(); assert.equal(foreign.getSnapshot().slots.length, 0);
  const leave = await fetch(f.baseURL + '/v1/pair/leave', { method: 'POST', headers: { ...await headers(0), 'content-type': 'application/json' },
   body: JSON.stringify({ coupleId: pair, membershipEpoch: 1, commandId: randomUUID(), confirm: true }) });
  assert.equal(leave.status, 200); await author.refresh(); assert.equal(author.getSnapshot().available, false);
  await accounts[0].controller.signOut(); assert.equal(author.getSnapshot().slots.length, 0); assert.equal(author.getSnapshot().reader, null);
 } finally { releaseRead(); await closeMobile(f, accounts, tasks); }
});
