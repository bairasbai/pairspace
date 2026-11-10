import { afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { generateKeyPair, SignJWT } from 'jose';
import type { PGlite } from '@electric-sql/pglite';
import { createSessionVerifier } from '../src/auth.ts';
import { createSyntheticChatHandler as createChatHandler } from './fixtures.ts';
import { createChatTransport } from '../../../apps/mobile/src/chat/transport';
import { createQueue, enqueue } from '../../../apps/mobile/src/chat/queue';
import { adapter, c1, c2, command, createFixture, fixtureNow, identityPrincipal, u1, u2, u3, u4 } from './fixtures.ts';
let pg: PGlite;
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
beforeAll(async () => { keys = await generateKeyPair('ES256'); });
beforeEach(async () => { pg = await createFixture(); });
afterEach(async () => { await pg.close(); });
const issuer = 'https://fixture.invalid';
const audience = 'pairspace-test';
const seconds = () => fixtureNow().getTime() / 1000;
const sign = (userId: string) => new SignJWT({ sid: identityPrincipal(userId).sessionId })
  .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt' }).setIssuer(issuer).setAudience(audience)
  .setSubject(userId).setIssuedAt(seconds()).setNotBefore(seconds()).setExpirationTime(seconds() + 300).sign(keys.privateKey);
const verify = () => createSessionVerifier(adapter(pg), { verificationKey: keys.publicKey, issuer, audience, maxTokenAgeSeconds: 300 });
it('four signed identities flow queue→HTTP→jose→SQL, never request-supplied author', async () => {
  const handler = createChatHandler(adapter(pg), verify());
  for (const userId of [u1, u2, u3, u4]) {
    const scope = { userId, coupleId: userId === u1 || userId === u2 ? c1 : c2, membershipEpoch: 1, sessionId: userId };
    let state = enqueue(createQueue(scope), scope, command.clientId, 'Hello').state;
    const transport = createChatTransport({ baseUrl: 'https://test.invalid', getCredentialGeneration: () => 1, request: handler,
      store: { get: () => state, set: next => { state = next; } } });
    const session = { scope, token: await sign(userId), credentialGeneration: 1 };
    expect(await transport.send(command.clientId, session)).toEqual({ ok: true, value: { replay: false } });
    expect(state.messages[0].status).toBe('accepted');
    const page = await transport.history(session, { limit: 100 });
    expect(page.ok).toBe(true);
    if (page.ok) expect(page.value.messages.every(message => message.coupleId === scope.coupleId)).toBe(true);
  }
  expect((await pg.query('SELECT * FROM chat_messages')).rows).toHaveLength(4);
});
it('revoking after successful signature verification still blocks the SQL write and preserves queue', async () => {
  const verifier = verify();
  const handler = createChatHandler(adapter(pg), async token => {
    const principal = await verifier(token);
    expect(principal).not.toBeNull();
    await pg.query('UPDATE auth_sessions SET revoked_at=$1 WHERE id=$2', [fixtureNow(), identityPrincipal(u1).sessionId]);
    return principal;
  });
  const scope = { userId: u1, coupleId: c1, membershipEpoch: 1, sessionId: 'local' };
  let state = enqueue(createQueue(scope), scope, command.clientId, 'Do not lose this').state;
  const transport = createChatTransport({ baseUrl: 'https://test.invalid', request: handler, getCredentialGeneration: () => 1,
    store: { get: () => state, set: next => { state = next; } } });
  expect(await transport.send(command.clientId, { scope, token: await sign(u1), credentialGeneration: 1 }))
    .toEqual({ ok: false, error: 'access_required' });
  expect(state.phase).toBe('paused');
  expect(state.messages[0]).toMatchObject({ body: 'Do not lose this', clientId: command.clientId });
  expect((await pg.query('SELECT * FROM chat_messages')).rows).toEqual([]);
});
it('token expiring after signature verification is denied by transaction-time revalidation', async () => {
  let now = fixtureNow();
  const db = { ...adapter(pg), now: () => now };
  const verifier = createSessionVerifier(db, { verificationKey: keys.publicKey, issuer, audience, maxTokenAgeSeconds: 300 });
  const handler = createChatHandler(db, async token => {
    const principal = await verifier(token);
    expect(principal).not.toBeNull();
    now = new Date(now.getTime() + 300000);
    return principal;
  });
  const result = await handler(new Request(`https://test.invalid/v1/couples/${c1}/chat/messages`, {
    method: 'POST', headers: { authorization: `Bearer ${await sign(u1)}`, 'content-type': 'application/json', 'idempotency-key': command.clientId },
    body: JSON.stringify({ client_message_id: command.clientId, membership_epoch: 1, body: 'Hello' }),
  }));
  expect(result.status).toBe(403);
  expect((await pg.query('SELECT * FROM chat_messages')).rows).toEqual([]);
});
