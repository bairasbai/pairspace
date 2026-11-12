import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { createComposedFixture, client } from './composed-fixture.mjs';
// Test-only TS extension resolver. Does not replace or mock production modules.
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

test('mobile session controller cookie transport → composed HTTP → real PostgreSQL; replay, revoke and isolation', async () => {
  const f = await createComposedFixture();
  const password = 'Synthetic-only-password-712!';
  try {
    const accounts = [];
    for (let i = 0; i < 4; i++) {
      const c = client(f.baseURL);
      const email = `mobile-${i}@example.test`;
      const signup = await c.auth.signUp.email({ email, password, name: 'Synthetic' });
      assert.equal(signup.error, null);
      accounts.push({ email, userId: signup.data.user.id });
    }
    const pairA = randomUUID(); const pairB = randomUUID();
    await f.provision(accounts.slice(0, 2).map(a => a.userId), pairA);
    await f.provision(accounts.slice(2).map(a => a.userId), pairB);
    const c = client(f.baseURL);
    // Node fixture wraps the official client; native Expo/SecureStore is not executed here.
    const sessionClient = {
      async signIn(email, password) {
        const result = await c.auth.signIn.email({ email, password });
        if (result.error) return null;
        const verified = await c.auth.getSession({ query: { disableCookieCache: true } });
        return { userId: verified.data.user.id, sessionId: verified.data.session.id };
      },
      async signOut() { return !(await c.auth.signOut()).error; },
      getCookie: c.getCookie,
    };
    let loseAck = true;
    const controller = createSessionController({ mode: 'synthetic-loopback', baseURL: f.baseURL }, sessionClient,
      async request => {
        assert.equal(request.headers.has('authorization'), false);
        assert.equal(request.headers.get('origin'), f.baseURL);
        const response = await fetch(request);
        if (request.method === 'POST' && loseAck) { loseAck = false; throw new Error('synthetic lost ACK'); }
        return response;
      }, randomUUID);
    await controller.signIn(accounts[0].email, password);
    assert.equal(controller.getSnapshot().phase, 'signed_in');
    controller.setDraft('Synthetic mobile message');
    await controller.send();
    assert.equal(controller.getSnapshot().draft, 'Synthetic mobile message');
    await controller.send();
    assert.equal(controller.getSnapshot().draft, '');
    assert.equal(controller.getSnapshot().messages.length, 0, 'ACK does not force history navigation');
    await controller.loadLatest();
    assert.equal(controller.getSnapshot().messages.length, 1);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM chat_messages')).rows[0].n, 1);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM outbox_events')).rows[0].n, 1);
    controller.setDraft('old-epoch draft');
    await f.domainPool.query('UPDATE couples SET membership_epoch=membership_epoch+1 WHERE id=$1', [pairA]);
    await controller.send();
    assert.equal(controller.getSnapshot().draft, '', 'changed server context discards old pending draft before send');
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM chat_messages')).rows[0].n, 1);
    await controller.refresh();
    assert.equal(controller.getSnapshot().messages.length, 1);
    controller.setDraft('private A draft');
    await controller.signOut();
    await controller.signIn(accounts[2].email, password);
    assert.equal(controller.getSnapshot().messages.length, 0);
    assert.equal(controller.getSnapshot().draft, '');
    const active = await c.auth.getSession();
    await c.auth.revokeSession({ token: active.data.session.token });
    await controller.refresh();
    assert.equal(controller.getSnapshot().phase, 'blocked');
    assert.equal(controller.getSnapshot().messages.length, 0);
    await controller.signOut();
    assert.equal(controller.getSnapshot().phase, 'signed_out');
  } finally { await f.close(); }
});

test('explicit mobile profile action creates server identity once without fixture mapping or pair creation', async () => {
  const f = await createComposedFixture({ enableSyntheticProfileProvisioning: true });
  const password = 'Synthetic-profile-password-712!';
  try {
    const c = client(f.baseURL);
    const email = 'mobile-profile@example.test';
    const account = await c.auth.signUp.email({ email, password, name: 'Synthetic' });
    assert.equal(account.error, null);
    const sessionClient = {
      async signIn(email, password) {
        const result = await c.auth.signIn.email({ email, password });
        if (result.error) return null;
        const verified = await c.auth.getSession({ query: { disableCookieCache: true } });
        return { userId: verified.data.user.id, sessionId: verified.data.session.id };
      },
      async signOut() { return !(await c.auth.signOut()).error; },
      getCookie: c.getCookie,
    };
    let posts = 0;
    const controller = createSessionController({ mode: 'synthetic-loopback', baseURL: f.baseURL }, sessionClient,
      async request => {
        assert.equal(request.headers.has('authorization'), false);
        assert.equal(request.headers.get('origin'), f.baseURL);
        if (new URL(request.url).pathname === '/v1/profile') {
          posts++;
          assert.deepEqual(await request.clone().json(), {});
        }
        const response = await fetch(request);
        if (request.method === 'POST' && posts === 1) {
          assert.equal(response.status, 201);
          throw new Error('synthetic lost acknowledgement after profile commit');
        }
        return response;
      }, randomUUID);
    await controller.signIn(email, password);
    assert.equal(controller.getSnapshot().error, 'context_unmapped');
    assert.equal(posts, 0, 'sign-in/discovery must not auto-provision');
    await controller.createProfile();
    assert.equal(controller.getSnapshot().error, 'profile_retry_required');
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM users')).rows[0].n, 1);
    await controller.createProfile();
    assert.equal(controller.getSnapshot().error, 'context_no_active_pair');
    assert.equal(posts, 1, 'retry discovers already-created profile before another mutation');
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM users')).rows[0].n, 1);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM better_auth_identities')).rows[0].n, 1);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM couples')).rows[0].n, 0);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM chat_messages')).rows[0].n, 0);
    const mapping = await f.domainPool.query('SELECT auth_user_id FROM better_auth_identities');
    assert.equal(mapping.rows[0].auth_user_id, account.data.user.id);
    await controller.createProfile();
    assert.equal(posts, 1, 'no action allowed from no-active-pair state');
    await controller.signOut();
    await controller.signIn(email, password);
    assert.equal(controller.getSnapshot().error, 'context_no_active_pair');
    assert.equal(posts, 1);
    await controller.signOut();
  } finally { await f.close(); }
});

test('explicit mobile waiting-space action reserves one own space but never authorizes chat or invites', async () => {
  const f = await createComposedFixture({
    enableSyntheticProfileProvisioning: true, enableSyntheticWaitingSpaceCreation: true,
  });
  const password = 'Synthetic-waiting-password-712!';
  try {
    const c = client(f.baseURL); const email = 'mobile-waiting@example.test';
    const signup = await c.auth.signUp.email({ email, password, name: 'Synthetic' });
    assert.equal(signup.error, null);
    const sessionClient = {
      async signIn(email, password) {
        const result = await c.auth.signIn.email({ email, password });
        if (result.error) return null;
        const verified = await c.auth.getSession({ query: { disableCookieCache: true } });
        return { userId: verified.data.user.id, sessionId: verified.data.session.id };
      },
      async signOut() { return !(await c.auth.signOut()).error; },
      getCookie: c.getCookie,
    };
    let waitingPosts = 0;
    const controller = createSessionController({ mode: 'synthetic-loopback', baseURL: f.baseURL }, sessionClient,
      async request => {
        const waiting = new URL(request.url).pathname === '/v1/spaces/waiting';
        if (waiting) { waitingPosts++; assert.deepEqual(await request.clone().json(), {}); }
        const response = await fetch(request);
        if (waiting && waitingPosts === 1) {
          assert.equal(response.status, 201);
          throw new Error('synthetic lost acknowledgement after waiting-space COMMIT');
        }
        return response;
      }, randomUUID);
    await controller.signIn(email, password);
    assert.equal(controller.getSnapshot().error, 'context_unmapped');
    await controller.createProfile();
    assert.equal(controller.getSnapshot().error, 'context_no_active_pair');
    assert.equal(waitingPosts, 0, 'profile creation must not create a space');
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM couples')).rows[0].n, 0);
    await controller.createWaitingSpace();
    assert.equal(controller.getSnapshot().error, 'waiting_retry_required');
    await controller.createWaitingSpace();
    assert.equal(controller.getSnapshot().error, 'context_waiting_partner');
    assert.equal(waitingPosts, 1, 'retry discovers committed waiting space without duplicate POST');
    const spaces = await f.domainPool.query('SELECT id,status,membership_epoch FROM couples');
    assert.equal(spaces.rows.length, 1); assert.equal(spaces.rows[0].status, 'waiting_partner');
    const members = await f.domainPool.query('SELECT slot,status FROM couple_members');
    assert.deepEqual(members.rows, [{ slot: 1, status: 'active' }]);
    controller.setDraft('must not be sent while waiting');
    await controller.send(); await controller.createWaitingSpace(); await controller.createProfile();
    assert.equal(controller.getSnapshot().draft, '');
    assert.equal(waitingPosts, 1);
    assert.equal((await c.send(spaces.rows[0].id, randomUUID())).status, 403);
    assert.equal((await c.history(spaces.rows[0].id)).status, 403);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM chat_messages')).rows[0].n, 0);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM outbox_events')).rows[0].n, 0);
    await controller.signOut(); await controller.signIn(email, password);
    assert.equal(controller.getSnapshot().error, 'context_waiting_partner');
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM couples')).rows[0].n, 1);
    await controller.signOut();
  } finally { await f.close(); }
});
