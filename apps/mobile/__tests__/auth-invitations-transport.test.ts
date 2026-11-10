import { createInvitationTransport, validInvitationToken, type InvitationMetadata } from '../src/auth/invitations';
import type { SyntheticConfig } from '../src/auth/config';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const config: SyntheticConfig = { mode: 'synthetic-loopback', baseURL: 'http://127.0.0.1:8787' };
const token = 'A'.repeat(43);
const cookie = 'better-auth.session_token=synthetic-cookie';
const metadata: InvitationMetadata = { id: uuid(3), commandId: uuid(4), status: 'pending',
  createdAt: '2026-11-10T00:00:00.000Z', expiresAt: '2026-11-10T00:10:00.000Z', revokedAt: null, consumedAt: null };
const envelope = (value: unknown, status = 200) => new Response(JSON.stringify({ ok: true, value }), { status });
const issued = (invitation: unknown = metadata, raw: unknown = token) => envelope({ state: 'issued', invitation, token: raw }, 201);
const accepted = { state: 'accepted', sessionId: 'session', userId: uuid(1), coupleId: uuid(2), membershipEpoch: 2, replayed: false };
const retry = { ok: false, error: 'invitation_retry_required' };
const unavailable = { ok: false, error: 'invitation_unavailable' };
function setup(response = issued()) {
  const request = jest.fn<Promise<Response>, [Request]>().mockResolvedValue(response);
  return { request, api: createInvitationTransport(config, request) };
}
afterEach(() => jest.useRealTimers());
it('captures exact loopback config and sends cookie/Origin with no bearer, redirect or ambient credential', async () => {
  const mutable = { ...config };
  const request = jest.fn(async (_request: Request) => issued());
  const api = createInvitationTransport(mutable, request);
  mutable.baseURL = 'https://evil.example';
  const controller = new AbortController();
  expect(await api.issue(cookie, uuid(4), controller.signal)).toEqual({ ok: true, value: { invitation: metadata, token } });
  const req = request.mock.calls[0][0];
  expect(req.url).toBe(config.baseURL + '/v1/spaces/waiting/invite');
  expect(req.method).toBe('POST');
  expect(req.headers.get('cookie')).toBe(cookie);
  expect(req.headers.get('origin')).toBe(config.baseURL);
  expect(req.headers.get('content-type')).toBe('application/json');
  expect(req.headers.has('authorization')).toBe(false);
  expect(req.credentials).toBe('omit'); expect(req.redirect).toBe('error'); expect(req.cache).toBe('no-store');
  expect(await req.json()).toEqual({ commandId: uuid(4) });
  controller.abort(); expect(req.signal.aborted).toBe(true);
});
it.each(['https://localhost', 'http://example.test', 'http://localhost/', 'http://localhost?bad=1', 'http://name@localhost'])('rejects unsafe config %s', baseURL => {
  expect(() => createInvitationTransport({ ...config, baseURL }, async () => issued())).toThrow();
});
it.each(['', 'x'.repeat(8193), 'bad\nvalue', 'bad\x7fvalue'])('rejects invalid cookies without network', async value => {
  const { api, request } = setup(); expect(await api.read(value)).toEqual({ ok: false, error: 'auth_required' }); expect(request).not.toHaveBeenCalled();
});
it('reads current/null metadata without transmitting a selector or receiving a token', async () => {
  const { api, request } = setup(envelope({ state: 'current', invitation: metadata }));
  expect(await api.read(cookie)).toEqual({ ok: true, value: { invitation: metadata } });
  const req = request.mock.calls[0][0];
  expect(req.method).toBe('GET'); expect(req.body).toBeNull(); expect(req.headers.has('content-type')).toBe(false);
  request.mockResolvedValue(envelope({ state: 'current', invitation: null }));
  expect(await api.read(cookie)).toEqual({ ok: true, value: { invitation: null } });
  request.mockResolvedValue(envelope({ state: 'current', invitation: { ...metadata, status: 'expired' } }));
  expect((await api.read(cookie)).ok).toBe(true);
});
it('accepts replay metadata only with token null, including historical revoked/consumed states', async () => {
  for (const invitation of [metadata, { ...metadata, status: 'expired' },
    { ...metadata, status: 'revoked', revokedAt: metadata.createdAt },
    { ...metadata, status: 'consumed', consumedAt: metadata.createdAt }]) {
    const { api } = setup(envelope({ state: 'replayed', invitation, token: null }));
    expect(await api.issue(cookie, uuid(4))).toEqual({ ok: true, value: { invitation, token: null } });
  }
});
it.each(['invalid', '', uuid(3) + ' ', 42])('rejects invalid command/revoke selectors %s without network', async id => {
  const { api, request } = setup();
  expect(await api.issue(cookie, id as string)).toEqual(unavailable); expect(await api.revoke(cookie, id as string)).toEqual(unavailable);
  expect(request).not.toHaveBeenCalled();
});
it('uses conditional revoke with exact inviteId and handles true/false acknowledgement', async () => {
  const { api, request } = setup(envelope({ state: 'revoked', revoked: true }));
  expect(await api.revoke(cookie, uuid(3))).toEqual({ ok: true, value: { revoked: true } });
  expect(request.mock.calls[0][0].method).toBe('DELETE'); expect(await request.mock.calls[0][0].json()).toEqual({ inviteId: uuid(3) });
  request.mockResolvedValue(envelope({ state: 'revoked', revoked: false }));
  expect(await api.revoke(cookie, uuid(3))).toEqual({ ok: true, value: { revoked: false } });
});
it('preview and accept have separate exact minimal bodies, with explicit true consent on accept', async () => {
  const { api, request } = setup(envelope({ state: 'available', expiresAt: metadata.expiresAt }));
  expect(await api.preview(cookie, token)).toEqual({ ok: true, value: { expiresAt: metadata.expiresAt } });
  expect(request.mock.calls[0][0].url).toBe(config.baseURL + '/v1/pair-invitations/preview');
  expect(await request.mock.calls[0][0].json()).toEqual({ token });
  request.mockResolvedValue(envelope(accepted));
  expect(await api.accept(cookie, token)).toEqual({ ok: true, value: {
    sessionId: 'session', userId: uuid(1), coupleId: uuid(2), membershipEpoch: 2, replayed: false } });
  expect(request.mock.calls[1][0].url).toBe(config.baseURL + '/v1/pair-invitations/accept');
  expect(await request.mock.calls[1][0].json()).toEqual({ token, accept: true });
});
it('validates canonical final bits without Buffer or custom cryptography', async () => {
  for (const end of 'AEIMQUYcgkosw048') expect(validInvitationToken('A'.repeat(42) + end)).toBe(true);
  for (const value of ['', 'A'.repeat(42), 'A'.repeat(44), token + '=', ' ' + token, token + '\n',
    'A'.repeat(42) + 'B', 'A'.repeat(42) + '_', 12, null]) {
    const { api, request } = setup(); expect(validInvitationToken(value)).toBe(false);
    expect(await api.preview(cookie, value as string)).toEqual(unavailable);
    expect(await api.accept(cookie, value as string)).toEqual(unavailable); expect(request).not.toHaveBeenCalled();
  }
});
it.each([401, 403])('treats HTTP %s as terminal auth denial even with malformed bodies', async status => {
  const { api } = setup(new Response('secret-not-parsed', { status }));
  expect(await api.read(cookie)).toEqual({ ok: false, error: status === 401 ? 'auth_required' : 'access_required' });
});
it.each([[400, 'invalid_request'], [404, 'not_found'], [409, 'profile_unavailable'], [409, 'space_unavailable'],
  [409, 'invitation_exists'], [409, 'invitation_unavailable']])('recognizes fixed denial %s %s', async (status, error) => {
  const { api } = setup(new Response(JSON.stringify({ ok: false, error }), { status: Number(status) }));
  expect(await api.issue(cookie, uuid(4))).toEqual(unavailable);
});
it.each([null, [], {}, { ok: true }, { ok: false, error: 'unknown' }, { ok: false, error: 'invitation_exists', secret: token },
  { ok: true, value: { state: 'issued', invitation: metadata, token }, secret: token }])('rejects malformed or extra envelopes %#', async body => {
  const { api } = setup(new Response(JSON.stringify(body), { status: 201 })); expect(await api.issue(cookie, uuid(4))).toEqual(retry);
});
it.each([302, 400, 404, 409, 413, 415, 500, 503])('does not reinterpret unexpected HTTP %s as success', async status => {
  const { api } = setup(envelope({ state: 'issued', invitation: metadata, token }, status)); expect(await api.issue(cookie, uuid(4))).toEqual(retry);
});
it.each([
  { id: 'bad' }, { commandId: uuid(9) }, { status: 'unknown' }, { createdAt: 'bad' }, { createdAt: '2026-02-30T00:00:00.000Z' },
  { expiresAt: metadata.createdAt }, { expiresAt: '2026-11-10T00:10:00Z' }, { revokedAt: 'bad' },
  { revokedAt: '2025-01-01T00:00:00.000Z' }, { consumedAt: 'bad' }, { consumedAt: '2025-01-01T00:00:00.000Z' },
  { consumedAt: metadata.expiresAt }, { revokedAt: metadata.createdAt }, { consumedAt: metadata.createdAt },
  { status: 'revoked' }, { status: 'consumed' }, { status: 'expired', revokedAt: metadata.createdAt }, { extra: token },
])('rejects malformed/inconsistent metadata %#', async patch => {
  const { api } = setup(issued({ ...metadata, ...patch })); expect(await api.issue(cookie, uuid(4))).toEqual(retry);
});
it.each([null, [], 'secret'])('rejects nonobject metadata %#', async value => {
  const { api } = setup(issued(value)); expect(await api.issue(cookie, uuid(4))).toEqual(retry);
});
it.each([
  [200, 'issued', token], [201, 'replayed', null], [201, 'issued', null], [201, 'issued', 'bad'], [200, 'replayed', token], [201, 'unknown', token],
])('requires consistent issue status/state/token %#', async (status, state, raw) => {
  const { api } = setup(envelope({ state, invitation: metadata, token: raw }, Number(status)));
  expect(await api.issue(cookie, uuid(4))).toEqual(retry);
});
it.each([
  { state: 'unknown', invitation: null }, { state: 'current', invitation: metadata, token },
  { state: 'current', invitation: { ...metadata, status: 'revoked', revokedAt: metadata.createdAt } },
  { state: 'current', invitation: { ...metadata, status: 'consumed', consumedAt: metadata.createdAt } },
])('rejects invalid current metadata %#', async body => {
  const { api } = setup(envelope(body)); expect(await api.read(cookie)).toEqual(retry);
});
it.each([{ state: 'revoked', revoked: 1 }, { state: 'unknown', revoked: true }, { state: 'revoked', revoked: true, token }])('rejects invalid revoke acknowledgements %#', async body => {
  const { api } = setup(envelope(body)); expect(await api.revoke(cookie, uuid(3))).toEqual(retry);
});
it.each([{ state: 'available', expiresAt: 'bad' }, { state: 'unknown', expiresAt: metadata.expiresAt }, { state: 'available', expiresAt: metadata.expiresAt, token }])('rejects invalid preview %#', async body => {
  const { api } = setup(envelope(body)); expect(await api.preview(cookie, token)).toEqual(retry);
});
it.each([{ state: 'unknown' }, { sessionId: '' }, { sessionId: null }, { sessionId: 'x'.repeat(513) }, { sessionId: 'bad\n' },
  { userId: 'bad' }, { coupleId: 'bad' }, { membershipEpoch: 0 }, { membershipEpoch: 1.5 }, { membershipEpoch: Number.MAX_SAFE_INTEGER + 1 },
  { replayed: 1 }, { token }])('rejects invalid accept acknowledgement %#', async patch => {
  const { api } = setup(envelope({ ...accepted, ...patch })); expect(await api.accept(cookie, token)).toEqual(retry);
});
it('rejects oversized, malformed, missing-stream and invalid UTF8 responses without leaking body detail', async () => {
  const { api, request } = setup(new Response('x'.repeat(4097)));
  expect(await api.read(cookie)).toEqual(retry);
  for (const response of [new Response('{'), new Response(new Uint8Array([0xff])), new Response(null)]) {
    request.mockResolvedValue(response); expect(await api.read(cookie)).toEqual(retry);
  }
  request.mockRejectedValue(new Error('token or cookie must never escape'));
  expect(await api.read(cookie)).toEqual(retry);
});
it('bounds a stalled response stream to ten seconds', async () => {
  jest.useFakeTimers();
  const { api } = setup(new Response(new ReadableStream({ start() {} })));
  const pending = api.read(cookie); await jest.advanceTimersByTimeAsync(10001);
  expect(await pending).toEqual(retry);
});
it('rejects extra fields in an otherwise plausible issuance acknowledgement', async () => {
  const { api } = setup(envelope({ state: 'issued', invitation: metadata, token, extra: 'unexpected' }, 201));
  expect(await api.issue(cookie, uuid(4))).toEqual(retry);
});
