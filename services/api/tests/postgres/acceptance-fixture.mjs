import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { toNodeHandler } from 'better-auth/node';
import { createPairAcceptanceHandler } from '../../src/pair-acceptance.ts';
import { createPairInvitationHandler } from '../../src/pair-invitations.ts';
import { createProfileProvisionHandler } from '../../src/profile-provision.ts';
import { createWaitingSpaceHandler } from '../../src/waiting-space.ts';
import { settleBounded, withDeadline } from './async-bounds.mjs';
import { account, database } from './profile-fixture.mjs';
import { flags, invitationPath, issue, ownWaiting, request } from './invitation-fixture.mjs';

export const acceptanceFlags = { ...flags, enableSyntheticPairAcceptance: true };
export const previewPath = '/v1/pair-invitations/preview';
export const acceptPath = '/v1/pair-invitations/accept';
export const preview = (f, connection, token) => request(f, connection,
  { path: previewPath, body: JSON.stringify({ token }) });
export const accept = (f, connection, token) => request(f, connection,
  { path: acceptPath, body: JSON.stringify({ token, accept: true }) });
export async function recipient(f, server, index = 1) {
  const a = await account(f, index);
  const response = await request(server, a.cookie, { path: '/v1/profile' });
  assert.equal(response.status, 201);
  return { ...a, ...(await response.json()).value };
}
export async function prepareCase(f, server) {
  const owner = await ownWaiting(f, server);
  const guest = await recipient(f, server);
  const issued = await issue(server, owner.cookie, randomUUID());
  assert.equal(issued.status, 201);
  const { invitation, token } = (await issued.json()).value;
  return { owner, guest, invitation, token };
}
export async function state(f) {
  return (await f.domainPool.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM couples c) couples,
    (SELECT jsonb_agg(to_jsonb(m) ORDER BY m.couple_id,m.user_id) FROM couple_members m) members,
    (SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) FROM pair_invites i) invites,
    (SELECT count(*)::int FROM outbox_events) outbox,
    (SELECT count(*)::int FROM chat_messages) messages`)).rows[0];
}
export async function assertAccepted(f, owner, guest, invitationId) {
  const row = (await f.domainPool.query(`SELECT c.status,c.membership_epoch,
    (SELECT count(*)::int FROM couple_members m WHERE m.couple_id=c.id AND m.status='active') members,
    (SELECT user_id FROM couple_members m WHERE m.couple_id=c.id AND m.slot=2 AND m.status='active') guest
    FROM couples c WHERE c.id=$1`, [owner.coupleId])).rows[0];
  assert.deepEqual(row, { status: 'active', membership_epoch: 2, members: 2, guest: guest.userId });
  const invite = (await f.domainPool.query('SELECT * FROM pair_invites WHERE id=$1', [invitationId])).rows[0];
  assert.equal(invite.consumed_by_user_id, guest.userId);
  assert.equal(invite.consumed_at instanceof Date, true);
  assert.equal(invite.consumed_at.getTime() < invite.expires_at.getTime(), true);
  assert.equal(invite.revoked_at, null);
  assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM outbox_events')).rows[0].n, 0);
}

// The official provider, real product handlers and transaction adapter run over real loopback HTTP.
// Hooks only observe transactions or discard the already committed response.
export async function harness(f, { db = database(f), getSession = headers => f.resolve(headers.get('cookie')),
  dropFirstAcceptedResponse = false } = {}) {
  let handle;
  const server = createServer((req, res) => { void handle(req, res).catch(() => res.destroy()); });
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.timeout = 6000;
  try {
    await withDeadline(new Promise((resolve, reject) => {
      server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
    }), 3000, 'Acceptance HTTP listen');
    const baseURL = `http://127.0.0.1:${server.address().port}`;
    const options = { getSession, trustedOrigins: [baseURL] };
    const acceptance = createPairAcceptanceHandler(db, options);
    const invitation = createPairInvitationHandler(db, options);
    const profile = createProfileProvisionHandler(database(f), options);
    const waiting = createWaitingSpaceHandler(database(f), options);
    handle = toNodeHandler(async incoming => {
      const path = new URL(incoming.url).pathname;
      const response = await (path === '/v1/profile' ? profile(incoming)
        : path === '/v1/spaces/waiting' ? waiting(incoming)
        : path === invitationPath ? invitation(incoming) : acceptance(incoming));
      if (path === acceptPath && response.status === 200 && dropFirstAcceptedResponse) {
        dropFirstAcceptedResponse = false;
        throw new Error('synthetic_lost_http_acknowledgement');
      }
      return response;
    });
    return { baseURL,
      async close() {
        server.closeIdleConnections();
        try { await withDeadline(new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())), 5000, 'Acceptance HTTP cleanup'); }
        finally { server.closeAllConnections(); }
      },
    };
  } catch (error) { server.closeAllConnections(); server.close(); throw error; }
}
export async function releaseBlocker(blocker) {
  await blocker.query('COMMIT'); blocker.release();
}
export async function cleanup(f, server, tasks = [], blocker) {
  if (blocker) { try { await blocker.query('ROLLBACK'); } finally { blocker.release(); } }
  try { await settleBounded(tasks); } finally { try { await server?.close(); } finally { await f.close(); } }
}
