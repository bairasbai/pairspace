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
    const idsA = await f.provision(accounts.slice(0, 2).map(a => a.userId), pairA);
    const idsB = await f.provision(accounts.slice(2).map(a => a.userId), pairB);
    const identities = Object.fromEntries(accounts.map((a, i) => [a.userId, {
      userId: i < 2 ? idsA[i] : idsB[i - 2], coupleId: i < 2 ? pairA : pairB, membershipEpoch: 1,
    }]));
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
    const controller = createSessionController({ mode: 'synthetic-loopback', baseURL: f.baseURL, identities }, sessionClient,
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
    assert.equal(controller.getSnapshot().messages.length, 1);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM chat_messages')).rows[0].n, 1);
    assert.equal((await f.domainPool.query('SELECT count(*)::int n FROM outbox_events')).rows[0].n, 1);
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
