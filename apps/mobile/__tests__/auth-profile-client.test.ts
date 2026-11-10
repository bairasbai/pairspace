import { provisionProfile } from '../src/auth/profile';
const config = { mode: 'synthetic-loopback' as const, baseURL: 'http://127.0.0.1:3333' };
const value = { sessionId: 'verified-session', userId: '00000000-0000-4000-8000-000000000001', created: true };
const response = (body: unknown, status = 201) => new Response(JSON.stringify(body), { status });
const run = (body: unknown, status = 201) => provisionProfile(config, value.sessionId, 'official-cookie', async () => response(body, status));
it.each([200, 201])('validates own session-bound acknowledgement for status%s', async status => {
  expect(await run({ ok: true, value }, status)).toEqual({ ok: true });
});
it('sends no client-selected user IDs, exact cookie/origin and empty JSON only', async () => {
  const request = jest.fn(async (input: Request) => {
    expect(input.url).toBe(config.baseURL + '/v1/profile'); expect(input.method).toBe('POST');
    expect(await input.json()).toEqual({});
    expect(input.headers.get('cookie')).toBe('official-cookie');
    expect(input.headers.get('origin')).toBe(config.baseURL);
    expect(input.headers.get('content-type')).toBe('application/json');
    expect(input.headers.has('authorization')).toBe(false);
    expect(input.credentials).toBe('omit'); expect(input.redirect).toBe('error');
    return response({ ok: true, value: { ...value, created: false } }, 200);
  });
  expect(await provisionProfile(config, value.sessionId, 'official-cookie', request)).toEqual({ ok: true });
});
it.each(['', 'x'.repeat(8193), 'bad\nvalue'])('does not transmit invalid credential %s', async cookie => {
  const request = jest.fn();
  expect(await provisionProfile(config, value.sessionId, cookie, request)).toEqual({ ok: false, error: 'auth_required' });
  expect(request).not.toHaveBeenCalled();
});
it('requires expected session and validates loopback config before networking', async () => {
  const request = jest.fn();
  expect(await provisionProfile(config, '', 'cookie', request)).toEqual({ ok: false, error: 'auth_required' });
  expect(await provisionProfile({ ...config, baseURL: 'https://example.test' }, value.sessionId, 'cookie', request))
    .toEqual({ ok: false, error: 'profile_retry_required' });
  expect(request).not.toHaveBeenCalled();
});
it.each([
  [401, 'auth_required'], [403, 'access_required'], [400, 'profile_unavailable'],
  [404, 'profile_unavailable'], [409, 'profile_unavailable'], [503, 'profile_retry_required'],
  [429, 'profile_retry_required'], [202, 'profile_retry_required'],
] as const)('handles HTTP %s without claiming creation', async (status, error) => {
  expect(await run({}, status)).toEqual({ ok: false, error });
});
it.each([null, [], {}, { ok: false, value }, { ok: true, value: null }, { ok: true, value: [] },
  ...[{ sessionId: 'another-session' }, { userId: 1 }, { userId: 'not-a-uuid' }, { created: 'yes' }]
    .map(patch => ({ ok: true, value: { ...value, ...patch } })),
])('fails safely on invalid acknowledgement %j', async body => {
  expect(await run(body)).toEqual({ ok: false, error: 'profile_retry_required' });
});
it.each(['malformed-json', 'x'.repeat(4097)])('bounds and validates acknowledgement body', async body => {
  expect(await provisionProfile(config, value.sessionId, 'cookie', async () => new Response(body, { status: 201 })))
    .toEqual({ ok: false, error: 'profile_retry_required' });
});
it('does not claim rollback if network rejects after possible commit', async () => {
  expect(await provisionProfile(config, value.sessionId, 'cookie', async () => { throw new Error('lost ACK'); }))
    .toEqual({ ok: false, error: 'profile_retry_required' });
});
