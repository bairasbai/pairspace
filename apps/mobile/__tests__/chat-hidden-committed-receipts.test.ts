import { createChatTransport, type TransportSession } from '../src/chat/transport';
import { sendChatReply } from '../src/chat/reply-transport';
import { editChatMessage } from '../src/chat/edit-transport';
import { deleteChatMessage } from '../src/chat/delete-transport';
import { acknowledgeHidden, beginSend, createQueue, enqueue } from '../src/chat/queue';
import type { QueueResult, QueueState } from '../src/chat/types';
const id = (n: number) => `abcdef00-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope = { userId: id(1), coupleId: id(2), membershipEpoch: 1, sessionId: 'session' };
const session: TransportSession = { scope, token: 'cookie', credentialGeneration: 1 };
const hidden = () => ({ id: id(3), coupleId: id(2), senderId: id(1), clientId: id(4), seq: 1,
  version: 1, createdAt: '2026-11-12T00:00:00.000Z', replyToId: null, deletedAt: null });
const stateOf = (result: QueueResult) => { if (!result.ok) throw Error(result.error); return result.state; };
const response = (value: unknown) => Response.json({ ok: true, value }, { headers: { 'X-Chat-Visibility-Revision': '2' } });
function plain(value: unknown, permitted = true) {
  let state = stateOf(enqueue(createQueue(scope), scope, id(4), 'secret text'));
  const acceptHiddenReceipt = jest.fn(async () => permitted);
  const transport = createChatTransport({ baseUrl: 'https://example.test', request: async () => response(value),
    getCredentialGeneration: () => 1, store: { get: () => state, set: (next: QueueState) => { state = next; } }, acceptHiddenReceipt });
  return { send: () => transport.send(id(4), session), state: () => state, acceptHiddenReceipt };
}
describe('hidden committed receipts never publish plaintext', () => {
  test('plain exact receipt accepts queue without body and invokes verifier', async () => {
    const h = plain({ replay: true, hiddenMessage: hidden() });
    expect(await h.send()).toEqual({ ok: true, value: { replay: true, hidden: true } });
    expect(h.state().messages[0]).toMatchObject({ status: 'accepted', hidden: true, body: null, serverId: id(3) });
    expect(h.acceptHiddenReceipt).toHaveBeenCalledWith('cookie', 2, hidden(), expect.any(Function));
    const denied = plain({ replay: true, hiddenMessage: hidden() }, false);
    expect(await denied.send()).toEqual({ ok: false, error: 'visibility_changed' });
  });
  test('plain mixed body and identity mismatch reject without hidden acceptance', async () => {
    const values = [{ replay: false, hiddenMessage: hidden() }, { replay: true, hiddenMessage: { ...hidden(), body: 'secret' } },
      { replay: true, hiddenMessage: hidden(), message: { body: 'secret' } },
      ...[{ senderId: id(8) }, { coupleId: id(8) }, { clientId: id(8) }, { replyToId: id(8) }]
        .map(patch => ({ replay: true, hiddenMessage: { ...hidden(), ...patch } }))];
    for (const value of values) {
      const h = plain(value); expect(await h.send()).toEqual({ ok: false, error: 'invalid_response' });
      expect(h.acceptHiddenReceipt).not.toHaveBeenCalled();
    }
  });
  test('reply receipt pins target and command while allowing later metadata version', async () => {
    const metadata = { ...hidden(), replyToId: id(8), version: 4 };
    const send = (value: unknown) => sendChatReply('https://example.test', session,
      { clientId: id(4), replyToId: id(8), body: 'draft' }, async () => response(value));
    expect(await send({ replay: true, hiddenMessage: metadata })).toEqual({ ok: true, value: { replay: true, hiddenMessage: metadata }, visibilityRevision: 2 });
    for (const value of [{ replay: false, hiddenMessage: metadata }, { replay: true, hiddenMessage: { ...metadata, body: null } },
      { replay: true, hiddenMessage: { ...metadata, replyToId: id(7) } },
      { replay: true, hiddenMessage: { ...metadata, clientId: id(7) } }, { replay: true, hiddenMessage: metadata, message: metadata }]) {
      expect(await send(value)).toEqual({ ok: false, error: 'invalid_response' });
    }
  });
  test('edit hidden replay validates full immutable identity and higher canonical revision', async () => {
    const source = hidden();
    const target = { id: source.id, coupleId: source.coupleId, senderId: source.senderId, clientId: source.clientId,
      seq: source.seq, version: source.version, createdAt: source.createdAt, replyToId: source.replyToId };
    const send = (value: unknown) => editChatMessage('https://example.test', session,
      { message: target, commandId: id(9), body: 'new draft' }, async () => response(value));
    const metadata = { ...hidden(), version: 5 };
    expect(await send({ replay: true, commandId: id(9), hiddenMessage: metadata })).toEqual({ ok: true,
      value: { replay: true, commandId: id(9), hiddenMessage: metadata }, visibilityRevision: 2 });
    for (const value of [{ replay: false, commandId: id(9), hiddenMessage: metadata },
      { replay: true, commandId: id(7), hiddenMessage: metadata },
      ...[{ seq: 2 }, { id: id(7) }, { version: 0 }, { body: 'secret' }, { createdAt: '2026-11-13T00:00:00.000Z' }]
        .map(patch => ({ replay: true, commandId: id(9), hiddenMessage: { ...metadata, ...patch } }))]) {
      expect(await send(value)).toEqual({ ok: false, error: 'invalid_response' });
    }
  });
  test('delete hidden replay requires true terminal metadata, never an inferred tombstone', async () => {
    const source = hidden();
    const target = { id: source.id, coupleId: source.coupleId, senderId: source.senderId, clientId: source.clientId,
      seq: source.seq, version: source.version, createdAt: source.createdAt, replyToId: source.replyToId };
    const send = (metadata: unknown) => deleteChatMessage('https://example.test', session,
      { message: target, commandId: id(9) }, async () => response({ commandId: id(9), replay: true, hiddenMessage: metadata }));
    const terminal = { ...hidden(), version: 2, deletedAt: '2026-11-13T00:00:00.000Z' };
    expect(await send(terminal)).toEqual({ ok: true, value: { commandId: id(9), replay: true, hiddenMessage: terminal }, visibilityRevision: 2 });
    for (const metadata of [hidden(), { ...terminal, version: 1 }, { ...terminal, senderId: id(7) },
      { ...terminal, body: null }, { ...terminal, deletedAt: 'bad' }]) {
      expect(await send(metadata)).toEqual({ ok: false, error: 'invalid_response' });
    }
  });
  test('queue acknowledgment clears both bodies and rejects mismatched or unattempted commands', () => {
    const queued = stateOf(enqueue(createQueue(scope), scope, id(4), 'secret'));
    expect(acknowledgeHidden(queued, scope, hidden()).ok).toBe(false);
    const sending = stateOf(beginSend(queued, scope, id(4)));
    const accepted = stateOf(acknowledgeHidden(sending, scope, hidden()));
    expect(accepted.messages[0]).toMatchObject({ hidden: true, body: null, canonicalBody: undefined, status: 'accepted' });
    const newer = stateOf(acknowledgeHidden(accepted, scope, { ...hidden(), version: 4 }));
    expect(newer.messages[0].version).toBe(4);
    expect(stateOf(acknowledgeHidden(newer, scope, hidden())).messages[0].version).toBe(4);
    for (const patch of [{ coupleId: id(7) }, { senderId: id(7) }, { clientId: id(7) }, { id: id(7) }, { seq: 2 }, { replyToId: id(7) }]) {
      expect(acknowledgeHidden(accepted, scope, { ...hidden(), ...patch }).ok).toBe(false);
    }
    expect(acknowledgeHidden(accepted, { ...scope, sessionId: 'other' }, hidden()).ok).toBe(false);
  });
});
