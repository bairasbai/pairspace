import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPredictionsMobileFixture } from './predictions-mobile-fixture.mjs';
import { client } from './composed-fixture.mjs';
import { mobile, password, closeMobile } from './mobile-invitations-fixture.mjs';
import { barrierOrCompletion, observeTask } from './async-bounds.mjs';

// Actual HTTP, PostgreSQL and official provider cookies; no native/device claim.
test('real HTTP/mobile predictions: explicit calendar consent, lost ACKs, private reads and lifecycle fences', async () => {
  const f = await createPredictionsMobileFixture(), accounts = [], identities = [], creates = [], opens = [], pending = [];
  const body = 'Synthetic future prediction\nSecond paragraph';
  let loseCreate = true, loseOpen = true, holdRead = false, releaseRead, readReady;
  const reachedRead = new Promise(resolve => { readReady = resolve; });
  const heldRead = new Promise(resolve => { releaseRead = resolve; });
  try {
    for (let n = 0; n < 4; n++) {
      const c = client(f.baseURL);
      const result = await c.auth.signUp.email({ email: `prediction-mobile-${n}@example.test`, password, name: 'Synthetic' });
      assert.equal(result.error === null, true, 'official synthetic signup succeeds');
      identities.push(result.data.user.id);
    }
    const pair = randomUUID(), foreignPair = randomUUID();
    await f.provision(identities.slice(0, 2), pair); await f.provision(identities.slice(2), foreignPair);
    const path = `/v1/couples/${pair}/predictions`;
    const hooks = recipient => ({ email: `prediction-mobile-${recipient ? 1 : 0}@example.test`, signup: false,
      beforeRequest: async (record, request) => {
        if (!record.path.includes('/predictions') || record.method === 'GET') return;
        const payload = await request.clone().json();
        assert.equal(request.headers.get('idempotency-key'), payload.command_id);
        assert.equal(Object.hasOwn(payload, 'clock'), false);
        assert.equal(Object.hasOwn(payload, 'trustedNow'), false);
        if (record.path === path && record.method === 'POST') creates.push(payload);
        if (record.path.endsWith('/open')) { assert.equal(payload.confirm, true); opens.push(payload); }
      },
      afterResponse: async (record, response) => {
        if (!record.path.includes('/predictions') || response.status !== 200) return;
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
        const value = (await response.clone().json()).value;
        if (!record.path.endsWith('/text')) assert.equal(JSON.stringify(value).includes(body), false, 'lists and every command ACK omit body');
        if (!recipient && record.path === path && record.method === 'POST' && loseCreate) {
          loseCreate = false; throw Error('Synthetic lost committed create ACK');
        }
        if (recipient && record.path.endsWith('/open') && loseOpen) {
          loseOpen = false; throw Error('Synthetic lost committed open ACK');
        }
        if (recipient && record.path.endsWith('/text') && holdRead) {
          holdRead = false; readReady(); await heldRead;
        }
      } });
    accounts.push(await mobile(f, 0, hooks(false)), await mobile(f, 1, hooks(true)),
      await mobile(f, 2, { email: 'prediction-mobile-2@example.test', signup: false }));
    const [authorSession, recipientSession, foreignSession] = accounts.map(a => a.controller);
    const author = authorSession.predictions, recipient = recipientSession.predictions, foreign = foreignSession.predictions;
    assert.equal(accounts.every(a => !a.requests.some(r => r.path.includes('/predictions'))), true, 'sign-in does not silently load predictions');
    await author.load(); await recipient.load();
    author.setDraft(body);
    for (const [field, value] of Object.entries({ localDate: '2026-11-11', localTime: '09:00', timezone: 'Europe/Moscow', offset: '+03:00' })) author.setSchedule(field, value);
    await recipient.load(); assert.equal(recipient.getSnapshot().predictions.length, 0, 'draft remains in author RAM');
    const beforeCreate = creates.length;
    await author.create(false); assert.equal(creates.length, beforeCreate);
    await author.create(true); assert.equal(author.getSnapshot().status, 'retry');
    author.setDraft('Synthetic newer unsent draft');
    await author.retry(); assert.deepEqual(creates[0], creates[1]);
    assert.equal(author.getSnapshot().draft, 'Synthetic newer unsent draft');
    const prediction = author.getSnapshot().predictions[0];
    await author.read(prediction.id); assert.equal(author.getSnapshot().reader.text === body, true);
    await recipient.load(); assert.equal(recipient.getSnapshot().reader, null);
    const headers = async n => ({ cookie: await accounts[n].connection.getCookie(), origin: f.baseURL });
    const detail = `${f.baseURL}${path}/${prediction.id}/text?membership_epoch=1`;
    const rawRead = async n => fetch(detail, { headers: n === null ? { origin: f.baseURL } : await headers(n) });
    assert.equal('text' in (await (await rawRead(1)).json()).value, false);
    assert.equal((await rawRead(2)).status, 403); assert.equal((await rawRead(null)).status, 401);
    // The feature clock advances without changing actual session expiry time.
    f.setFeatureTime('2026-11-11T06:00:00.000Z');
    assert.equal('text' in (await (await rawRead(1)).json()).value, false, 'due alone does not grant consent');
    await recipient.load();
    await recipient.open(prediction.id, false); assert.equal(opens.length, 0);
    await recipient.open(prediction.id, true); assert.equal(recipient.getSnapshot().status, 'retry');
    recipient.close(); await recipient.retry(); assert.deepEqual(opens[0], opens[1]);
    assert.equal(recipient.getSnapshot().reader, null, 'close prevents retried ACK from displaying a reader');
    await recipient.read(prediction.id); assert.equal(recipient.getSnapshot().reader.text === body, true);
    recipient.close();
    holdRead = true;
    const delayed = observeTask(recipient.read(prediction.id)); pending.push(delayed);
    await barrierOrCompletion(reachedRead, delayed);
    recipient.close(); releaseRead(); await delayed;
    assert.equal(recipient.getSnapshot().reader, null, 'closed reader rejects a delayed private GET');
    await recipient.read(prediction.id); assert.equal(recipient.getSnapshot().reader.text === body, true);
    await author.load(); await author.remove(prediction.id, true);
    await recipient.load(); assert.equal(recipient.getSnapshot().reader, null);
    assert.equal(recipient.getSnapshot().predictions[0].contentState, 'removed');
    const replay = await fetch(`${f.baseURL}${path}/${prediction.id}/open`, { method: 'POST',
      headers: { ...await headers(1), 'content-type': 'application/json', 'idempotency-key': opens[0].command_id }, body: JSON.stringify(opens[0]) });
    assert.equal(replay.status, 200);
    const ack = (await replay.json()).value; assert.equal(ack.replay, true); assert.equal('text' in ack, false);
    assert.equal(ack.prediction.contentState, 'removed'); assert.equal('text' in (await (await rawRead(0)).json()).value, false);
    await author.load();
    author.setDraft('Synthetic optional prediction');
    for (const [field, value] of Object.entries({ localDate: '2026-11-12', localTime: '09:00', timezone: 'Europe/Moscow', offset: '+03:00' })) author.setSchedule(field, value);
    await author.create(true);
    assert.equal(author.getSnapshot().status, 'saved', 'second creation succeeds after refreshed metadata and complete schedule');
    await recipient.load();
    const optional = recipient.getSnapshot().predictions.find(q => q.contentState === 'active');
    assert.notEqual(optional, undefined, 'recipient receives the newly created optional prediction');
    await recipient.decline(optional.id, true);
    assert.equal(recipient.getSnapshot().predictions.find(q => q.id === optional.id).declinedAt !== null, true);
    await recipient.read(optional.id); assert.equal(recipient.getSnapshot().reader, null);
    // Refresh the recipient's decline version before explicitly reading as the author.
    await author.load();
    assert.notEqual(author.getSnapshot().predictions.find(q => q.id === optional.id).declinedAt, null);
    await author.read(optional.id);
    assert.notEqual(author.getSnapshot().reader, null, 'author can explicitly read their own declined prediction');
    assert.equal(author.getSnapshot().reader.text, 'Synthetic optional prediction');
    await author.load(); await author.remove(optional.id, true);
    await foreign.load(); assert.equal(foreign.getSnapshot().predictions.length, 0);
    author.setDraft('Synthetic local draft cleared on logout');
    const leave = await fetch(f.baseURL + '/v1/pair/leave', { method: 'POST', headers: { ...await headers(0), 'content-type': 'application/json' },
      body: JSON.stringify({ coupleId: pair, membershipEpoch: 1, commandId: randomUUID(), confirm: true }) });
    assert.equal(leave.status, 200);
    await recipient.load(); assert.equal(recipient.getSnapshot().available, false); assert.equal(recipient.getSnapshot().reader, null);
    await authorSession.refresh(); assert.equal(author.getSnapshot().draft, ''); assert.equal((await rawRead(0)).status, 403);
    await authorSession.signOut(); assert.equal(author.getSnapshot().predictions.length, 0); assert.equal(author.getSnapshot().reader, null);
  } finally { releaseRead(); await closeMobile(f, accounts, pending); }
});
