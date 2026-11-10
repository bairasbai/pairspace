import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createComposedFixture, client } from './composed-fixture.mjs';
import { mobile, password, closeMobile } from './mobile-invitations-fixture.mjs';

test('real PostgreSQL: shared-date mobile immutable unknown ACK, separate new draft, explicit sharing and closure', async () => {
  const f = await createComposedFixture({ enableSyntheticSharedDates: true, enableSyntheticPairLeave: true });
  const accounts = [];
  try {
    const identities = [];
    for (let n = 0; n < 4; n++) {
      const connection = client(f.baseURL);
      const result = await connection.auth.signUp.email({ email: `date-mobile-${n}@example.test`, password, name: 'Synthetic' });
      assert.equal(result.error === null, true); identities.push(result.data.user.id);
    }
    const pairA = randomUUID(), pairB = randomUUID();
    await f.provision(identities.slice(0, 2), pairA); await f.provision(identities.slice(2), pairB);
    let drop = true; const commands = [];
    accounts.push(await mobile(f, 0, { email: 'date-mobile-0@example.test', signup: false,
      beforeRequest: async (record, request) => {
        if (record.path.includes('/dates') && record.method === 'POST') {
          const body = await request.clone().json(); commands.push(body);
          assert.equal(request.headers.get('idempotency-key'), body.command_id);
          assert.equal(request.url.includes(body.title), false);
        }
      },
      afterResponse: async (record, response) => {
        if (record.path.includes('/dates') && record.method === 'POST' && drop) {
          assert.equal(response.status, 201); drop = false; throw new Error('Synthetic lost committed ACK');
        }
      } }));
    accounts.push(await mobile(f, 1, { email: 'date-mobile-1@example.test', signup: false }));
    accounts.push(await mobile(f, 2, { email: 'date-mobile-2@example.test', signup: false }));
    const [a, b, foreign] = accounts.map(account => account.controller);
    assert.equal(accounts.every(account => !account.requests.some(r => r.path.includes('/dates'))), true);
    a.dates.setDraft('Synthetic shared date'); a.dates.setLocalDate('2028-02-29'); a.dates.setTimezone('Asia/Tokyo');
    a.dates.setRecurrence('annual'); a.dates.setLeapDayPolicy('mar1');
    await b.dates.list(); assert.equal(b.dates.getSnapshot().dates.length, 0, 'private RAM draft not auto-shared');
    await a.dates.create(); assert.equal(a.dates.getSnapshot().status, 'retry');
    a.dates.setDraft('Synthetic new draft'); a.dates.setLocalDate('2029-03-01'); a.dates.setTimezone('America/Los_Angeles'); a.dates.setRecurrence('once');
    await a.dates.retry(); assert.equal(a.dates.getSnapshot().status, 'saved');
    assert.equal(a.dates.getSnapshot().draft, 'Synthetic new draft');
    assert.equal(a.dates.getSnapshot().localDate, '2029-03-01'); assert.equal(a.dates.getSnapshot().timezone, 'America/Los_Angeles');
    assert.deepEqual(commands[0], commands[1]);
    assert.equal(commands[0].recurrence, 'annual'); assert.equal(commands[0].leap_day_policy, 'mar1');
    assert.equal(a.dates.getSnapshot().recurrence, 'once'); assert.equal(a.dates.getSnapshot().leapDayPolicy, null);
    const date = a.dates.getSnapshot().dates[0]; assert.equal(date.localDate, '2028-02-29'); assert.equal(date.timezone, 'Asia/Tokyo');
    assert.equal(date.recurrence, 'annual'); assert.equal(date.leapDayPolicy, 'mar1');
    await b.dates.list(); assert.deepEqual(b.dates.getSnapshot().dates, [date]);
    await foreign.dates.list(); assert.equal(foreign.dates.getSnapshot().dates.length, 0);
    const cookie = await accounts[2].connection.getCookie();
    assert.equal((await fetch(`${f.baseURL}/v1/couples/${pairA}/dates?membership_epoch=1`,
      { headers: { cookie, origin: f.baseURL } })).status, 403);
    const persisted = (await f.domainPool.query('SELECT local_date::text,timezone,title FROM shared_dates')).rows;
    assert.deepEqual(persisted, [{ local_date: '2028-02-29', timezone: 'Asia/Tokyo', title: 'Synthetic shared date' }]);
    const ownerCookie = await accounts[0].connection.getCookie();
    const leave = await fetch(`${f.baseURL}/v1/pair/leave`, { method: 'POST',
      headers: { cookie: ownerCookie, origin: f.baseURL, 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: randomUUID(), coupleId: pairA, membershipEpoch: 1, confirm: true }) });
    assert.equal(leave.status, 200);
    await a.dates.list(); assert.equal(a.dates.getSnapshot().available, false);
    assert.deepEqual(a.dates.getSnapshot().dates, []); assert.equal(a.dates.getSnapshot().draft, '');
    await b.refresh(); assert.deepEqual(b.dates.getSnapshot().dates, []);
    await foreign.dates.list(); assert.equal(foreign.dates.getSnapshot().available, true);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM shared_dates')).rows[0].n, 1, 'archive retained under existing closure policy');
  } finally { await closeMobile(f, accounts); }
});
