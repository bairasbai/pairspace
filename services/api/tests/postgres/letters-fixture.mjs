import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createComposedFixture, client } from './composed-fixture.mjs';
import { password } from './profile-fixture.mjs';

export async function lettersFixture(options = {}) {
  const f = await createComposedFixture({ enableSyntheticLetters: true, ...options });
  try {
    const connections = []; const identities = [];
    for (let n = 0; n < 4; n++) {
      const connection = client(f.baseURL);
      const result = await connection.auth.signUp.email({ email: `letters-${n}@example.test`, password, name: 'Synthetic' });
      assert.equal(result.error, null); connections.push(connection); identities.push(result.data.user.id);
    }
    const pairA = randomUUID(); const pairB = randomUUID();
    const usersA = await f.provision(identities.slice(0, 2), pairA);
    const usersB = await f.provision(identities.slice(2), pairB);
    async function raw(index, path, options = {}) {
      const headers = { origin: f.baseURL, cookie: index === null ? '' : await connections[index].getCookie(), ...options.headers };
      return fetch(`${f.baseURL}${path}`, { ...options, headers });
    }
    const path = (pair = pairA) => `/v1/couples/${pair}/letters`;
    const send = (index, id = randomUUID(), body = 'Synthetic letter', pair = pairA, epoch = 1, extra = {}) => raw(index, path(pair), {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': id },
      body: JSON.stringify({ client_letter_id: id, membership_epoch: epoch, body, ...extra }),
    });
    const list = (index, pair = pairA, epoch = 1) => raw(index, `${path(pair)}?membership_epoch=${epoch}`);
    const open = (index, id, pair = pairA, epoch = 1) => raw(index, `${path(pair)}/${id}?membership_epoch=${epoch}`);
    async function principal(index) {
      const { rows } = await f.domainPool.query(`SELECT s.id, s."userId" AS auth_user_id,
        s."expiresAt" AS expires_at, i.user_id FROM "session" s
        JOIN better_auth_identities i ON i.auth_user_id=s."userId" WHERE s."userId"=$1`, [identities[index]]);
      const row = rows[0]; assert.ok(row);
      return { source: 'better-auth', userId: row.user_id, authUserId: row.auth_user_id,
        sessionId: row.id, tokenExpiresAt: Math.floor(row.expires_at.getTime() / 1000) };
    }
    return { f, connections, identities, pairA, pairB, usersA, usersB, raw, path, send, list, open, principal };
  } catch (error) { await f.close(); throw error; }
}

export function pauseAfterMembers(db) {
  let release; let reached;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { reached = resolve; });
  return { release, entered, db: { ...db, transaction: work => db.transaction(tx => work({
    async query(sql, params) {
      const result = await tx.query(sql, params);
      if (sql.includes('FROM couple_members') && sql.includes('FOR SHARE')) { reached(); await gate; }
      return result;
    },
  })) } };
}
