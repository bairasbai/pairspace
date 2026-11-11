import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { withDeadline } from './async-bounds.mjs';
import { lettersFixture } from './letters-fixture.mjs';
import { localConfiguration, verifyDisposable } from './guard.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function observer() {
  const configuration = localConfiguration(process.env);
  const pool = new Pool({ ...configuration.connection, max: 1 });
  try { await verifyDisposable(pool, configuration); return pool; }
  catch (error) { await pool.end(); throw error; }
}

test('fixture parallel accounts retain input order, independent cookies and schema isolation through cleanup', async t => {
  const fetch = globalThis.fetch;
  const completed = [];
  let releaseFirst;
  const othersFinished = new Promise(resolve => { releaseFirst = resolve; });
  t.mock.method(globalThis, 'fetch', async (request, init) => {
    if (new URL(request.url).pathname.endsWith('/sign-up/email')) {
      const { email } = await request.clone().json();
      const index = Number(email.match(/letters-(\d)/)[1]);
      if (index === 0) await withDeadline(othersFinished, 3000, 'Other signup completion');
      const response = await fetch(request, init);
      completed.push(index);
      if (completed.length === 3) releaseFirst();
      return response;
    }
    return fetch(request, init);
  });
  const a = await lettersFixture();
  let b;
  let aClosed = false;
  try {
    assert.equal(completed.length, 4);
    assert.notEqual(completed[0], 0, 'forced completion order differs from input order');
    assert.equal(new Set(await Promise.all(a.connections.map(c => c.getCookie()))).size, 4);
    for (let index = 0; index < 4; index++) {
      const { data: session, error } = await a.connections[index].auth.getSession();
      assert.equal(error, null); assert.ok(session);
      assert.equal(session.user.id, a.identities[index]);
      assert.equal(session.user.email, `letters-${index}@example.test`);
      const principal = await a.principal(index);
      assert.equal(principal.userId, [...a.usersA, ...a.usersB][index]);
    }
    b = await lettersFixture();
    assert.notEqual(a.f.schema, b.f.schema);
    assert.equal(a.identities.some(id => b.identities.includes(id)), false);
    const marker = randomUUID();
    await a.f.domainPool.query('INSERT INTO users(id) VALUES ($1)', [marker]);
    assert.equal((await b.f.domainPool.query('SELECT id FROM users WHERE id=$1', [marker])).rowCount, 0);
    await a.f.close(); aClosed = true;
    assert.equal((await b.f.admin.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [a.f.schema])).rowCount, 0);
    assert.equal((await b.f.domainPool.query('SELECT id FROM "user"')).rowCount, 4);
  } finally { if (!aClosed) await a.f.close(); if (b) await b.f.close(); }
});

test('fixture failed parallel signup waits for all real requests before dropping its schema and closing pools', async t => {
  const admin = await observer();
  const schemas = [];
  const query = Pool.prototype.query;
  const fetch = globalThis.fetch;
  let started = 0; let completed = 0; let active = 0;
  t.mock.method(Pool.prototype, 'query', function (...args) {
    const match = typeof args[0] === 'string' && args[0].match(/^CREATE SCHEMA (ps_case_[a-f0-9]{16})$/);
    if (match) schemas.push(match[1]);
    return query.apply(this, args);
  });
  t.mock.method(globalThis, 'fetch', async (request, init) => {
    if (!new URL(request.url).pathname.endsWith('/sign-up/email')) return fetch(request, init);
    const index = started++;
    if (index === 0) throw new Error('Synthetic first signup transport failure');
    active++;
    try {
      await delay(75);
      const response = await fetch(request, init);
      assert.equal(response.status, 200); completed++; return response;
    } finally { active--; }
  });
  try {
    await assert.rejects(lettersFixture());
    assert.equal(started, 4); assert.equal(completed, 3); assert.equal(active, 0);
    assert.equal(schemas.length, 1);
    assert.equal((await admin.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schemas[0]])).rowCount, 0);
    assert.equal((await admin.query('SELECT 1 FROM pg_stat_activity WHERE application_name=ANY($1)',
      [[`ps-auth-${schemas[0]}`, `ps-domain-${schemas[0]}`]])).rowCount, 0);
  } finally { await admin.end(); }
});
