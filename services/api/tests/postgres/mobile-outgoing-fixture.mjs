import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { client } from './composed-fixture.mjs';
import { password } from './profile-fixture.mjs';

const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && context.parentURL && /\/(apps\/mobile|packages\/domain)\//.test(context.parentURL)) {
    const candidate = new URL(`${specifier}.ts`, context.parentURL);
    if (existsSync(candidate)) return next(candidate.href, context);
  }
  return next(specifier, context);
} });
const { createSessionController } = await import('../../../../apps/mobile/src/auth/controller.ts');
hooks.deregister();

// Real controller/provider/server. The optional transform is only for deliberate synthetic
// invalid-request denial responses; it never changes saved credentials or product state.
export async function outgoingAccount(f, index = 0, { transform = request => request, after = async () => {} } = {}) {
  const connection = client(f.baseURL), requests = [];
  const sessionClient = {
    async signIn(email, secret) {
      const result = await connection.auth.signIn.email({ email, password: secret });
      if (result.error) return null;
      const verified = await connection.auth.getSession({ query: { disableCookieCache: true } });
      return { userId: verified.data.user.id, sessionId: verified.data.session.id };
    },
    async signOut() { return !(await connection.auth.signOut()).error; },
    getCookie: connection.getCookie,
  };
  const controller = createSessionController({ mode: 'synthetic-loopback', baseURL: f.baseURL }, sessionClient,
    async original => {
      assert.equal(new URL(original.url).origin, f.baseURL);
      assert.equal(original.headers.get('cookie'), await connection.getCookie());
      assert.equal(original.headers.has('authorization'), false);
      const method = original.method, path = new URL(original.url).pathname;
      const body = method === 'GET' ? null : await original.clone().json();
      const request = await transform(original.clone());
      assert.equal(new URL(request.url).origin, f.baseURL, 'synthetic transform stays on disposable loopback server');
      const response = await fetch(request);
      const record = { method, path, body, status: response.status };
      requests.push(record); await after(record, response);
      return response;
    }, randomUUID);
  await controller.signIn(`reply-${index}@example.test`, password);
  return { controller, connection, requests };
}
