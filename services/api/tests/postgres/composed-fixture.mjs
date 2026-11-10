import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createAuthClient } from 'better-auth/client';
import { toNodeHandler } from 'better-auth/node';
import { createApiApplication } from '../../src/api-application.ts';
import { createFixture } from './fixture.mjs';
import { withDeadline } from './async-bounds.mjs';

export async function createComposedFixture({ emailPasswordEnabled = true, enableSyntheticProfileProvisioning = false, enableSyntheticWaitingSpaceCreation = false, enableSyntheticPairInvitations = false } = {}) {
  const fixture = await createFixture();
  let handler = async (_req, res) => { res.writeHead(503); res.end(); };
  const server = createServer((req, res) => { void handler(req, res).catch(() => { res.destroy(); }); });
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.timeout = 6000;
  try {
    await withDeadline(new Promise((resolve, reject) => {
      server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
    }), 3000, 'HTTP listen');
    const baseURL = `http://127.0.0.1:${server.address().port}`;
    const app = createApiApplication({ pool: fixture.domainPool, baseURL,
      secret: randomBytes(48).toString('base64url'), trustedOrigins: [baseURL], emailPasswordEnabled, enableSyntheticProfileProvisioning, enableSyntheticWaitingSpaceCreation, enableSyntheticPairInvitations,
      limits: { bodyBytes: 65536, bodyReadMs: 1000, statementMs: 7000, lockMs: 5000 } });
    handler = toNodeHandler(app.handle);
    return { ...fixture, baseURL,
      async close() {
        try {
          server.closeIdleConnections();
          await withDeadline(new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())), 5000, 'HTTP cleanup');
        } finally { server.closeAllConnections(); await fixture.close(); }
      },
    };
  } catch (error) { server.closeAllConnections(); server.close(); await fixture.close(); throw error; }
}

export function client(baseURL) {
  const cookies = new Map();
  async function transport(input, init) {
    const request = new Request(input, init);
    assert.equal(new URL(request.url).origin, baseURL, 'test transport cannot leave loopback app');
    if (!request.headers.has('origin')) request.headers.set('origin', baseURL);
    if (cookies.size) request.headers.set('cookie', [...cookies].map(([key, value]) => `${key}=${value}`).join('; '));
    const response = await fetch(request);
    for (const setCookie of response.headers.getSetCookie()) {
      const [pair] = setCookie.split(';'); const separator = pair.indexOf('=');
      const key = pair.slice(0, separator); const value = pair.slice(separator + 1);
      if (!value || /max-age=0/i.test(setCookie)) cookies.delete(key); else cookies.set(key, value);
    }
    return response;
  }
  return {
    getCookie: async () => [...cookies].map(([key, value]) => `${key}=${value}`).join('; '),
    auth: createAuthClient({ baseURL, fetchOptions: { customFetchImpl: transport, retry: 0 } }),
    send(pairId, clientId, text = 'Synthetic message', headers = {}) {
      return transport(`${baseURL}/v1/couples/${pairId}/chat/messages`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': clientId, ...headers },
        body: JSON.stringify({ client_message_id: clientId, membership_epoch: 1, body: text, senderId: 'ignored-synthetic-spoof' }) });
    },
    history(pairId) { return transport(`${baseURL}/v1/couples/${pairId}/chat/messages?membership_epoch=1&limit=50`); },
  };
}
