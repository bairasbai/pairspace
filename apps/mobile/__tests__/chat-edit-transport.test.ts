import { editChatMessage } from '../src/chat/edit-transport';
import type { DeleteTarget } from '../src/chat/delete-transport';
import type { TransportSession } from '../src/chat/transport';
const id = (n: number) => `abcdef00-0000-4000-8000-${String(n).padStart(12, '0')}`;
const commandId = id(9);
const session = (): TransportSession => ({ scope: { userId: id(1), coupleId: id(2), membershipEpoch: 1, sessionId: 'local' }, token: 'token', credentialGeneration: 1 });
const message = (): DeleteTarget => ({ id: id(3), coupleId: id(2), senderId: id(1), clientId: id(4), seq: 1,
    replyToId: null, version: 1, createdAt: '2026-11-12 12:00:00.123456+00' });
const tombstone = () => ({ ...message(), body: null, version: 2, replyToId: null, deletedAt: '2026-11-13T12:00:00.000Z' });
const edited = () => ({ ...message(), body: 'changed', version: 2, deletedAt: null });
const ack = () => ({ ok: true, value: { commandId, replay: false, message: edited() } });
const run = (value: unknown = ack(), status = 200) => editChatMessage('https://example.test', session(), { message: message(), body: 'changed', commandId }, async () => Response.json(value, { status }));
describe('explicit own message delete transport', () => {
    test('exact DELETE body, target, command header and captured bearer', async () => {
        const request = jest.fn(async (req: Request) => {
            expect(req.method).toBe('PATCH');
            expect(req.url).toBe(`https://example.test/v1/couples/${id(2)}/chat/messages/${id(3)}`);
            expect(req.headers.get('authorization')).toBe('Bearer token');
            expect(req.headers.get('idempotency-key')).toBe(commandId);
            expect(req.headers.get('content-type')).toBe('application/json');
            expect(req.redirect).toBe('error');
            expect(req.credentials).toBe('omit');
            expect(req.cache).toBe('no-store');
            expect(await req.json()).toEqual({ membership_epoch: 1, command_id: commandId, expected_version: 1, body: 'changed' });
            return Response.json(ack());
        });
        const result = await editChatMessage('https://example.test/path', session(), { message: message(), body: 'changed', commandId }, request);
        expect(result).toEqual({ ok: true, value: ack().value });
        expect(request).toHaveBeenCalledTimes(1);
    });
    test('cookie origin and explicit test loopback', async () => {
        const request = jest.fn(async (req: Request) => {
            expect(req.headers.get('cookie')).toBe('sid=value');
            expect(req.headers.get('origin')).toBe('http://127.0.0.1:4000');
            expect(req.headers.has('authorization')).toBe(false);
            return Response.json(ack());
        });
        expect((await editChatMessage('http://127.0.0.1:4000', { ...session(), credentialKind: 'cookie', token: 'sid=value' }, { message: message(), body: 'changed', commandId, allowHttpLoopbackForTests: true }, request)).ok).toBe(true);
        expect(await editChatMessage('http://127.0.0.1:4000', session(), { message: message(), body: 'changed', commandId }, request)).toEqual({ ok: false, error: 'invalid_request' });
    });
    test('rejects malformed or foreign/already deleted targets without network', async () => {
        const request = jest.fn();
        for (const patch of [{ senderId: id(6) }, { coupleId: id(6) }, { id: id(3).toUpperCase() },
            { clientId: 'bad' }, { body: null }, { body: '' }, { deletedAt: '2026-11-13T12:00:00.000Z' },
            { version: 0 }, { version: Number.MAX_SAFE_INTEGER }, { replyToId: id(3) }]) {
            expect(await editChatMessage('https://example.test', session(), { message: { ...message(), ...patch }, body: 'changed', commandId }, request)).toEqual({ ok: false, error: 'invalid_request' });
        }
        expect(await editChatMessage('https://example.test', session(), { message: message(), body: 'changed', commandId: commandId.toUpperCase() }, request)).toEqual({ ok: false, error: 'invalid_request' });
        for (const url of ['bad', 'http://example.test', 'https://user:pass@example.test']) {
            expect(await editChatMessage(url, session(), { message: message(), body: 'changed', commandId }, request)).toEqual({ ok: false, error: 'invalid_request' });
        }
        for (const token of ['', 'a\nb', 'x'.repeat(2049)]) {
            expect(await editChatMessage('https://example.test', { ...session(), token }, { message: message(), body: 'changed', commandId }, request)).toEqual({ ok: false, error: 'invalid_token' });
        }
        expect(await editChatMessage('https://example.test', { ...session(), credentialKind: 'cookie', token: 'a\nb' }, { message: message(), body: 'changed', commandId }, request)).toEqual({ ok: false, error: 'invalid_token' });
        expect(request).not.toHaveBeenCalled();
    });
    test('ACK exact tombstone, immutable identity and expected version', async () => {
        for (const patch of [{ id: id(7) }, { clientId: id(7) }, { senderId: id(7) }, { coupleId: id(7) },
            { seq: 2 }, { createdAt: '2026-11-12T12:00:00.123Z' }, { replyToId: id(7) },
            { version: 0 }, { version: 3 }, { body: 'live' }, { deletedAt: '2026-11-13T12:00:00.000Z' }, { deletedAt: 'bad' }]) {
            expect(await run({ ...ack(), value: { ...ack().value, message: { ...edited(), ...patch } } })).toEqual({ ok: false, error: 'invalid_response' });
        }
        for (const patch of [{ commandId: id(8) }, { replay: 'yes' }, { extra: true }]) {
            expect(await run({ ...ack(), value: { ...ack().value, ...patch } })).toEqual({ ok: false, error: 'invalid_response' });
        }
        expect((await run({ ...ack(), value: { ...ack().value, replay: true, message: { ...edited(), version: 3 } } })).ok).toBe(true);
        expect((await run({ ...ack(), value: { ...ack().value, replay: true, message: { ...edited(), version: 1 } } })).ok).toBe(true);
        expect(await run({ ...ack(), value: { ...ack().value, replay: true, message: { ...edited(), version: 1, body: 'different' } } })).toEqual({ ok: false, error: 'invalid_response' });
        expect(await run({ ...ack(), extra: true })).toEqual({ ok: false, error: 'invalid_response' });
        expect(await run(ack(), 403)).toEqual({ ok: false, error: 'invalid_response' });
        const target = { ...message(), replyToId: id(8) };
        expect((await editChatMessage('https://example.test', session(), { message: target, body: 'changed', commandId }, async () => Response.json({ ...ack(), value: { ...ack().value, message: { ...edited(), replyToId: id(8) } } }))).ok).toBe(true);
    });
    test('classifies definitive local errors separately from authentication and unknown outcomes', async () => {
        for (const [status, error, expected] of [[401, 'unauthenticated', 'auth_required'], [403, 'unavailable', 'access_required'],
            [409, 'stale_membership', 'access_required'], [409, 'message_unavailable', 'message_unavailable'],
            [409, 'version_conflict', 'version_conflict'],
            [409, 'idempotency_conflict', 'idempotency_conflict'], [429, 'limited', 'rate_limited'],
            [503, 'temporarily_unavailable', 'transport_error'], [400, 'invalid_request', 'rejected']] as const) {
            expect(await run({ ok: false, error }, status)).toEqual({ ok: false, error: expected });
        }
        expect(await run({ ok: false, error: 'message_deleted', extra: true }, 409)).toEqual({ ok: false, error: 'invalid_response' });
        expect(await run(null)).toEqual({ ok: false, error: 'invalid_response' });
        expect(await run({ ok: true, value: null })).toEqual({ ok: false, error: 'invalid_response' });
    });
    test('already-deleted 409 requires a command-bound canonical tombstone', async () => {
        const response = { ok: false, error: 'message_deleted', value: { commandId, message: tombstone() } };
        expect(await run(response, 409)).toEqual({ ok: false, error: 'message_deleted', message: tombstone() });
        expect(await run({ ...response, value: { ...response.value, message: { ...tombstone(), version: 5 } } }, 409))
            .toEqual({ ok: false, error: 'message_deleted', message: { ...tombstone(), version: 5 } });
        for (const message of [{ ...tombstone(), id: id(7) }, { ...tombstone(), body: 'secret' },
            { ...tombstone(), version: 1 }, { ...tombstone(), deletedAt: null }]) {
            expect(await run({ ...response, value: { commandId, message } }, 409)).toEqual({ ok: false, error: 'invalid_response' });
        }
        for (const malformed of [{ ok: false, error: 'message_deleted' },
            { ...response, value: { ...response.value, commandId: id(8) } },
            { ...response, value: { ...response.value, replay: true } }]) {
            expect(await run(malformed, 409)).toEqual({ ok: false, error: 'invalid_response' });
        }
        expect(await run(response, 400)).toEqual({ ok: false, error: 'invalid_response' });
    });
    test('snapshot cannot be retargeted across asynchronous exchange', async () => {
        const target = { ...message() }, current = { ...session(), scope: { ...session().scope } }, options = { message: target, body: 'changed', commandId };
        expect((await editChatMessage('https://example.test', current, options, async () => {
            target.id = id(7);
            target.version = 5;
            target.replyToId = id(8);
            options.commandId = id(8);
            current.scope.userId = id(6);
            return Response.json(ack());
        })).ok).toBe(true);
    });
    test('accepts historical edit ACK with newer body or terminal tombstone, never fresh mismatch', async () => {
        for (const message of [{ ...edited(), version: 5, body: 'later edit' }, { ...tombstone(), version: 5 }]) {
            expect((await run({ ...ack(), value: { ...ack().value, replay: true, message } })).ok).toBe(true);
        }
        expect(await editChatMessage('https://example.test', session(), { message: message(), commandId, body: '   ' }, jest.fn())).toEqual({ ok: false, error: 'empty_text' });
    });
    test('bounded failures never claim deletion', async () => {
        expect(await editChatMessage('https://example.test', session(), { message: message(), body: 'changed', commandId }, async () => { throw Error('offline'); })).toEqual({ ok: false, error: 'transport_error' });
        for (const response of [new Response(null), new Response('bad'), new Response('x'.repeat(65537))]) {
            expect(await editChatMessage('https://example.test', session(), { message: message(), body: 'changed', commandId }, async () => response)).toEqual({ ok: false, error: 'invalid_response' });
        }
    });
});

it('accepts a fresh normalized no-op without increment, but never an unbound equal-version result', async () => {
    const noOp = { ...ack(), value: { ...ack().value, message: { ...edited(), version: 1 } } };
    expect((await run(noOp)).ok).toBe(true);
    for (const patch of [{ body: 'another body' }, { id: id(99) }, { version: 0 },
        { body: null, deletedAt: '2026-11-13T12:00:00.000Z' }]) {
        expect(await run({ ...noOp, value: { ...noOp.value, message: { ...noOp.value.message, ...patch } } }))
            .toEqual({ ok: false, error: 'invalid_response' });
    }
});
it('normalizes NFC and line endings before checking a fresh same-version no-op', async () => {
    const result = await editChatMessage('https://example.test', session(), {
        message: message(), commandId, body: 'cafe\u0301\r\ntext',
    }, async request => {
        expect((await request.json()).body).toBe('café\ntext');
        return Response.json({ ok: true, value: { commandId, replay: false,
            message: { ...edited(), version: 1, body: 'café\ntext' } } });
    });
    expect(result.ok).toBe(true);
});
