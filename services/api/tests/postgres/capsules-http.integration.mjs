import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { toNodeHandler } from 'better-auth/node';
import { createFixture } from './fixture.mjs';
import { withDeadline } from './async-bounds.mjs';
import { createCapsulesHandler } from '../../src/capsules-http.ts';

test('real HTTP capsule with Better Auth: metadata-only ACK, owner-only due-gated read, retry and revocation', async () => {
  const f = await createFixture();
  let now = '2026-11-10T00:00:00.000Z';
  const handler = toNodeHandler(createCapsulesHandler(f.database(), () => new Date(now)));
  const server = createServer((req, res) => { void handler(req, res).catch(() => res.destroy()); });
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.timeout = 6000;
  try {
    await f.domainPool.query(await readFile(new URL('../../migrations/044_capsules.sql', import.meta.url), 'utf8'));
    const accounts = [];
    for (let n = 0; n < 4; n++) {
      const response = await f.call('sign-up/email', { name: 'Synthetic', email: `capsule-http-${n}@example.test`, password: 'Synthetic-capsule-password-42!' });
      assert.equal(response.status, 200);
      accounts.push({ ...await response.json(), cookie: response.headers.getSetCookie().map(v => v.split(';')[0]).join('; ') });
    }
    const couple = randomUUID(), other = randomUUID();
    await f.provision(accounts.slice(0, 2).map(a => a.user.id), couple);
    await f.provision(accounts.slice(2).map(a => a.user.id), other);
    await withDeadline(new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }), 3000, 'capsule HTTP listen');
    const base = `http://127.0.0.1:${server.address().port}/v1/couples/${couple}/capsules`;
    async function call(actor, suffix = '?membership_epoch=1', method = 'GET', payload) {
      const response = await fetch(base + suffix, { method, headers: { origin: 'http://localhost:3123',
        ...(actor === null ? {} : { cookie: accounts[actor].cookie }),
        ...(payload ? { 'content-type': 'application/json', 'idempotency-key': payload.command_id } : {}) },
      ...(payload ? { body: JSON.stringify(payload) } : {}), signal: globalThis.AbortSignal.timeout(5000) });
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      return { status: response.status, result: await response.json() };
    }
    const creation = { membership_epoch: 1, command_id: randomUUID(), confirm: true, text: 'Synthetic private future text',
      schedule: { localDate: '2026-11-11', localTime: '09:00', timezone: 'UTC', offset: '+00:00' } };
    const made = await call(0, '', 'POST', creation); assert.equal(made.status, 200);
    assert.equal(JSON.stringify(made.result).includes(creation.text), false);
    const id = made.result.value.capsule.id, text = `/${id}/text?membership_epoch=1`;
    assert.equal('text' in (await call(0, text)).result.value, false);
    assert.deepEqual((await call(1)).result.value.capsules, []);
    assert.equal((await call(1, text)).status, 403);
    assert.equal((await call(2, text)).status, 403); assert.equal((await call(null, text)).status, 401);
    const reseal = { ...creation, command_id: randomUUID(), expected_version: 1, text: 'Synthetic replacement private capsule' };
    assert.equal((await call(1, `/${id}`, 'PUT', reseal)).status, 403);
    const resealed = await call(0, `/${id}`, 'PUT', reseal); assert.equal(resealed.status, 200);
    assert.equal(JSON.stringify(resealed.result).includes(reseal.text), false);
    assert.equal((await call(0, `/${id}`, 'PUT', reseal)).result.value.replay, true);
    assert.equal('text' in (await call(0, text)).result.value, false);
    now = '2026-11-11T09:00:00.000Z';
    assert.equal((await call(0, text)).result.value.text, reseal.text);
    assert.equal((await call(1, text)).status, 403);
    assert.deepEqual((await call(1)).result.value.capsules, []);
    assert.equal(JSON.stringify((await call(0)).result).includes(reseal.text), false);
    assert.equal((await call(0, `/${id}`, 'PUT', { ...reseal, command_id: randomUUID(), expected_version: 2 })).status, 409);
    const removal = { membership_epoch: 1, command_id: randomUUID(), confirm: true, expected_version: 2 };
    assert.equal((await call(1, `/${id}`, 'DELETE', removal)).status, 403);
    const removed = await call(0, `/${id}`, 'DELETE', removal); assert.equal(removed.status, 200);
    assert.equal((await call(0, `/${id}`, 'DELETE', removal)).result.value.replay, true);
    const retry = await call(0, '', 'POST', creation);
    assert.equal(retry.result.value.capsule.contentState, 'removed'); assert.equal('text' in retry.result.value, false);
    assert.equal(JSON.stringify(retry.result).includes(creation.text), false);
    assert.equal('text' in (await call(0, text)).result.value, false);
    assert.equal((await f.domainPool.query('SELECT body FROM capsules WHERE id=$1', [id])).rows[0].body, null);
    await f.authPool.query('UPDATE "session" SET "expiresAt"=clock_timestamp()-interval \'1 second\' WHERE "userId"=$1', [accounts[0].user.id]);
    assert.equal((await call(0, text)).status, 401);
  } finally {
    server.closeIdleConnections();
    if (server.listening) await withDeadline(new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve())), 5000, 'capsule HTTP close');
    server.closeAllConnections(); await f.close();
  }
});
