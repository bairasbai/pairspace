import { parseReconciliation, readReconciliation, replyAnchor } from '../src/chat/reconciliation';
import { displayMessage } from '../src/chat/reply-view';
import { redactUnavailable } from '../src/auth/reconciliation-redaction';
import { createQueue, enqueue, beginSend, acknowledge } from '../src/chat/queue';
import type { QueueResult } from '../src/chat/types';
import type { AuthView } from '../src/auth/auth-view';
const id = (n: number) => `abcdef00-0000-4000-8000-${String(n).padStart(12, '0')}`;
const message = (seq = 1) => ({ id: id(seq + 100), coupleId: id(2), senderId: id(1), clientId: id(seq + 200), seq,
  body: 'text', version: 1, createdAt: '2026-11-12T00:00:00.000Z', replyToId: null, deletedAt: null });
const selection = () => ({ messages: [displayMessage(message())] });
const wire = () => ({ readId: id(3), messages: [message()], unavailableIds: [], detail: null, replyTarget: null, latestVisible: { id: message().id, seq: 1 } });
const scope = { userId: id(1), coupleId: id(2), membershipEpoch: 1, sessionId: 'local' };
const session = { scope, token: 'cookie', credentialGeneration: 1 };
const stateOf = (r: QueueResult) => { if (!r.ok) throw Error(r.error); return r.state; };
describe('reconciliation strict partition and roles', () => {
  test('50 window rows plus separate detail and target, no contiguous seq assumption', () => {
    const messages = Array.from({ length: 50 }, (_, i) => message(2 * i + 1));
    const detail = message(102), target = message(105);
    const selected = { messages: messages.map(displayMessage), detail: displayMessage(detail), replyTarget: replyAnchor(displayMessage(target)) };
    const value = { ...wire(), messages, detail: { id: detail.id, message: detail }, replyTarget: { id: target.id, message: target }, latestVisible: { id: id(999), seq: 110 } };
    expect(parseReconciliation(value, id(2), id(3), selected)?.messages).toHaveLength(50);
    expect(parseReconciliation({ ...value, latestVisible: { id: target.id, seq: target.seq } }, id(2), id(3), selected)).not.toBeNull();
  });
  test('ordered partition rejects unknown, duplicate and reordered IDs', () => {
    const selected = { messages: [1, 3, 7].map(n => displayMessage(message(n))) };
    const value = { ...wire(), messages: [message(1), message(7)], unavailableIds: [message(3).id], latestVisible: { id: message(7).id, seq: 7 } };
    expect(parseReconciliation(value, id(2), id(3), selected)).not.toBeNull();
    for (const patch of [{ unavailableIds: [id(999)] }, { messages: [message(7), message(1)] },
      { unavailableIds: [message(3).id, message(3).id] }, { messages: [message(1), message(1)] },
      { readId: id(9) }, { extra: true }, { latestVisible: null }, { latestVisible: { id: id(999), seq: 7 } }]) {
      expect(parseReconciliation({ ...value, ...patch }, id(2), id(3), selected)).toBeNull();
    }
    expect(parseReconciliation({ ...wire(), messages: [], unavailableIds: [message().id], latestVisible: null }, id(2), id(3), selection())).not.toBeNull();
  });
  test('immutable identity and crossrole contradictions fail closed', () => {
    for (const patch of [{ seq: 2 }, { senderId: id(8) }, { clientId: id(8) }, { coupleId: id(8) },
      { createdAt: '2026-11-13T00:00:00.000Z' }, { replyToId: id(8) }]) {
      expect(parseReconciliation({ ...wire(), messages: [{ ...message(), ...patch }] }, id(2), id(3), selection())).toBeNull();
    }
    const selected = { ...selection(), detail: displayMessage(message()), replyTarget: replyAnchor(displayMessage(message())) };
    const value = { ...wire(), detail: { id: message().id, message: message() }, replyTarget: { id: message().id, message: message() } };
    expect(parseReconciliation(value, id(2), id(3), selected)).not.toBeNull();
    for (const patch of [{ detail: null }, { detail: { id: id(9), message: message() } },
      { detail: { id: message().id, message: null } }, { replyTarget: { id: message().id, message: { ...message(), version: 2, body: 'changed' } } }]) {
      expect(parseReconciliation({ ...value, ...patch }, id(2), id(3), selected)).toBeNull();
    }
    expect(parseReconciliation(value, id(2), id(3), selection())).toBeNull();
    const roles = { messages: [], detail: displayMessage(message()), replyTarget: replyAnchor(displayMessage(message())) };
    expect(parseReconciliation({ ...value, messages: [], replyTarget: { id: message().id, message: null } }, id(2), id(3), roles)).toBeNull();
    expect(parseReconciliation({ ...value, messages: [], unavailableIds: [message().id], detail: { id: message().id, message: null }, replyTarget: { id: message().id, message: null }, latestVisible: null }, id(2), id(3), selected)).not.toBeNull();
    for (const latestVisible of [{ id: 'bad', seq: 1 }, { id: message().id, seq: 0 }, { id: message().id, seq: 9 }, { id: id(9), seq: 0 }]) {
      expect(parseReconciliation({ ...wire(), latestVisible }, id(2), id(3), selection())).toBeNull();
    }
  });
  test('transport binds nonce and captures selection while only issuing explicit GET', async () => {
    const selected = selection(); const request = jest.fn(async (req: Request) => {
      expect(req.method).toBe('GET'); expect(req.body).toBeNull(); expect(req.headers.get('authorization')).toBe('Bearer cookie');
      const url = new URL(req.url); expect(url.searchParams.get('message_ids')).toBe(message().id);
      expect(url.searchParams.get('membership_epoch')).toBe('1'); selected.messages.length = 0;
      return Response.json({ ok: true, value: wire() }, { headers: { 'X-Chat-Visibility-Revision': '4' } });
    });
    expect((await readReconciliation('https://example.test', session, selected, id(3), request)).ok).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    for (const selectedBad of [{ messages: Array(51).fill(displayMessage(message())) }, { messages: [displayMessage(message()), displayMessage(message())] },
      { messages: [], detail: { ...displayMessage(message()), id: 'bad' } }]) {
      expect(await readReconciliation('https://example.test', session, selectedBad, id(3), request)).toEqual({ ok: false, error: 'invalid_request' });
    }
    for (const status of [401, 403]) {
      const run = (nonce: string) => readReconciliation('https://example.test', session, selection(), id(3), async () => Response.json({ ok: false, error: 'unavailable', readId: nonce }, { status }));
      expect(await run(id(9))).toEqual({ ok: false, error: 'invalid_response' });
      expect(await run(id(3))).toEqual({ ok: false, error: status === 401 ? 'auth_required' : 'access_required' });
    }
    expect(await readReconciliation('https://example.test', session, selection(), id(3), async () => Response.json({ ok: true, value: { ...wire(), readId: id(9) } }))).toEqual({ ok: false, error: 'invalid_response' });
  });
});
describe('unavailable redaction is not deletion', () => {
  test('removes source-derived text but preserves independently edited private drafts', () => {
    let queue = stateOf(enqueue(createQueue(scope), scope, message().clientId, 'text'));
    queue = stateOf(beginSend(queue, scope, message().clientId));
    queue = stateOf(acknowledge(queue, scope, { clientId: message().clientId, serverId: message().id, senderId: id(1), seq: 1, version: 1, body: 'text' }));
    const view: AuthView = { phase: 'signed_in', error: null, draft: 'private new draft', messages: [displayMessage(message()), displayMessage(message(2))],
      replyDetail: displayMessage(message()), replyTarget: { id: message().id, senderId: id(1), preview: 'text' }, outgoing: { body: 'text', status: 'sent' } };
    const pending = { id: message().clientId, revision: 1 };
    const result = redactUnavailable(view, queue, [message().id], pending, 2, message().clientId);
    expect(result.view.draft).toBe('private new draft'); expect(result.view.messages.map(m => m.id)).toEqual([message(2).id]);
    expect(result.view.replyDetail).toBeUndefined(); expect(result.view.replyTarget).toBeUndefined(); expect(result.view.outgoing).toBeUndefined();
    expect(result.queue!.messages[0]).toMatchObject({ body: null, deleted: false }); expect(pending).toMatchObject({ redacted: true });
    expect(redactUnavailable(view, queue, [message().id], pending, 1, message().clientId).view.draft).toBe('');
    expect(redactUnavailable(view, null, [], null, 2, null)).toEqual({ view, queue: null });
  });
});
