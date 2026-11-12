import { readReplyWindow, readReplyDetail, sendChatReply } from '../src/chat/reply-transport';
import type { HistoryWindowOptions } from '../src/chat/history-window';
import type { TransportSession } from '../src/chat/transport';
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const session = (): TransportSession => ({ scope: { userId: id(1), coupleId: id(2), membershipEpoch: 1, sessionId: 'local' }, token: 'token', credentialGeneration: 1 });
const options = (): HistoryWindowOptions => ({ direction: 'latest', readId: id(3) });
const message = (seq = 1) => ({ id: id(10 + seq), coupleId: id(2), senderId: id(1), clientId: id(20 + seq),
  seq, replyToId: null, deletedAt: null, body: ' Text\nline ', version: 1, createdAt: '2026-11-12 12:00:00.123456+00' });
const page = () => ({ messages: [message()], readId: id(3), hasOlder: false, hasNewer: false, olderCursor: null, newerCursor: null });
const read = (value: unknown, opts = options(), status = 200, current = session()) =>
  readReplyWindow('https://example.test', current, opts, async () => Response.json(value, { status }));

describe('read-only chat history window transport', () => {
  test('constructs scoped GET with bearer/cookie and never writes', async () => {
    const request = jest.fn(async (req: Request) => {
      expect(req.method).toBe('GET'); expect(req.body).toBeNull();
      expect(req.url).toBe(`https://example.test/v1/couples/${id(2)}/chat/reply-window?membership_epoch=1&read_id=${id(3)}&direction=latest`);
      expect(req.headers.get('authorization')).toBe('Bearer token');
      expect(req.redirect).toBe('error'); expect(req.credentials).toBe('omit'); expect(req.cache).toBe('no-store');
      return Response.json({ ok: true, value: page() });
    });
    expect((await readReplyWindow('https://example.test/path', session(), options(), request)).ok).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    await readReplyWindow('https://example.test/path', { ...session(), credentialKind: 'cookie', token: 'sid=value' }, options(), async req => {
      expect(req.headers.get('cookie')).toBe('sid=value'); expect(req.headers.get('origin')).toBe('https://example.test');
      expect(req.headers.has('authorization')).toBe(false); return Response.json({ ok: true, value: page() });
    });
  });
  test('rejects invalid input without networking; HTTP only explicit loopback', async () => {
    const request = jest.fn(async () => Response.json({ ok: true, value: page() }));
    for (const url of ['bad', 'http://example.test', 'https://user:pass@example.test']) {
      expect(await readReplyWindow(url, session(), options(), request)).toEqual({ ok: false, error: 'invalid_request' });
    }
    for (const opts of [{ ...options(), readId: 'bad' }, { ...options(), anchorSeq: 1, anchorId: id(11) }, { ...options(), direction: 'before' as const }]) {
      expect(await readReplyWindow('https://example.test', session(), opts, request)).toEqual({ ok: false, error: 'invalid_request' });
    }
    for (const token of ['', 'bad\nvalue', 'x'.repeat(2049)]) {
      expect(await read({}, options(), 200, { ...session(), token })).toEqual({ ok: false, error: 'invalid_token' });
    }
    expect(await read({}, options(), 200, { ...session(), credentialKind: 'cookie', token: 'a\nb' })).toEqual({ ok: false, error: 'invalid_token' });
    expect(request).not.toHaveBeenCalled();
    expect((await readReplyWindow('http://127.0.0.1:4000', session(), { ...options(), allowHttpLoopbackForTests: true }, request)).ok).toBe(true);
    expect(await readReplyWindow('http://127.0.0.1:4000', session(), options(), request)).toEqual({ ok: false, error: 'invalid_request' });
  });
  test('exact message and page validation, scoped IDs and canonical text', async () => {
    expect((await read({ ok: true, value: page() })).ok).toBe(true);
    for (const patch of [{ coupleId: id(9) }, { seq: 0 }, { version: 0 }, { id: 'bad' }, { clientId: 'bad' },
      { senderId: 'bad' }, { id: 'ABCDEF00-0000-4000-8000-000000000001' },
      { senderId: 'ABCDEF00-0000-4000-8000-000000000001' }, { clientId: 'ABCDEF00-0000-4000-8000-000000000001' },
      { replyToId: 'ABCDEF00-0000-4000-8000-000000000001' }, { body: 'a\r\nb' }, { body: '😀'.repeat(8001) }, { createdAt: 'bad' }, { secret: true }]) {
      expect(await read({ ok: true, value: { ...page(), messages: [{ ...message(), ...patch }] } })).toEqual({ ok: false, error: 'invalid_response' });
    }
    for (const patch of [{ readId: id(9) }, { hasNewer: true }, { olderCursor: { id: id(11), seq: 1 } }, { hasOlder: true },
      { messages: [message(2), message(1)] }, { messages: [message(), { ...message(2), id: message().id }] },
      { messages: [message(), { ...message(2), clientId: message().clientId }] }, { messages: Array(51).fill(message()) },
      { messages: [], hasOlder: true, olderCursor: { id: id(11), seq: 1 } }, { secret: true }]) {
      expect(await read({ ok: true, value: { ...page(), ...patch } })).toEqual({ ok: false, error: 'invalid_response' });
    }
    expect(await read({ ok: true, value: page(), extra: 1 })).toEqual({ ok: false, error: 'invalid_response' });
    expect(await read(null)).toEqual({ ok: false, error: 'invalid_response' });
  });
  test('before/after bounds and cursor edge identity', async () => {
    const middle = { ...page(), hasOlder: true, hasNewer: true, olderCursor: { id: id(11), seq: 1 }, newerCursor: { id: id(11), seq: 1 } };
    expect((await read({ ok: true, value: middle }, { ...options(), direction: 'before', anchorSeq: 2, anchorId: id(12) })).ok).toBe(true);
    expect((await read({ ok: true, value: { ...middle, messages: [message(3)], olderCursor: { id: id(13), seq: 3 }, newerCursor: { id: id(13), seq: 3 } } }, { ...options(), direction: 'after', anchorSeq: 2, anchorId: id(12) })).ok).toBe(true);
    for (const direction of ['before', 'after'] as const) {
      expect(await read({ ok: true, value: middle }, { ...options(), direction, anchorSeq: 1, anchorId: id(11) })).toEqual({ ok: false, error: 'invalid_response' });
    }
    expect(await read({ ok: true, value: middle }, { ...options(), direction: 'oldest' })).toEqual({ ok: false, error: 'invalid_response' });
    expect(await read({ ok: true, value: { ...middle, olderCursor: { id: id(12), seq: 2 } } }, { ...options(), direction: 'before', anchorSeq: 2, anchorId: id(12) })).toEqual({ ok: false, error: 'invalid_response' });
    expect((await read({ ok: true, value: { ...page(), messages: [] } }, { ...options(), direction: 'oldest' })).ok).toBe(true);
  });
  test('binds error nonce before classifying denial or retryability', async () => {
    for (const [status, error, expected] of [[401, 'unauthenticated', 'auth_required'], [403, 'unavailable', 'access_required'],
      [400, 'invalid_cursor', 'invalid_cursor'], [429, 'rate', 'rate_limited'], [503, 'temporarily_unavailable', 'transport_error'],
      [409, 'stale_membership', 'access_required'], [409, 'other_conflict', 'rejected']] as const) {
      expect(await read({ ok: false, error, readId: id(3) }, options(), status)).toEqual({ ok: false, error: expected });
      expect(await read({ ok: false, error, readId: id(9) }, options(), status)).toEqual({ ok: false, error: 'invalid_response' });
    }
    expect(await read({ ok: false, error: 'unauthenticated' }, options(), 401)).toEqual({ ok: false, error: 'invalid_response' });
    expect(await read({ ok: true, value: page() }, options(), 403)).toEqual({ ok: false, error: 'invalid_response' });
  });
  test('transport and malformed/oversized JSON failures are bounded', async () => {
    expect(await readReplyWindow('https://example.test', session(), options(), async () => { throw Error('offline'); })).toEqual({ ok: false, error: 'transport_error' });
    for (const response of [new Response('bad'), new Response(null), new Response(' '.repeat(4 * 1024 * 1024 + 1))]) {
      expect(await readReplyWindow('https://example.test', session(), options(), async () => response)).toEqual({ ok: false, error: 'invalid_response' });
    }
  });
  test('copies caller options before awaiting response', async () => {
    const mutable = { ...options() };
    const result = await readReplyWindow('https://example.test', session(), mutable, async () => {
      mutable.readId = id(9); mutable.direction = 'oldest'; return Response.json({ ok: true, value: page() });
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(Object.isFrozen(result.value.messages)).toBe(true);
  });
});


describe('reply detail and immutable send contract', () => {
  const command = () => ({ clientId: id(21), body: ' Text\nline ', replyToId: id(99) });
  const ack = () => ({ ...message(), replyToId: id(99) });
  test('detail nonce, scope and expected identity', async () => {
    const detail = { message: message(), readId: id(3) };
    const run = (value: unknown) => readReplyDetail('https://example.test', session(), { messageId: id(11), readId: id(3) }, async req => {
      expect(new URL(req.url).searchParams.get('message_id')).toBe(id(11));
      return Response.json({ ok: true, value });
    });
    expect(await run(detail)).toEqual({ ok: true, value: message() });
    const tombstone = { ...message(), body: null, deletedAt: '2026-11-13T00:00:00.000Z' };
    expect(await run({ ...detail, message: tombstone })).toEqual({ ok: true, value: tombstone });
    for (const patch of [{ body: null, deletedAt: null }, { body: 'live', deletedAt: tombstone.deletedAt }, { body: null, deletedAt: 'bad' }, { deletedAt: undefined }]) {
      expect(await run({ ...detail, message: { ...message(), ...patch } })).toEqual({ ok: false, error: 'invalid_response' });
    }
    for (const value of [{ ...detail, readId: id(9) }, { ...detail, message: message(2) },
      { ...detail, message: { ...message(), replyToId: undefined } },
      { ...detail, message: { ...message(), replyToId: message().id } }, { ...detail, extra: 1 }]) {
      expect(await run(value)).toEqual({ ok: false, error: 'invalid_response' });
    }
    expect(await readReplyDetail('https://example.test', session(), { messageId: 'bad', readId: id(3) }, jest.fn())).toEqual({ ok: false, error: 'invalid_request' });
  });
  test('POST exact command, header and normalization; ACK binds all command fields', async () => {
    const run = (value: unknown) => sendChatReply('https://example.test', session(), command(), async req => {
      expect(req.method).toBe('POST'); expect(req.headers.get('idempotency-key')).toBe(id(21));
      expect(await req.json()).toEqual({ membership_epoch: 1, client_message_id: id(21), body: command().body, reply_to_id: id(99) });
      return Response.json({ ok: true, value });
    });
    expect(await run({ message: ack(), replay: false })).toEqual({ ok: true, value: { message: ack(), replay: false } });
    expect((await run({ message: ack(), replay: true })).ok).toBe(true);
    for (const patch of [{ body: null, deletedAt: '2026-11-13T00:00:00.000Z' }, { senderId: id(4) }, { clientId: id(5) }, { replyToId: null }, { replyToId: id(98) }, { body: 'Other' }]) {
      expect(await run({ message: { ...ack(), ...patch }, replay: true })).toEqual({ ok: false, error: 'invalid_response' });
    }
    expect(await run({ message: ack(), replay: 'yes' })).toEqual({ ok: false, error: 'invalid_response' });
    const request = jest.fn();
    expect(await sendChatReply('https://example.test', session(), { ...command(), replyToId: 'bad' }, request)).toEqual({ ok: false, error: 'invalid_request' });
    expect(await sendChatReply('https://example.test', session(), { ...command(), body: '' }, request)).toEqual({ ok: false, error: 'empty_text' });
    expect(request).not.toHaveBeenCalled();
    expect((await sendChatReply('https://example.test', session(), { ...command(), body: 'a\r\nb' }, async req => {
      expect((await req.json()).body).toBe('a\nb');
      return Response.json({ ok: true, value: { message: { ...ack(), body: 'a\nb' }, replay: false } });
    })).ok).toBe(true);
  });
  test('write errors have no read nonce and snapshots survive caller mutation', async () => {
    const commandValue = command(), current = { ...session(), scope: { ...session().scope } };
    expect((await sendChatReply('https://example.test', current, commandValue, async () => {
      commandValue.replyToId = id(88); commandValue.body = 'Changed'; current.scope.userId = id(7);
      return Response.json({ ok: true, value: { message: ack(), replay: true } });
    })).ok).toBe(true);
    expect(await sendChatReply('https://example.test', session(), command(), async () =>
      Response.json({ ok: false, error: 'reply_unavailable' }, { status: 409 }))).toEqual({ ok: false, error: 'reply_unavailable' });
    expect(await readReplyDetail('https://example.test', session(), { messageId: id(11), readId: id(3) }, async () =>
      Response.json({ ok: false, error: 'unavailable', readId: id(9) }, { status: 403 }))).toEqual({ ok: false, error: 'invalid_response' });
  });
});
