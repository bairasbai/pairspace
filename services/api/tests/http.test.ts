import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createChatHandler } from '../src/http.ts';
import { closeCouple } from '../src/chat.ts';
import { adapter, identityPrincipal, c1, c2, command, createFixture, failOn, history, id, principal, u2, u3, u4 } from './fixtures.ts';
let pg: PGlite;
beforeEach(async () => { pg = await createFixture(); });
afterEach(async () => { await pg.close(); });
const req = (body: unknown = command, token = 'one', path = '/chat/send', headers: Record<string, string> = {}) => {
  const fields = body as Record<string, unknown> | null;
  const couple = fields?.coupleId ?? c1;
  const url = new URL(`https://test.invalid/v1/couples/${couple}/chat/messages`);
  const reading = path === '/chat/history';
  if (reading) {
    url.searchParams.set('membership_epoch', String(fields?.membershipEpoch ?? 1));
    url.searchParams.set('limit', String(fields?.limit ?? 50));
  }
  return new Request(url, { method: reading ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': command.clientId, ...headers },
    ...(reading ? {} : { body: JSON.stringify(fields && { ...fields, client_message_id: fields.clientId, membership_epoch: fields.membershipEpoch }) }),
  });
};
const sessions = () => new Map([['one', principal], ['two', identityPrincipal(u2)], ['three', identityPrincipal(u3)], ['four', identityPrincipal(u4)]]);
describe('in-process HTTP boundary with synthetic test sessions', () => {
  it('isolates two couples/four accounts and ignores forged sender', async () => {
    const tokens = sessions();
    const handler = createChatHandler(adapter(pg), async token => tokens.get(token) ?? null);
    for (const [token, coupleId] of [['one', c1], ['two', c1], ['three', c2], ['four', c2]]) {
      const result = await handler(req({ ...command, coupleId, senderId: id(999) }, token));
      expect(result.status).toBe(201);
      const json = await result.json() as { value: { message: { senderId: string } } };
      expect(json.value.message.senderId).toBe(tokens.get(token)?.userId);
      expect(result.headers.get('cache-control')).toBe('no-store');
    }
    expect((await handler(req(history, 'three', '/chat/history'))).status).toBe(403);
    const result = await handler(req(history, 'two', '/chat/history'));
    expect((await result.json() as { value: { messages: unknown[] } }).value.messages).toHaveLength(2);
    expect((await handler(req(command, 'one'))).status).toBe(200);
    expect((await handler(req({ ...command, body: 'different' }))).status).toBe(409);
    expect((await handler(req({ ...command, membershipEpoch: 2 }))).status).toBe(409);
    await closeCouple(adapter(pg), principal, c1, 1);
    expect((await handler(req(command))).status).toBe(403);
  });
  it('rejects missing/expired/revoked/forged identity and redacts verifier/DB errors', async () => {
    const tokens = sessions();
    const handler = createChatHandler(adapter(pg), async token => tokens.get(token) ?? null);
    for (const token of ['expired', 'invented']) expect((await handler(req(command, token))).status).toBe(401);
    tokens.delete('one');
    expect((await handler(req(command))).status).toBe(401);
    expect((await handler(req(command, 'two', '/chat/send', { authorization: '' }))).status).toBe(401);
    expect((await createChatHandler(adapter(pg), async () => (identityPrincipal('bad')))(req())).status).toBe(401);
    for (const broken of [createChatHandler(adapter(pg), async () => { throw new Error('secret token'); }),
      createChatHandler(failOn(adapter(pg), 'SELECT'), async () => principal)]) {
      const result = await broken(req());
      expect(result.status).toBe(503);
      expect(await result.json()).toEqual({ ok: false, error: 'temporarily_unavailable' });
    }
  });
  it('bounds and validates HTTP input, paths and method', async () => {
    const handler = createChatHandler(adapter(pg), async () => principal);
    expect((await handler(new Request('https://test.invalid/no'))).status).toBe(404);
    const wrongMethod = await handler(new Request(`https://test.invalid/v1/couples/${c1}/chat/messages`, { method: 'DELETE' }));
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('allow')).toBe('GET, POST');
    expect((await handler(req(command, 'one', '/chat/send', { 'content-type': 'text/plain' }))).status).toBe(415);
    for (const input of [null, [], {}, { ...command, clientId: 1 }, { ...command, clientId: id(999) }, { ...command, body: '' }, { ...command, body: 'x'.repeat(8001) }]) {
      expect((await handler(req(input))).status).toBe(400);
    }
    expect((await handler(req({ ...history, limit: 101 }, 'one', '/chat/history'))).status).toBe(400);
    for (const body of ['{', 'x'.repeat(65537), new Uint8Array([255])]) {
      const request = req();
      expect((await handler(new Request(request.url, { method: 'POST', headers: request.headers, body }))).status).toBe(400);
    }
    const paged = req(history, 'one', '/chat/history');
    const url = new URL(paged.url); url.searchParams.set('beforeSeq', '1');
    expect((await handler(new Request(url, { headers: paged.headers }))).status).toBe(200);
    url.searchParams.delete('limit');
    expect((await handler(new Request(url, { headers: paged.headers }))).status).toBe(200);
    const request = req();
    expect((await handler(new Request(request.url, { method: 'POST', headers: request.headers }))).status).toBe(400);
  });
});
