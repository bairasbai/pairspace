import { readSessionContext } from '../src/auth/context';
const config = { mode: 'synthetic-loopback' as const, baseURL: 'http://127.0.0.1:3333' };
const userId = '00000000-0000-4000-8000-000000000001';
const coupleId = '00000000-0000-4000-8000-000000000002';
const ready = { state: 'ready', sessionId: 'verified-session', userId, coupleId, membershipEpoch: 1 };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const read = (value: unknown, status = 200) =>
  readSessionContext(config, 'verified-session', 'better-auth.session_token=synthetic', async () => response(value, status));
it.each([
  { state: 'unmapped', sessionId: 'verified-session' },
  { state: 'no_active_pair', sessionId: 'verified-session', userId },
  ready,
])('accepts explicit session-bound context %j without treating provider ID as domain UUID', async value => {
  expect(await read({ ok: true, value })).toEqual({ ok: true, value });
});
it('sends only exact context path and official cookie/origin, never client-selected IDs', async () => {
  const request = jest.fn(async (input: Request) => {
    expect(input.url).toBe(config.baseURL + '/v1/session/context');
    expect(input.method).toBe('GET'); expect(input.body).toBeNull();
    expect(input.headers.get('cookie')).toBe('official-cookie');
    expect(input.headers.get('origin')).toBe(config.baseURL);
    expect(input.headers.has('authorization')).toBe(false);
    expect(input.redirect).toBe('error'); expect(input.credentials).toBe('omit');
    return response({ ok: true, value: { ...ready, providerSecret: 'must-not-retain' } });
  });
  expect(await readSessionContext(config, ready.sessionId, 'official-cookie', request)).toEqual({ ok: true, value: ready });
});
it.each(['', 'x'.repeat(8193), 'unsafe\nheader'])('rejects unusable official cookie before network', async cookie => {
  const request = jest.fn();
  expect(await readSessionContext(config, ready.sessionId, cookie, request)).toEqual({ ok: false, error: 'auth_required' });
  expect(request).not.toHaveBeenCalled();
});
it.each([
  null, [], {}, { ok: false, value: ready }, { ok: true, value: null }, { ok: true, value: [] },
  ...[
    { sessionId: 'another-session' }, { state: 'unknown' }, { userId: 'provider-id' },
    { userId: 1 }, { coupleId: 'wrong' }, { membershipEpoch: 0 }, { membershipEpoch: 1.5 },
    { membershipEpoch: '1' }, { membershipEpoch: Number.MAX_SAFE_INTEGER + 1 },
  ].map(patch => ({ ok: true, value: { ...ready, ...patch } })),
])('fails closed on malformed or session-mismatched context %j', async value => {
  expect(await read(value)).toEqual({ ok: false, error: 'invalid_context' });
});
it('rejects missing expected verified session', async () => {
  expect(await readSessionContext(config, '', 'cookie', async () => response({ ok: true, value: ready })))
    .toEqual({ ok: false, error: 'invalid_context' });
});
it.each([[401, 'auth_required'], [403, 'access_required'], [503, 'transport_error'], [204, 'transport_error']] as const)(
  'handles HTTP status %s safely', async (status, error) => {
    expect(await readSessionContext(config, ready.sessionId, 'cookie', async () =>
      new Response(status === 204 ? null : '{}', { status }))).toEqual({ ok: false, error });
  });
it.each(['invalid JSON', 'x'.repeat(4097)])('bounds and validates context body', async body => {
  expect(await readSessionContext(config, ready.sessionId, 'cookie', async () => new Response(body)))
    .toEqual({ ok: false, error: 'invalid_context' });
});
it('returns opaque failure for network errors and absent response streams', async () => {
  expect(await readSessionContext(config, ready.sessionId, 'cookie', async () => { throw new Error('private network detail'); }))
    .toEqual({ ok: false, error: 'transport_error' });
  expect(await readSessionContext(config, ready.sessionId, 'cookie', async () => new Response(null)))
    .toEqual({ ok: false, error: 'invalid_context' });
});
it('bounds a stalled context stream and cancels it without waiting forever', async () => {
  jest.useFakeTimers();
  const cancel = jest.fn(async () => {});
  const releaseLock = jest.fn();
  try {
    const response = { status: 200, body: { getReader: () => ({
      read: () => new Promise(() => {}), cancel, releaseLock,
    }) } } as unknown as Response;
    const pending = readSessionContext(config, ready.sessionId, 'cookie', async () => response);
    await jest.advanceTimersByTimeAsync(10001);
    expect(await pending).toEqual({ ok: false, error: 'invalid_context' });
    expect(cancel).toHaveBeenCalled();
    expect(releaseLock).toHaveBeenCalled();
  } finally { jest.useRealTimers(); }
});

it('rejects a remote or malformed helper destination before exposing cookies', async () => {
  const request = jest.fn();
  expect(await readSessionContext({ ...config, baseURL: 'https://example.test' }, ready.sessionId, 'cookie', request))
    .toEqual({ ok: false, error: 'transport_error' });
  expect(request).not.toHaveBeenCalled();
});
