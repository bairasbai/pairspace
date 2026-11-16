import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createCapsulesMobileFixture } from './capsules-mobile-fixture.mjs';
import { client } from './composed-fixture.mjs';
import { mobile, password, closeMobile } from './mobile-invitations-fixture.mjs';
import { barrierOrCompletion, observeTask } from './async-bounds.mjs';

// Actual controller + HTTP + official auth + PostgreSQL; not native I/O.
test('personal capsule mobile: unknown ACK retries, reseal replay, time lock and lifecycle privacy', async () => {
  const f = await createCapsulesMobileFixture(), accounts = [], identities = [], writes = [], tasks = [];
  let loseCreate = true, loseReseal = true, loseRemove = true, holdRead = false, releaseRead, readReady;
  const reached = new Promise(resolve => { readReady = resolve; });
  const held = new Promise(resolve => { releaseRead = resolve; });
  const schedule = { localDate: '2026-11-11', localTime: '09:00', timezone: 'Europe/Moscow', offset: '+03:00' };
  const setForm = (actions, text, date) => {
    actions.setDraft(text);
    for (const [key, value] of Object.entries({ ...schedule, localDate: date })) actions.setSchedule(key, value);
  };
  try {
    for (let n = 0; n < 4; n++) {
      const result = await client(f.baseURL).auth.signUp.email({ email: `capsule-mobile-${n}@example.test`, password, name: 'Synthetic' });
      assert.equal(result.error === null, true); identities.push(result.data.user.id);
    }
    const pair = randomUUID();
    await f.provision(identities.slice(0, 2), pair); await f.provision(identities.slice(2), randomUUID());
    const path = `/v1/couples/${pair}/capsules`;
    accounts.push(await mobile(f, 0, { email: 'capsule-mobile-0@example.test', signup: false,
      beforeRequest: async (record, request) => {
        if (!record.path.includes('/capsules') || record.method === 'GET') return;
        const payload = await request.clone().json(); writes.push({ method: record.method, payload });
        assert.equal(request.headers.get('idempotency-key'), payload.command_id);
        assert.equal(Object.hasOwn(payload, 'clock'), false);
      },
      afterResponse: async (record, response) => {
        if (!record.path.includes('/capsules') || response.status !== 200) return;
        assert.equal(response.headers.get('cache-control'), 'no-store');
        const value = (await response.clone().json()).value;
        if (!record.path.endsWith('/text')) {
          assert.equal(Object.hasOwn(value, 'text'), false);
          assert.equal(JSON.stringify(value).includes('Synthetic private'), false);
        }
        if (record.method === 'POST' && loseCreate) { loseCreate = false; throw Error('Synthetic lost create ACK'); }
        if (record.method === 'PUT' && loseReseal) { loseReseal = false; throw Error('Synthetic lost reseal ACK'); }
        if (record.method === 'DELETE' && loseRemove) { loseRemove = false; throw Error('Synthetic lost remove ACK'); }
        if (record.path.endsWith('/text') && holdRead) { holdRead = false; readReady(); await held; }
      } }), await mobile(f, 1, { email: 'capsule-mobile-1@example.test', signup: false }),
      await mobile(f, 2, { email: 'capsule-mobile-2@example.test', signup: false }));
    const [owner, partner, foreign] = accounts.map(a => a.controller.capsules);
    const headers = async n => ({ cookie: await accounts[n].connection.getCookie(), origin: f.baseURL });
    assert.equal(accounts.every(a => !a.requests.some(r => r.path.includes('/capsules'))), true);
    await owner.load(); await partner.load();
    setForm(owner, 'Synthetic private first', '2026-11-11');
    await owner.create(false); assert.equal(writes.length, 0);
    await owner.create(true); assert.equal(owner.getSnapshot().status, 'retry');
    assert.equal(owner.getSnapshot().draft, '', 'submitted text is hidden even with unknown committed ACK');
    const stored = (await f.domainPool.query('SELECT id FROM capsules')).rows[0];
    const rawMutate = async (method, version, text, date) => {
      const command = randomUUID();
      const response = await fetch(f.baseURL + path + '/' + stored.id, { method,
        headers: { ...await headers(0), 'content-type': 'application/json', 'idempotency-key': command },
        body: JSON.stringify({ membership_epoch: 1, command_id: command, expected_version: version, confirm: true,
          ...(method === 'PUT' ? { text, schedule: { ...schedule, localDate: date } } : {}) }) });
      assert.equal(response.status, 200); return (await response.json()).value;
    };
    // Another client changed schedule while our create ACK was unknown. Replay is current metadata.
    await rawMutate('PUT', 1, 'Synthetic private second', '2026-11-13');
    owner.setDraft('Synthetic unsent edit');
    await owner.retry(); assert.equal(owner.getSnapshot().status, 'saved');
    assert.deepEqual(writes[0], writes[1]); assert.equal(owner.getSnapshot().draft, 'Synthetic unsent edit');
    assert.equal(owner.getSnapshot().capsules[0].version, 2);
    await owner.read(stored.id); assert.equal(owner.getSnapshot().reader, null);
    await partner.load(); assert.equal(partner.getSnapshot().capsules.length, 0);
    const rawRead = async n => fetch(f.baseURL + path + '/' + stored.id + '/text?membership_epoch=1',
      { headers: n === null ? { origin: f.baseURL } : await headers(n) });
    assert.equal((await rawRead(1)).status, 403); assert.equal((await rawRead(2)).status, 403); assert.equal((await rawRead(null)).status, 401);
    await owner.load(); setForm(owner, 'Synthetic private third', '2026-11-14');
    await owner.reseal(stored.id, true); assert.equal(owner.getSnapshot().status, 'retry');
    assert.equal(owner.getSnapshot().draft, '', 'resealed replacement is hidden before ACK');
    await rawMutate('PUT', 3, 'Synthetic private fourth', '2026-11-15');
    await owner.retry(); assert.equal(owner.getSnapshot().status, 'saved');
    assert.deepEqual(writes[2], writes[3]); assert.equal(owner.getSnapshot().capsules[0].version, 4);
    assert.equal(owner.getSnapshot().reader, null);
    f.setFeatureTime('2026-11-15T06:00:00.000Z');
    await owner.load(); await owner.read(stored.id);
    assert.equal(owner.getSnapshot().reader?.text === 'Synthetic private fourth', true);
    owner.close(); holdRead = true;
    const delayed = observeTask(owner.read(stored.id)); tasks.push(delayed);
    await barrierOrCompletion(reached, delayed); owner.leaveScreen(); releaseRead(); await delayed;
    assert.equal(owner.getSnapshot().reader, null);
    await owner.load(); await owner.read(stored.id); assert.notEqual(owner.getSnapshot().reader, null);
    await owner.remove(stored.id, true); assert.equal(owner.getSnapshot().reader, null);
    assert.equal(owner.getSnapshot().status, 'retry');
    owner.leaveScreen(); assert.equal(owner.getSnapshot().draft, ''); assert.equal(owner.getSnapshot().pending, false);
    const beforeRetry = writes.length; await owner.retry(); assert.equal(writes.length, beforeRetry);
    await owner.load();
    assert.equal(owner.getSnapshot().capsules[0].contentState, 'removed');
    assert.equal((await f.domainPool.query('SELECT body FROM capsules WHERE id=$1', [stored.id])).rows[0].body, null);
    await owner.load(); setForm(owner, 'Synthetic extra', '2026-11-16'); await owner.create(true);
    assert.equal(owner.getSnapshot().status, 'limit');
    await foreign.load(); assert.equal(foreign.getSnapshot().capsules.length, 0);
    const leave = await fetch(f.baseURL + '/v1/pair/leave', { method: 'POST',
      headers: { ...await headers(0), 'content-type': 'application/json' },
      body: JSON.stringify({ coupleId: pair, membershipEpoch: 1, commandId: randomUUID(), confirm: true }) });
    assert.equal(leave.status, 200);
    await owner.load(); assert.equal(owner.getSnapshot().available, false); assert.equal(owner.getSnapshot().draft, '');
    await accounts[0].controller.signOut(); assert.equal(owner.getSnapshot().capsules.length, 0);
  } finally { releaseRead(); await closeMobile(f, accounts, tasks); }
});
