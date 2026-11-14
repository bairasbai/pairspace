import { parseHiddenMessage, parseMessageVisibility, parseHiddenWindow } from '../src/chat/visibility-model';
import { readMessageVisibility, setMessageHidden, readHiddenWindow } from '../src/chat/visibility-transport';
import type { TransportSession } from '../src/chat/transport';
const id = (n: number) => `abcdef00-0000-4000-8000-${String(n).padStart(12, '0')}`;
const session = (): TransportSession => ({ scope: { userId: id(1), coupleId: id(2), membershipEpoch: 1, sessionId: 'local' }, token: 'token', credentialGeneration: 1 });
const visibility = { messageId: id(3), hidden: false, version: 0 };
const response = (value: unknown, revision: string | null = '0', status = 200) => Response.json(value, { status,
  headers: revision === null ? {} : { 'X-Chat-Visibility-Revision': revision } });
const meta = () => ({ id: id(3), coupleId: id(2), senderId: id(1), clientId: id(4), seq: 1, version: 1,
  createdAt: '2026-11-12 12:00:00+00', replyToId: null, deletedAt: null });
const row = () => ({ ...meta(), visibilityVersion: 1 });
const page = () => ({ messages: [row()], readId: id(5), hasOlder: false, hasNewer: false, olderCursor: null, newerCursor: null });
const read = (value: unknown, revision: string | null = '0', status = 200) => readMessageVisibility('https://example.test', session(),
  { messageId: id(3), readId: id(5) }, async () => response(value, revision, status));
describe('visibility metadata', () => {
  test('exact hidden receipts omit text without inventing deletion', () => {
    expect(parseHiddenMessage(meta(), id(2))).toEqual(meta());
    expect(parseHiddenMessage({ ...meta(), deletedAt: '2026-11-13T00:00:00.000Z' }, id(2))).not.toBeNull();
    for (const patch of [{ body: null }, { body: 'secret' }, { id: id(3).toUpperCase() }, { coupleId: id(7) },
      { seq: 0 }, { version: 0 }, { replyToId: id(3) }, { createdAt: 'bad' }, { deletedAt: 'bad' }]) {
      expect(parseHiddenMessage({ ...meta(), ...patch }, id(2))).toBeNull();
    }
    expect(parseMessageVisibility(visibility, id(3))).toEqual(visibility);
    expect(parseMessageVisibility({ ...visibility, hidden: true }, id(3))).toBeNull();
    expect(parseMessageVisibility({ ...visibility, version: -1 }, id(3))).toBeNull();
    expect(parseMessageVisibility({ ...visibility, body: 'secret' }, id(3))).toBeNull();
  });
  test('hidden window metadata, ASC edges and no duplicates', () => {
    const options = { direction: 'latest' as const, readId: id(5) };
    expect(parseHiddenWindow(page(), options, id(2))).toEqual(page());
    for (const patch of [{ readId: id(6) }, { hasNewer: true }, { hasOlder: true }, { messages: [row(), row()] },
      { messages: Array(51).fill(row()) }, { messages: [{ ...row(), body: 'secret' }] },
      { messages: [{ ...row(), visibilityVersion: 0 }] }, { messages: [{ ...row(), coupleId: id(9) }] }, { messages: [], hasOlder: true }]) {
      expect(parseHiddenWindow({ ...page(), ...patch }, options, id(2))).toBeNull();
    }
    const middle = { ...page(), hasOlder: true, hasNewer: true, olderCursor: { id: id(3), seq: 1 }, newerCursor: { id: id(3), seq: 1 } };
    expect(parseHiddenWindow(middle, { direction: 'before', readId: id(5), anchorSeq: 2 }, id(2))).not.toBeNull();
    expect(parseHiddenWindow(middle, { direction: 'before', readId: id(5), anchorSeq: 1 }, id(2))).toBeNull();
    expect(parseHiddenWindow(middle, { direction: 'after', readId: id(5), anchorSeq: 1 }, id(2))).toBeNull();
    expect(parseHiddenWindow(middle, { direction: 'oldest', readId: id(5) }, id(2))).toBeNull();
  });
});
describe('visibility transport', () => {
  test('read opt-in, nonce and mandatory revision', async () => {
    const result = await readMessageVisibility('https://example.test', session(), { messageId: id(3), readId: id(5) }, async req => {
      expect(req.method).toBe('GET'); expect(req.headers.get('x-chat-visibility')).toBe('1');
      expect(req.headers.get('authorization')).toBe('Bearer token');
      expect(new URL(req.url).searchParams.get('membership_epoch')).toBe('1');
      return response({ ok: true, value: { visibility, readId: id(5) } });
    });
    expect(result).toEqual({ ok: true, value: { visibility, readId: id(5), revision: 0 } });
    for (const revision of [null, '-1', '01', '9007199254740992', 'bad']) {
      expect(await read({ ok: true, value: { visibility, readId: id(5) } }, revision)).toEqual({ ok: false, error: 'invalid_response' });
    }
    expect(await read({ ok: true, value: { visibility, readId: id(6) } })).toEqual({ ok: false, error: 'invalid_response' });
  });
  test('denial nonce precedes auth classification; local conflicts preserve scope', async () => {
    for (const [status, error, expected] of [[401,'unauthenticated','auth_required'], [403,'unavailable','access_required'],
      [409,'stale_membership','access_required'], [409,'version_conflict','version_conflict'], [400,'invalid_cursor','invalid_cursor'],
      [409,'message_unavailable','message_unavailable'], [409,'idempotency_conflict','idempotency_conflict'],
      [409,'visibility_changed','visibility_changed'], [429,'limited','rate_limited'], [503,'temporarily_unavailable','transport_error'], [400,'invalid_request','rejected']] as const) {
      expect(await read({ ok: false, error, readId: id(5) }, status === 401 || status === 403 ? null : '0', status)).toEqual({ ok: false, error: expected });
      expect(await read({ ok: false, error, readId: id(6) }, '0', status)).toEqual({ ok: false, error: 'invalid_response' });
    }
  });
  test('PUT immutable command, no-op fresh version and later canonical replay', async () => {
    const command = { messageId: id(3), commandId: id(6), expectedVisibilityVersion: 0, hidden: true };
    const send = (value: unknown) => setMessageHidden('https://example.test', session(), command, async req => {
      expect(req.method).toBe('PUT'); expect(req.headers.get('idempotency-key')).toBe(id(6));
      expect(await req.json()).toEqual({ membership_epoch: 1, command_id: id(6), expected_visibility_version: 0, hidden: true });
      return response({ ok: true, value }, '1');
    });
    expect((await send({ commandId: id(6), replay: false, visibility: { ...visibility, hidden: true, version: 1 } })).ok).toBe(true);
    expect((await send({ commandId: id(6), replay: true, visibility: { ...visibility, version: 2 } })).ok).toBe(true);
    for (const value of [{ commandId: id(7), replay: false, visibility }, { commandId: id(6), replay: false, visibility },
      { commandId: id(6), replay: false, visibility: { ...visibility, hidden: true, version: 3 } }]) expect((await send(value)).ok).toBe(false);
    const same = { ...command, hidden: false };
    expect((await setMessageHidden('https://example.test', session(), same, async () => response({ ok: true, value: { commandId: id(6), replay: false, visibility } }))).ok).toBe(true);
  });
  test('hidden pagination pins visibility revision and anchor tuple', async () => {
    const options = { direction: 'before' as const, anchorId: id(8), anchorSeq: 2, visibilityRevision: 3, readId: id(5) };
    expect((await readHiddenWindow('https://example.test', session(), options, async req => {
      expect(new URL(req.url).searchParams.get('visibility_revision')).toBe('3');
      return response({ ok: true, value: page() }, '3');
    })).ok).toBe(true);
    expect(await readHiddenWindow('https://example.test', session(), options, async () => response({ ok: true, value: page() }, '4'))).toEqual({ ok: false, error: 'invalid_response' });
    expect(await readHiddenWindow('https://example.test', session(), { ...options, visibilityRevision: undefined }, jest.fn())).toEqual({ ok: false, error: 'invalid_request' });
  });
  test('invalid inputs, credentials and bounded transport errors', async () => {
    const request = jest.fn(); const opts = { messageId: id(3), readId: id(5) };
    for (const url of ['bad', 'http://example.test', 'https://user:pass@example.test']) expect(await readMessageVisibility(url, session(), opts, request)).toEqual({ ok: false, error: 'invalid_request' });
    expect(await readMessageVisibility('https://example.test', { ...session(), token: '' }, opts, request)).toEqual({ ok: false, error: 'invalid_token' });
    expect(await readMessageVisibility('https://example.test', session(), { ...opts, readId: 'bad' }, request)).toEqual({ ok: false, error: 'invalid_request' });
    expect(await setMessageHidden('https://example.test', session(), { messageId: id(3), commandId: id(6), expectedVisibilityVersion: -1, hidden: true }, request)).toEqual({ ok: false, error: 'invalid_request' });
    expect(request).not.toHaveBeenCalled();
    expect(await readMessageVisibility('https://example.test', session(), opts, async () => { throw Error('offline'); })).toEqual({ ok: false, error: 'transport_error' });
    for (const r of [new Response('bad'), new Response('x'.repeat(65537))]) expect(await readMessageVisibility('https://example.test', session(), opts, async () => r)).toEqual({ ok: false, error: 'invalid_response' });
  });
});
