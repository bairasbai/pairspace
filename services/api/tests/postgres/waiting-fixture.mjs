import { createServer } from 'node:http';
import { toNodeHandler } from 'better-auth/node';
import { randomUUID } from 'node:crypto';
import { createWaitingSpaceHandler } from '../../src/waiting-space.ts';
import { withDeadline } from './async-bounds.mjs';
import { database } from './profile-fixture.mjs';

// Only test wrappers differ: official verification, product transaction adapter and real loopback HTTP.
export async function harness(f, { db = database(f), getSession = headers => f.resolve(headers.get('cookie')),
  dropFirstCreatedResponse = false } = {}) {
  let handle;
  const server = createServer((req, res) => { void handle(req, res).catch(() => res.destroy()); });
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.timeout = 6000;
  await withDeadline(new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  }), 3000, 'Waiting HTTP listen');
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  const waiting = createWaitingSpaceHandler(db, { getSession, trustedOrigins: [baseURL] });
  handle = toNodeHandler(async request => {
    const response = await waiting(request);
    if (response.status === 201 && dropFirstCreatedResponse) {
      dropFirstCreatedResponse = false;
      // The real transaction has committed; destroy the socket before its HTTP acknowledgement.
      throw new Error('synthetic_lost_http_acknowledgement');
    }
    return response;
  });
  return { baseURL,
    request: (sessionCookie, body = '{}') => fetch(`${baseURL}/v1/spaces/waiting`, {
      method: 'POST', body, headers: { origin: baseURL, cookie: sessionCookie, 'content-type': 'application/json' },
    }),
    async close() {
      server.closeIdleConnections();
      try { await withDeadline(new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())), 5000, 'Waiting HTTP cleanup'); }
      finally { server.closeAllConnections(); }
    },
  };
}

export async function mappedAccount(f, account) {
  const userId = randomUUID();
  await f.domainPool.query('INSERT INTO users(id) VALUES($1)', [userId]);
  await f.domainPool.query('INSERT INTO better_auth_identities VALUES($1,$2)', [account.user.id, userId]);
  return userId;
}
export const baseCounts = { users: 1, mappings: 1, couples: 0, members: 0, messages: 0, outbox: 0 };
