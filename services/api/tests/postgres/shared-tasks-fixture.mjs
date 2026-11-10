import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { toNodeHandler } from 'better-auth/node';
import { bindSessionAuthority } from '../../src/auth-authority.ts';
import { createBetterAuthAuthority } from '../../src/better-auth-authority.ts';
import { createSharedTasksHandler } from '../../src/shared-tasks-http.ts';
import { lettersFixture } from './letters-fixture.mjs';
import { database } from './profile-fixture.mjs';
import { withDeadline } from './async-bounds.mjs';

export async function tasksFixture() {
  const x = await lettersFixture({ enableSyntheticSharedTasks: true, enableSyntheticPairLeave: true });
  const path = (pair = x.pairA) => `/v1/couples/${pair}/tasks`;
  const post = (index, url, body) => x.raw(index, url, { method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': body.command_id }, body: JSON.stringify(body) });
  const create = (index, title = 'Synthetic task', commandId = randomUUID(), pair = x.pairA, epoch = 1, extra = {}) =>
    post(index, path(pair), { command_id: commandId, membership_epoch: epoch, title, ...extra });
  const change = (index, taskId, operation = 'complete', version = 1, commandId = randomUUID(), pair = x.pairA, epoch = 1, extra = {}) =>
    post(index, `${path(pair)}/${taskId}`, { command_id: commandId, membership_epoch: epoch, operation, expected_version: version, ...extra });
  const list = (index, pair = x.pairA, epoch = 1) => x.raw(index, `${path(pair)}?membership_epoch=${epoch}`);
  const leave = (index, pair = x.pairA) => x.raw(index, '/v1/pair/leave', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ commandId: randomUUID(), coupleId: pair, membershipEpoch: 1, confirm: true }) });
  return { ...x, path, post, create, change, list, leave };
}

/** Real loopback connection intentionally destroyed after durable application commit. */
export async function tasksHarness(f, { db = database(f), drop = true } = {}) {
  let handle;
  const server = createServer((req, res) => { void handle(req, res).catch(() => res.destroy()); });
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.timeout = 6000;
  await withDeadline(new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  }), 3000, 'Tasks HTTP listen');
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  const handler = createSharedTasksHandler(bindSessionAuthority(db, createBetterAuthAuthority(db, {
    getSession: async headers => {
      const response = await fetch(`${f.baseURL}/api/auth/get-session`, {
        headers: { origin: f.baseURL, cookie: headers.get('cookie') ?? '' },
      });
      const value = await response.json();
      return value?.session ? { ...value, session: { ...value.session, expiresAt: new Date(value.session.expiresAt) } } : null;
    }, trustedOrigins: [baseURL],
  })));
  handle = toNodeHandler(async request => {
    const response = await handler(request);
    if (drop && [200, 201].includes(response.status)) { drop = false; throw new Error('synthetic_lost_task_ack'); }
    return response;
  });
  return { request: (cookie, path, body) => fetch(`${baseURL}${path}`, { method: 'POST',
    headers: { origin: baseURL, cookie, 'content-type': 'application/json', 'idempotency-key': body.command_id }, body: JSON.stringify(body) }),
  async close() {
    server.closeIdleConnections();
    try { await withDeadline(new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())), 5000, 'Tasks HTTP cleanup'); }
    finally { server.closeAllConnections(); }
  } };
}
