import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { client, createComposedFixture } from './composed-fixture.mjs';
import { acceptanceFlags, acceptPath, previewPath } from './acceptance-fixture.mjs';
import { invitationPath } from './invitation-fixture.mjs';
import { password } from './profile-fixture.mjs';
import { settleBounded } from './async-bounds.mjs';

// Same extension-only resolver as mobile-controller.integration. All controllers are production code.
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && context.parentURL
    && /\/(apps\/mobile|packages\/domain)\//.test(context.parentURL)) {
    const candidate = new URL(`${specifier}.ts`, context.parentURL);
    if (existsSync(candidate)) return next(candidate.href, context);
  }
  return next(specifier, context);
} });
const { createSessionController } = await import('../../../../apps/mobile/src/auth/controller.ts');
hooks.deregister();

export { acceptPath, invitationPath, password, previewPath };
export const digest = value => createHash('sha256').update(value).digest('hex');
export const createMobileFixture = () => createComposedFixture(acceptanceFlags);

export async function mobile(f, index, { email = `mobile-invitation-${index}@example.test`,
  signup = true, beforeRequest = async () => {}, afterResponse = async () => {} } = {}) {
  const connection = client(f.baseURL);
  if (signup) {
    const result = await connection.auth.signUp.email({ email, password, name: 'Synthetic' });
    // Do not print auth responses, cookies, invitation tokens or sensitive bodies on failure.
    assert.equal(result.error === null, true, 'official signup succeeds');
  }
  const requests = [];
  const contexts = [];
  const sessionClient = {
    async signIn(email, password) {
      const result = await connection.auth.signIn.email({ email, password });
      if (result.error) return null;
      const verified = await connection.auth.getSession({ query: { disableCookieCache: true } });
      return { userId: verified.data.user.id, sessionId: verified.data.session.id };
    },
    async signOut() { return !(await connection.auth.signOut()).error; },
    getCookie: connection.getCookie,
  };
  // Native I/O boundary only: official Better Auth client supplies real session cookies.
  const controller = createSessionController({ mode: 'synthetic-loopback', baseURL: f.baseURL }, sessionClient,
    async request => {
      assert.equal(new URL(request.url).origin, f.baseURL);
      assert.equal(request.headers.has('authorization'), false);
      assert.equal(request.headers.get('origin'), f.baseURL);
      assert.equal(request.headers.get('cookie') === await connection.getCookie(), true,
        'controller binds this real provider cookie, without bearer substitution');
      const path = new URL(request.url).pathname;
      const body = request.method === 'GET' ? null : await request.clone().json();
      const record = { path, method: request.method, cookieDigest: digest(request.headers.get('cookie')),
        keys: body ? Object.keys(body).sort() : [], commandId: body?.commandId, inviteId: body?.inviteId,
        tokenDigest: typeof body?.token === 'string' ? digest(body.token) : null, accept: body?.accept };
      requests.push(record);
      await beforeRequest(record, request);
      const response = await fetch(request);
      if (path === '/v1/session/context' && response.status === 200) {
        contexts.push((await response.clone().json()).value);
      }
      if (path === invitationPath && request.method === 'GET' && response.status === 200) {
        const metadata = (await response.clone().json()).value;
        assert.equal(Object.hasOwn(metadata, 'token'), false, 'metadata never re-exposes raw token');
      }
      await afterResponse(record, response);
      return response;
    }, randomUUID);
  await controller.signIn(email, password);
  return { controller, invitations: controller.invitations, connection, email, requests, contexts,
    count: (path, method = 'POST') => requests.filter(r => r.path === path && r.method === method).length };
}

export async function profile(account) {
  assert.equal(account.controller.getSnapshot().error, 'context_unmapped');
  assert.equal(account.count('/v1/profile'), 0, 'sign-in cannot implicitly create product identity');
  await account.controller.createProfile();
  assert.equal(account.controller.getSnapshot().error, 'context_no_active_pair');
  assert.equal(account.invitations.getSnapshot().mode, 'recipient');
}
export async function waiting(account) {
  await profile(account);
  await account.controller.createWaitingSpace();
  assert.equal(account.controller.getSnapshot().error, 'context_waiting_partner');
  assert.equal(account.invitations.getSnapshot().mode, 'owner');
}
export async function issueToken(account) {
  await account.invitations.readMetadata();
  await account.invitations.issue();
  const view = account.invitations.getSnapshot();
  assert.equal(typeof view.issuedToken === 'string' && view.issuedToken.length > 20, true,
    'only a newly issued response can display raw token');
  assert.equal(view.invitation?.status, 'pending');
  return view.issuedToken;
}
export async function previewToken(account, token) {
  account.invitations.setToken(token);
  await account.invitations.preview();
  assert.equal(account.invitations.getSnapshot().preview !== null, true);
}
export async function memberState(f) {
  return (await f.domainPool.query(`SELECT c.id,c.status,c.membership_epoch,
    (SELECT count(*)::int FROM couple_members m WHERE m.couple_id=c.id AND m.status='active') members
    FROM couples c ORDER BY c.id`)).rows;
}
export function assertCleared(account) {
  const view = account.invitations.getSnapshot();
  assert.equal(view.mode, 'unavailable');
  assert.equal(view.issuedToken === null, true);
  assert.equal(view.tokenInput.length, 0);
  assert.equal(view.preview, null);
  assert.equal(view.consent, false);
  assert.equal(account.controller.getSnapshot().draft.length, 0);
  assert.equal(account.controller.getSnapshot().messages.length, 0);
}
export async function closeMobile(f, accounts = [], tasks = []) {
  try { await settleBounded(tasks); }
  finally {
    try { for (const account of accounts) await account.controller.signOut(); }
    finally { await f.close(); }
  }
}
