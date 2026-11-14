import { readFile } from 'node:fs/promises';
import { beforeAll, afterAll, it, expect } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createFixture, adapter, principal, identityPrincipal, u2, u3, c1, c2, id, failOn } from './fixtures.ts';
import { sendMessage } from '../src/chat.ts';
import { setChatVisibility } from '../src/chat-visibility.ts';
import { deleteChatMessage } from '../src/chat-deletion.ts';
import { reconcileChat } from '../src/chat-reconciliation.ts';
import { createChatReconciliationHandler } from '../src/chat-reconciliation-http.ts';
import { visibilityResponse } from '../src/chat-visibility-scope.ts';
import { bindSessionAuthority } from '../src/auth-authority.ts';
import { createSyntheticAuthority } from '../src/synthetic-authority.ts';
let pg: PGlite;
let roots: string[];
const scope = { coupleId: c1, membershipEpoch: 1 };
const input = (messageIds: string[] = roots) => ({ ...scope, readId: id(9700), messageIds });
beforeAll(async () => {
  pg = await createFixture();
  for (const name of ['020_chat_replies.sql', '021_chat_deletion_receipts.sql', '022_chat_message_edits.sql', '023_chat_personal_visibility.sql']) {
    await pg.transaction(async tx => { await tx.exec(await readFile(new URL('../migrations/' + name, import.meta.url), 'utf8')); });
  }
  roots = [];
  for (let n = 0; n < 3; n++) {
    const result = await sendMessage(adapter(pg), principal, { ...scope, clientId: id(9710 + n), body: 'Synthetic ' + n });
    if (!result.ok) throw Error('seed');
    roots.push(result.value.message.id);
  }
});
afterAll(async () => { await pg.close(); });
it('returns exact request order, uniform unavailable, independent detail and metadata-only latest', async () => {
  const db = adapter(pg);
  const requested = [roots[1], id(9800), roots[0]];
  const result = await reconcileChat(db, principal, { ...input(requested), detailId: roots[2], replyTargetId: roots[0] });
  if (!result.ok) throw Error('read');
  expect(result.value.messages.map(m => m.id)).toEqual([roots[1], roots[0]]);
  expect(result.value.unavailableIds).toEqual([id(9800)]);
  expect(result.value.detail?.message?.id).toBe(roots[2]);
  expect(result.value.replyTarget?.message?.id).toBe(roots[0]);
  expect(result.value.latestVisible).toEqual({ id: roots[2], seq: 3 });
  expect(await reconcileChat(db, principal, { ...input([]), detailId: id(9800) })).toMatchObject({ ok: true, value: { messages: [], detail: { message: null } } });
  expect(await reconcileChat(db, identityPrincipal(u3), { ...input([]), coupleId: c2 })).toMatchObject({ ok: true, value: { latestVisible: null } });
});
it('excludes hidden before selecting body; partner remains unchanged and visible deletion is canonical', async () => {
  const db = adapter(pg);
  expect(await setChatVisibility(db, principal, { ...scope, messageId: roots[2], commandId: id(9801), expectedVersion: 0, hidden: true })).toMatchObject({ ok: true });
  const result = await reconcileChat(db, principal, { ...input(), detailId: roots[2] });
  expect(result).toMatchObject({ ok: true, value: { unavailableIds: [roots[2]], detail: { message: null }, latestVisible: { id: roots[1] } } });
  expect(await reconcileChat(db, identityPrincipal(u2), input())).toMatchObject({ ok: true, value: { unavailableIds: [], latestVisible: { id: roots[2] } } });
  expect(await deleteChatMessage(db, principal, { ...scope, messageId: roots[0], commandId: id(9802), expectedVersion: 1, scope: 'everyone' })).toMatchObject({ ok: true });
  expect(await reconcileChat(db, principal, { ...input([roots[0]]), detailId: roots[0] })).toMatchObject({ ok: true, value: { messages: [{ body: null, version: 2 }], detail: { message: { body: null } } } });
});
it('rejects invalid bounds/duplicates/scopes and rechecks authority after pair wait', async () => {
  const db = adapter(pg);
  for (const value of [null, [], {}, { ...input(), extra: 1 }, { ...input(), detailId: null }, { ...input(), replyTargetId: null }, input(['bad']), input([roots[0], roots[0].toUpperCase()]), input(Array(51).fill(id(9900)))]) {
    expect(await reconcileChat(db, principal, value)).toEqual({ ok: false, error: 'invalid_request' });
  }
  expect(await reconcileChat(db, { ...principal, userId: 'bad' }, input())).toEqual({ ok: false, error: 'unavailable' });
  expect(await reconcileChat(db, { ...principal, tokenExpiresAt: 1 }, input())).toEqual({ ok: false, error: 'unavailable' });
  expect(await reconcileChat(db, identityPrincipal(u3), input())).toEqual({ ok: false, error: 'unavailable' });
  expect(await reconcileChat(db, principal, { ...input(), membershipEpoch: 2 })).toEqual({ ok: false, error: 'stale_membership' });
  let checks = 0;
  expect(await reconcileChat({ ...db, sessionAuthority: { ...db.sessionAuthority, recheck: async () => ++checks === 1 } }, principal, input())).toEqual({ ok: false, error: 'unavailable' });
});
it('HTTP strict query, nonce, authorization, errors and same-transaction revision wrapper', async () => {
  const db = adapter(pg);
  const bound = bindSessionAuthority(db, createSyntheticAuthority(async () => principal));
  const handler = visibilityResponse(bound, createChatReconciliationHandler);
  const base = `http://localhost/v1/couples/${c1}/chat/reconcile`;
  const query = `membership_epoch=1&read_id=${id(9700)}&message_ids=`;
  const request = (q = query, method = 'GET') => new Request(base + '?' + q, { method, headers: { authorization: 'Bearer synthetic', 'X-Chat-Visibility': '1' } });
  const response = await handler(request());
  expect(response.status).toBe(200);
  expect(response.headers.get('X-Chat-Visibility-Revision')).toBe('1');
  for (const q of ['', query + '&extra=x', query + '&read_id=' + id(9700), query.replace('membership_epoch=1', 'membership_epoch=x'), query.replace(id(9700), 'bad'), query + 'x'.repeat(1850), query + 'bad', query + '&detail_id=bad', query + '&reply_target_id=bad']) {
    expect((await handler(request(q))).status).toBe(400);
  }
  expect((await handler(request(query.replace('membership_epoch=1', 'membership_epoch=2')))).status).toBe(409);
  expect((await handler(request(undefined, 'POST'))).status).toBe(405);
  expect((await handler(new Request(base + '/invalid'))).status).toBe(404);
  expect((await createChatReconciliationHandler(bindSessionAuthority(db, createSyntheticAuthority(async () => null)))(request())).status).toBe(401);
  expect((await createChatReconciliationHandler(bindSessionAuthority(db, createSyntheticAuthority(async () => identityPrincipal(u3))))(request())).status).toBe(403);
  expect(await (await createChatReconciliationHandler(bindSessionAuthority(failOn(db, 'FROM couples'), createSyntheticAuthority(async () => principal)))(request())).json()).toMatchObject({ error: 'temporarily_unavailable', readId: id(9700) });
});

it('accepts 50 window identities plus two explicit roles, duplicates across roles only, empty roles null', async () => {
  const db = adapter(pg);
  const ids = Array.from({ length: 50 }, (_, n) => id(10000 + n));
  const full = await reconcileChat(db, principal, { ...input(ids), detailId: roots[0], replyTargetId: roots[1] });
  expect(full).toMatchObject({ ok: true, value: { messages: [], unavailableIds: ids, detail: { message: { id: roots[0] } }, replyTarget: { message: { id: roots[1] } } } });
  expect(await reconcileChat(db, principal, { ...input([roots[1]]), detailId: roots[1], replyTargetId: roots[1] })).toMatchObject({ ok: true, value: { messages: [{ id: roots[1] }], detail: { message: { id: roots[1] } }, replyTarget: { message: { id: roots[1] } } } });
  expect(await reconcileChat(db, principal, { ...input([]), replyTargetId: roots[2] })).toMatchObject({ ok: true, value: { detail: null, replyTarget: { id: roots[2], message: null } } });
  expect(await reconcileChat(db, principal, input([]))).toMatchObject({ ok: true, value: { detail: null, replyTarget: null } });
  const handler = createChatReconciliationHandler(bindSessionAuthority(db, createSyntheticAuthority(async () => principal)));
  const request = new Request(`http://localhost/v1/couples/${c1}/chat/reconcile?membership_epoch=1&read_id=${id(9700)}&message_ids=&detail_id=${roots[0]}&reply_target_id=${roots[1]}`, { headers: { authorization: 'Bearer synthetic' } });
  expect((await handler(request)).status).toBe(200);
});
