import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDisputesHttpFixture } from './disputes-http-fixture.mjs';
const bodyFree = value => assert.equal(/"(?:claim|condition|text|body)"\s*:/.test(JSON.stringify(value)), false);

test('official-auth HTTP disputes: default-off, strict JSON, shared terms, consent, verdict, withdrawal and terminal replay', async () => {
  const f = await createDisputesHttpFixture();
  try {
    const accounts = [];
    for (let n = 0; n < 4; n++) {
      const response = await fetch(f.baseURL + '/api/auth/sign-up/email', { method: 'POST',
        headers: { origin: f.baseURL, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Synthetic', email: `dispute-http-${n}@example.test`, password: 'Synthetic-dispute-password-42!' }),
        signal: globalThis.AbortSignal.timeout(5000) });
      assert.equal(response.status, 200);
      accounts.push({ ...await response.json(), cookie: response.headers.getSetCookie().map(v => v.split(';')[0]).join('; ') });
    }
    const couple = randomUUID(), other = randomUUID();
    await f.provision(accounts.slice(0, 2).map(a => a.user.id), couple);
    await f.provision(accounts.slice(2).map(a => a.user.id), other);
    const base = `${f.baseURL}/v1/couples/${couple}/disputes`;
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
    const creation = { membership_epoch: 1, command_id: randomUUID(), confirm: true,
      claim: 'Synthetic shared claim', condition: 'Optional nonbinding activity', judge_date: '2026-11-11', timezone: 'Europe/Moscow' };
    for (const raw of [JSON.stringify(creation).slice(0, -1) + ',"command_\\u0069d":"' + creation.command_id + '"}',
      JSON.stringify(creation).replace('"confirm":true', '"confirm":false,"confirm":true'),
      JSON.stringify(creation).replace('"condition":"Optional nonbinding activity"', '"condition":{"a":1,"\\u0061":2}')]) {
      assert.equal((await call(0, '', 'POST', creation, raw)).status, 400);
    }
    assert.equal(Number((await f.domainPool.query('SELECT count(*) n FROM disputes')).rows[0].n), 0);
    // Ignore the first successful acknowledgement, simulating its loss to the caller.
    const ignored = await call(0, '', 'POST', creation); assert.equal(ignored.status, 200); bodyFree(ignored.result);
    const made = await call(0, '', 'POST', creation); assert.equal(made.status, 200); assert.equal(made.result.value.replay, true); bodyFree(made.result);
    const id = made.result.value.dispute.id, text = `/${id}/text?membership_epoch=1`;
    assert.equal(Number((await f.domainPool.query('SELECT count(*) n FROM disputes')).rows[0].n), 1);
    for (const actor of [0, 1]) {
      bodyFree((await call(actor)).result);
      const read = await call(actor, text); assert.equal(read.status, 200);
      assert.equal(read.result.value.claim, creation.claim); assert.equal(read.result.value.condition, creation.condition);
    }
    assert.equal((await call(2, text)).status, 403); assert.equal((await call(null, text)).status, 401);
    const command = version => ({ membership_epoch: 1, command_id: randomUUID(), expected_version: version, confirm: true });
    const join = command(1);
    assert.equal((await call(0, `/${id}/join`, 'POST', join)).status, 403);
    const joined = await call(1, `/${id}/join`, 'POST', join); assert.equal(joined.status, 200); bodyFree(joined.result);
    const resolve = { ...command(2), winner_id: null };
    assert.equal((await call(0, `/${id}/resolve`, 'POST', resolve)).status, 409);
    // A second dispute may be withdrawn after joining, without recording a loss.
    const second = await call(0, '', 'POST', { ...creation, command_id: randomUUID(), condition: null });
    assert.equal(second.status, 200); const withdrawalId = second.result.value.dispute.id;
    assert.equal((await call(1, `/${withdrawalId}/join`, 'POST', command(1))).status, 200);
    f.setFeatureTime('2026-11-10T21:00:00.000Z');
    const verdict = await call(0, `/${id}/resolve`, 'POST', resolve); assert.equal(verdict.status, 200); bodyFree(verdict.result);
    assert.equal(verdict.result.value.dispute.winnerId, null); assert.equal(verdict.result.value.dispute.decisionState, 'resolved');
    assert.equal((await call(1, `/${id}/decline`, 'POST', command(3))).status, 409);
    const withdrawal = await call(1, `/${withdrawalId}/decline`, 'POST', command(2));
    assert.equal(withdrawal.status, 200); bodyFree(withdrawal.result);
    assert.equal(withdrawal.result.value.dispute.winnerId, null); assert.equal(withdrawal.result.value.dispute.resolvedAt, null);
    assert.equal(withdrawal.result.value.dispute.decisionState, 'declined');
    const remove = command(3);
    assert.equal((await call(1, `/${id}`, 'DELETE', remove)).status, 403);
    const removed = await call(0, `/${id}`, 'DELETE', remove); assert.equal(removed.status, 200); bodyFree(removed.result);
    for (const replay of [await call(0, '', 'POST', creation), await call(1, `/${id}/join`, 'POST', join), await call(0, `/${id}/resolve`, 'POST', resolve)]) {
      assert.equal(replay.status, 200); assert.equal(replay.result.value.replay, true); bodyFree(replay.result);
      assert.equal(replay.result.value.dispute.contentState, 'removed');
    }
    bodyFree((await call(1, text)).result);
    assert.deepEqual((await f.domainPool.query('SELECT claim,condition FROM disputes WHERE id=$1', [id])).rows[0], { claim: null, condition: null });
    await f.authPool.query('UPDATE "session" SET "expiresAt"=clock_timestamp()-interval \'1 second\' WHERE "userId"=$1', [accounts[0].user.id]);
    assert.equal((await call(0, text)).status, 401);
  } finally { await f.close(); }
});
