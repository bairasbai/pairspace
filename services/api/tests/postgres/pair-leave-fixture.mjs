import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { toNodeHandler } from 'better-auth/node';
import { bindSessionAuthority } from '../../src/auth-authority.ts';
import { createBetterAuthAuthority } from '../../src/better-auth-authority.ts';
import { createPairLeaveHandler } from '../../src/pair-leave-http.ts';
import { lettersFixture } from './letters-fixture.mjs';
import { database } from './profile-fixture.mjs';
import { withDeadline } from './async-bounds.mjs';

export async function leaveFixture() {
  const value = await lettersFixture({ enableSyntheticPairLeave: true, enableSyntheticCareSignals: true,
    enableSyntheticWaitingSpaceCreation: true, enableSyntheticPairInvitations: true, enableSyntheticPairAcceptance: true });
  const command = (pair = value.pairA, epoch = 1) => ({ commandId: randomUUID(), coupleId: pair, membershipEpoch: epoch, confirm: true });
  const leave = (index, body = command()) => value.raw(index, '/v1/pair/leave', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { ...value, command, leave };
}
export async function pairState(f, pair) {
  return (await f.domainPool.query(`SELECT c.status,c.membership_epoch,
    (SELECT count(*)::int FROM couple_members m WHERE m.couple_id=c.id AND m.status='active') active,
    (SELECT count(*)::int FROM outbox_events e WHERE e.couple_id=c.id AND e.type='couple.closed') events
    FROM couples c WHERE c.id=$1`, [pair])).rows[0];
}
export async function assertClosed(f, pair) {
  assert.deepEqual(await pairState(f, pair), { status: 'closed', membership_epoch: 2, active: 0, events: 1 });
}
export async function pairAgain(f, members) {
  const pair = randomUUID(); const connection = await f.domainPool.connect();
  try {
    await connection.query('BEGIN'); await connection.query("INSERT INTO couples(id,status) VALUES($1,'waiting_partner')", [pair]);
    for (let n = 0; n < members.length; n++) await connection.query("INSERT INTO couple_members(couple_id,user_id,slot,status) VALUES($1,$2,$3,'active')", [pair, members[n], n + 1]);
    await connection.query("UPDATE couples SET status='active' WHERE id=$1", [pair]);
    await connection.query('COMMIT'); return pair;
  } catch (error) { await connection.query('ROLLBACK'); throw error; } finally { connection.release(); }
}
export async function leaveHarness(f, { db = database(f), drop = false, afterVerified = async () => {} } = {}) {
  let handle;
  const server = createServer((req, res) => { void handle(req, res).catch(() => res.destroy()); });
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.timeout = 6000;
  await withDeadline(new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  }), 3000, 'Leave HTTP listen');
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  const leave = createPairLeaveHandler(bindSessionAuthority(db, createBetterAuthAuthority(db, {
    getSession: async headers => {
      const response = await fetch(`${f.baseURL}/api/auth/get-session`, { headers: { origin: f.baseURL, cookie: headers.get('cookie') ?? '' } });
      const value = await response.json();
      if (!value?.session) return null;
      await afterVerified(value);
      return { ...value, session: { ...value.session, expiresAt: new Date(value.session.expiresAt) } };
    }, trustedOrigins: [baseURL],
  })));
  handle = toNodeHandler(async request => {
    const response = await leave(request);
    if (response.status === 200 && drop) { drop = false; throw new Error('synthetic_lost_leave_ack'); }
    return response;
  });
  return { request: (cookie, command) => fetch(`${baseURL}/v1/pair/leave`, { method: 'POST',
    headers: { origin: baseURL, cookie, 'content-type': 'application/json' }, body: JSON.stringify(command) }),
  async close() {
    server.closeIdleConnections();
    try { await withDeadline(new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())), 5000, 'Leave HTTP cleanup'); }
    finally { server.closeAllConnections(); }
  } };
}
