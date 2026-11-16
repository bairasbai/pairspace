import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDailyQuestionsHttpFixture } from './daily-questions-http-fixture.mjs';
const bodyFree = value => assert.equal(/"(?:text|body)"\s*:/.test(JSON.stringify(value)), false);

test('official-auth daily HTTP: pinned calendar, body-free receipts, explicit mutual read and terminal removal', async () => {
  const f = await createDailyQuestionsHttpFixture();
  try {
    const accounts = [];
    for (let n = 0; n < 4; n++) {
      const response = await fetch(f.baseURL + '/api/auth/sign-up/email', { method: 'POST',
        headers: { origin: f.baseURL, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Synthetic', email: `daily-http-${n}@example.test`, password: 'Synthetic-daily-password-42!' }),
        signal: globalThis.AbortSignal.timeout(5000) });
      assert.equal(response.status, 200);
      accounts.push({ ...await response.json(), cookie: response.headers.getSetCookie().map(v => v.split(';')[0]).join('; ') });
    }
    const couple = randomUUID(), other = randomUUID();
    await f.provision(accounts.slice(0, 2).map(a => a.user.id), couple);
    await f.provision(accounts.slice(2).map(a => a.user.id), other);
    const base = `${f.baseURL}/v1/couples/${couple}/daily-questions`;
    async function call(actor, suffix = '?membership_epoch=1', method = 'GET', payload, raw) {
      const response = await fetch(base + suffix, { method, headers: { origin: f.baseURL,
        ...(actor === null ? {} : { cookie: accounts[actor].cookie }),
        ...(payload ? { 'content-type': 'application/json', 'idempotency-key': payload.command_id } : {}) },
        ...(payload ? { body: raw ?? JSON.stringify(payload) } : {}), signal: globalThis.AbortSignal.timeout(5000) });
      assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      return { status: response.status, result: await response.json() };
    }
    assert.equal((await call(0)).status, 404); f.configure(true);
    assert.equal((await call(null)).status, 401); assert.equal((await call(2)).status, 403);
    const initial = await call(0); assert.equal(initial.status, 200); bodyFree(initial.result);
    assert.equal(initial.result.value.today.timezone, 'Europe/Moscow'); assert.deepEqual(initial.result.value.slots, []);
    assert.equal(Number((await f.domainPool.query('SELECT count(*) n FROM daily_question_slots')).rows[0].n), 0);
    assert.equal(Number((await f.domainPool.query('SELECT count(*) n FROM daily_question_zones')).rows[0].n), 0);
    const creation = { membership_epoch: 1, command_id: randomUUID(), confirm: true, expected_day: '2026-11-10', text: 'Synthetic daily private answer' };
    for (const raw of [JSON.stringify(creation).slice(0, -1) + ',"te\\u0078t":"changed"}',
      JSON.stringify(creation).replace('"confirm":true', '"confirm":false,"confirm":true'),
      JSON.stringify(creation).replace('"text":"Synthetic daily private answer"', '"text":{"x":1,"\\u0078":2}')]) {
      assert.equal((await call(0, '', 'POST', creation, raw)).status, 400);
    }
    assert.equal((await call(0, '', 'POST', { ...creation, timezone: 'UTC' })).status, 400);
    assert.equal((await call(0, '?membership_epoch=1&timezone=UTC')).status, 400);
    assert.equal((await call(0, '?membership_epoch=1&membership_%65poch=1')).status, 400);
    assert.equal(Number((await f.domainPool.query('SELECT count(*) n FROM daily_question_answers')).rows[0].n), 0);
    // Ignore one successful ACK, then retry the same command rather than creating twice.
    const ignored = await call(0, '', 'POST', creation); assert.equal(ignored.status, 200); bodyFree(ignored.result);
    const created = await call(0, '', 'POST', creation); assert.equal(created.status, 200); bodyFree(created.result);
    assert.equal(created.result.value.replay, true);
    const answerId = created.result.value.answer.id, path = `/answers/${answerId}`, textPath = path + '/text?membership_epoch=1';
    assert.equal(Number((await f.domainPool.query('SELECT count(*) n FROM daily_question_answers')).rows[0].n), 1);
    assert.equal((await call(0, textPath)).result.value.text, creation.text);
    bodyFree((await call(1, textPath)).result); bodyFree((await call(1)).result);
    assert.equal((await call(2, textPath)).status, 403); assert.equal((await call(null, textPath)).status, 401);
    const rewrite = { membership_epoch: 1, command_id: randomUUID(), confirm: true, expected_version: 1, text: 'Synthetic revised daily answer' };
    assert.equal((await call(1, path, 'PUT', rewrite)).status, 403);
    const edited = await call(0, path, 'PUT', rewrite); assert.equal(edited.status, 200); bodyFree(edited.result);
    const ownPartner = await call(1, '', 'POST', { ...creation, command_id: randomUUID(), text: 'Synthetic partner answer' });
    assert.equal(ownPartner.status, 200); bodyFree(ownPartner.result);
    assert.equal((await call(1, textPath)).result.value.text, rewrite.text);
    const partnerPath = `/answers/${ownPartner.result.value.answer.id}`;
    const partnerRemoval = { membership_epoch: 1, command_id: randomUUID(), confirm: true, expected_version: 1 };
    assert.equal((await call(1, partnerPath, 'DELETE', partnerRemoval)).status, 200);
    bodyFree((await call(1, textPath)).result);
    assert.equal((await call(1, '', 'POST', { ...creation, command_id: randomUUID() })).status, 409);
    // Configuration changes do not move the first-mutation pinned pair calendar.
    f.setFeatureZone('UTC'); f.setFeatureTime('2026-11-10T21:30:00.000Z');
    const next = await call(0); assert.equal(next.result.value.today.timezone, 'Europe/Moscow'); assert.equal(next.result.value.today.day, '2026-11-11'); bodyFree(next.result);
    assert.equal((await call(1, textPath)).result.value.text, rewrite.text);
    assert.equal((await call(0, path, 'PUT', { ...rewrite, command_id: randomUUID(), expected_version: 2 })).status, 409);
    const removal = { membership_epoch: 1, command_id: randomUUID(), confirm: true, expected_version: 2 };
    assert.equal((await call(0, path, 'DELETE', removal)).status, 200);
    for (const replay of [await call(0, '', 'POST', creation), await call(0, path, 'PUT', rewrite)]) {
      assert.equal(replay.status, 200); assert.equal(replay.result.value.replay, true); bodyFree(replay.result);
      assert.equal(replay.result.value.answer.contentState, 'removed');
    }
    bodyFree((await call(0, textPath)).result);
    assert.equal((await f.domainPool.query('SELECT text FROM daily_question_answers WHERE id=$1', [answerId])).rows[0].text, null);
    const history = await call(0, '?membership_epoch=1&before_day=2026-11-11'); assert.equal(history.status, 200); bodyFree(history.result);
    await f.authPool.query('UPDATE "session" SET "expiresAt"=clock_timestamp()-interval \'1 second\' WHERE "userId"=$1', [accounts[0].user.id]);
    assert.equal((await call(0, textPath)).status, 401);
  } finally { await f.close(); }
});
