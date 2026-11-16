import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDisputesMobileFixture } from './disputes-mobile-fixture.mjs';
import { client } from './composed-fixture.mjs';
import { mobile, password, closeMobile } from './mobile-invitations-fixture.mjs';
import { barrierOrCompletion, observeTask } from './async-bounds.mjs';

// Production controller + real HTTP + official Better Auth + PostgreSQL; not native I/O.
test('dispute mobile: explicit terms/read/join, lost ACK current replay, draw, removal and lifecycle privacy', async () => {
 const f = await createDisputesMobileFixture(), accounts = [], identities = [], writes = [], tasks = [];
 let loseCreate = true, loseJoin = true, loseResolve = true, loseRemove = true;
 let holdRead = false, releaseRead, readReady;
 const reached = new Promise(resolve => { readReady = resolve; });
 const held = new Promise(resolve => { releaseRead = resolve; });
 const claim = 'Synthetic voluntary shared claim', condition = 'Synthetic optional nonbinding condition';
 const setForm = (actions, text, optional, date) => {
  actions.setClaim(text); actions.setCondition(optional); actions.setJudgeDate(date); actions.setTimezone('UTC');
 };
 try {
  for (let n = 0; n < 4; n++) {
   const result = await client(f.baseURL).auth.signUp.email({ email: `dispute-mobile-${n}@example.test`, password, name: 'Synthetic' });
   assert.equal(result.error === null, true); identities.push(result.data.user.id);
  }
  const pair = randomUUID();
  await f.provision(identities.slice(0, 2), pair); await f.provision(identities.slice(2), randomUUID());
  const path = `/v1/couples/${pair}/disputes`;
  const hooks = index => ({ email: `dispute-mobile-${index}@example.test`, signup: false,
   beforeRequest: async (record, request) => {
    if (!record.path.includes('/disputes') || record.method === 'GET') return;
    const payload = await request.clone().json(); writes.push({ actor: index, path: record.path, method: record.method, payload });
    assert.equal(request.headers.get('idempotency-key'), payload.command_id);
    assert.equal(Object.hasOwn(payload, 'clock'), false); assert.equal(Object.hasOwn(payload, 'trustedNow'), false);
   },
   afterResponse: async (record, response) => {
    if (!record.path.includes('/disputes') || response.status !== 200) return;
    assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    const value = (await response.clone().json()).value;
    if (!record.path.endsWith('/text')) assert.equal(/"(?:claim|condition)":/.test(JSON.stringify(value)), false, 'metadata-only response has neither private term');
    if (record.path === path && record.method === 'POST' && loseCreate) { loseCreate = false; throw Error('Synthetic lost create ACK'); }
    if (record.path.endsWith('/join') && loseJoin) { loseJoin = false; throw Error('Synthetic lost join ACK'); }
    if (record.path.endsWith('/resolve') && loseResolve) { loseResolve = false; throw Error('Synthetic lost verdict ACK'); }
    if (record.method === 'DELETE' && loseRemove) { loseRemove = false; throw Error('Synthetic lost removal ACK'); }
    if (record.path.endsWith('/text') && holdRead) { holdRead = false; readReady(); await held; }
   } });
  accounts.push(await mobile(f, 0, hooks(0)), await mobile(f, 1, hooks(1)),
   await mobile(f, 2, { email: 'dispute-mobile-2@example.test', signup: false }));
  const [author, recipient, foreign] = accounts.map(account => account.controller.disputes);
  const headers = async index => ({ cookie: await accounts[index].connection.getCookie(), origin: f.baseURL });
  assert.equal(accounts.every(account => !account.requests.some(record => record.path.includes('/disputes'))), true, 'sign-in does not silently fetch terms');
  await author.refresh(); await recipient.refresh();
  setForm(author, claim, condition, '2026-11-11');
  await author.create(false); assert.equal(writes.length, 0);
  await author.create(true); assert.equal(author.getSnapshot().status, 'retry'); assert.equal(author.getSnapshot().pending, true);
  assert.equal(author.getSnapshot().draftClaim, ''); assert.equal(author.getSnapshot().draftCondition, '');
  const stored = (await f.domainPool.query('SELECT id FROM disputes')).rows[0];
  await recipient.refresh(); assert.equal(recipient.getSnapshot().disputes.length, 1); assert.equal(recipient.getSnapshot().reader, null);
  await recipient.join(stored.id, true); assert.equal(writes.length, 1, 'join cannot bypass explicit current-version terms read');
  await recipient.read(stored.id);
  assert.equal(recipient.getSnapshot().reader?.claim === claim, true); assert.equal(recipient.getSnapshot().reader?.condition === condition, true);
  await recipient.join(stored.id, false); assert.equal(writes.length, 1);
  await recipient.join(stored.id, true); assert.equal(recipient.getSnapshot().status, 'retry'); assert.equal(recipient.getSnapshot().reader, null);
  // Create retry must accept CURRENT joined metadata while proving the original create.
  author.setClaim('Synthetic newer unsent draft'); author.setCondition('Synthetic new optional draft');
  await author.retry(); assert.equal(author.getSnapshot().status, 'saved');
  assert.equal(author.getSnapshot().disputes[0].decisionState, 'joined');
  assert.equal(author.getSnapshot().draftClaim, 'Synthetic newer unsent draft');
  const createWrites = writes.filter(write => write.path === path);
  assert.deepEqual(createWrites[0].payload, createWrites[1].payload);
  await recipient.retry(); assert.equal(recipient.getSnapshot().status, 'saved'); assert.equal(recipient.getSnapshot().reader, null);
  const joinWrites = writes.filter(write => write.path.endsWith('/join'));
  assert.deepEqual(joinWrites[0].payload, joinWrites[1].payload);
  const rawRead = async index => fetch(`${f.baseURL}${path}/${stored.id}/text?membership_epoch=1`,
   { headers: index === null ? { origin: f.baseURL } : await headers(index) });
  assert.equal((await rawRead(2)).status, 403); assert.equal((await rawRead(null)).status, 401);
  await author.read(stored.id);
  const beforeVerdict = writes.length; await author.resolve(stored.id, null, true);
  assert.equal(author.getSnapshot().status, 'not_due'); assert.equal(writes.length, beforeVerdict);
  author.close(); f.setFeatureTime('2026-11-11T00:00:00.000Z');
  await author.refresh(); await author.resolve(stored.id, null, true);
  assert.equal(writes.length, beforeVerdict, 'due verdict cannot bypass explicit current-version terms read');
  await author.read(stored.id); assert.equal(author.getSnapshot().reader?.dispute.version, 2);
  await author.resolve(stored.id, null, false); assert.equal(writes.length, beforeVerdict);
  await author.resolve(stored.id, null, true); assert.equal(author.getSnapshot().status, 'retry');
  await recipient.refresh();
  const resolved = recipient.getSnapshot().disputes[0];
  assert.equal(resolved.decisionState, 'resolved'); assert.equal(resolved.winnerId, null);
  assert.equal(typeof resolved.resolvedAt, 'string'); assert.equal(resolved.resolvedBy, author.getSnapshot().userId);
  await author.retry(); assert.equal(author.getSnapshot().status, 'saved');
  const verdictWrites = writes.filter(write => write.path.endsWith('/resolve'));
  assert.deepEqual(verdictWrites[0].payload, verdictWrites[1].payload);
  const afterVerdict = writes.length; await recipient.decline(stored.id, true); await author.resolve(stored.id, resolved.authorId, true);
  assert.equal(writes.length, afterVerdict, 'one final outcome cannot be rewritten or declined afterward');
  await recipient.read(stored.id); assert.equal(recipient.getSnapshot().reader?.claim === claim, true); recipient.close();
  holdRead = true; const delayed = observeTask(recipient.read(stored.id)); tasks.push(delayed);
  await barrierOrCompletion(reached, delayed); recipient.leaveScreen(); releaseRead(); await delayed;
  assert.equal(recipient.getSnapshot().reader, null); assert.equal(recipient.getSnapshot().draftClaim, ''); assert.equal(recipient.getSnapshot().draftCondition, '');
  await author.read(stored.id); assert.notEqual(author.getSnapshot().reader, null);
  await author.remove(stored.id, true); assert.equal(author.getSnapshot().reader, null); assert.equal(author.getSnapshot().status, 'retry');
  author.leaveScreen(); assert.equal(author.getSnapshot().pending, false); assert.equal(author.getSnapshot().draftClaim, ''); assert.equal(author.getSnapshot().draftCondition, '');
  const beforeRetry = writes.length; await author.retry(); assert.equal(writes.length, beforeRetry);
  await author.refresh(); await recipient.refresh();
  assert.equal(author.getSnapshot().disputes[0].contentState, 'removed'); assert.equal(recipient.getSnapshot().disputes[0].contentState, 'removed');
  assert.deepEqual((await f.domainPool.query('SELECT claim,condition FROM disputes WHERE id=$1', [stored.id])).rows, [{ claim: null, condition: null }]);
  const removedResponse = await rawRead(1), removedBody = (await removedResponse.json()).value;
  assert.equal(removedResponse.status, 200); assert.equal(Object.hasOwn(removedBody, 'claim'), false); assert.equal(Object.hasOwn(removedBody, 'condition'), false);
  // An unknown CREATE contains private retry terms too: screen exit must drop them,
  // not silently resend or reconstruct them on return. Metadata refresh is sufficient.
  setForm(author, 'Synthetic second voluntary claim', '   ', '2026-11-12'); loseCreate = true;
  await author.create(true); assert.equal(author.getSnapshot().pending, true);
  author.leaveScreen(); assert.equal(author.getSnapshot().pending, false);
  assert.equal(author.getSnapshot().draftClaim, ''); assert.equal(author.getSnapshot().draftCondition, '');
  const beforeCreateRetry = writes.length; await author.retry(); assert.equal(writes.length, beforeCreateRetry);
  await author.refresh(); await recipient.refresh();
  const invited = recipient.getSnapshot().disputes.find(dispute => dispute.contentState === 'active');
  assert.ok(invited); assert.equal(invited.decisionState, 'invited');
  await recipient.read(invited.id); assert.equal(recipient.getSnapshot().reader?.condition, null);
  f.setFeatureTime('2026-11-12T00:00:00.000Z'); await recipient.refresh();
  const beforeLateJoin = writes.length; await recipient.join(invited.id, true); assert.equal(writes.length, beforeLateJoin);
  await recipient.decline(invited.id, true);
  const declined = recipient.getSnapshot().disputes.find(dispute => dispute.id === invited.id);
  assert.equal(declined.decisionState, 'declined'); assert.equal(declined.winnerId, null); assert.equal(declined.resolvedAt, null);
  await foreign.refresh(); assert.equal(foreign.getSnapshot().disputes.length, 0);
  const leave = await fetch(f.baseURL + '/v1/pair/leave', { method: 'POST',
   headers: { ...await headers(0), 'content-type': 'application/json' },
   body: JSON.stringify({ coupleId: pair, membershipEpoch: 1, commandId: randomUUID(), confirm: true }) });
  assert.equal(leave.status, 200);
  await author.refresh(); assert.equal(author.getSnapshot().available, false); assert.equal(author.getSnapshot().disputes.length, 0);
  await accounts[0].controller.signOut(); assert.equal(author.getSnapshot().reader, null);
 } finally { releaseRead(); await closeMobile(f, accounts, tasks); }
});
