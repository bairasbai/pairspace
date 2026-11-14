import { requestMorning } from '../src/auth/morning-request';
import type { InvitationHostSnapshot } from '../src/auth/invitations-controller';
import { scope, id, envelope } from './mornings.fixture';
const expected: InvitationHostSnapshot = { generation: 1, identity: { userId: 'provider', sessionId: 'session' }, context: scope };
function setup() {
  const host = { capture: () => expected, getCookie: jest.fn(async () => 'cookie'), block: jest.fn(), refresh: jest.fn(async () => {}) };
  const current = jest.fn(() => true);
  const request = jest.fn(async (r: Request) => r.url.endsWith('/context') ? envelope(scope) : envelope({ readId: id(8) }));
  const run = () => requestMorning({ mode: 'synthetic-loopback', baseURL: 'http://localhost:8787' }, host, expected, current, request, { path: '', readId: id(8) });
  return { host, current, request, run };
}
test.each([1, 2, 3, 4, 5])('stale scope at checkpoint %i never publishes', async checkpoint => {
  const f = setup(); let calls = 0; f.current.mockImplementation(() => ++calls !== checkpoint);
  expect(await f.run()).toEqual({ ok: false, error: 'stale' });
});
test('binding transport failure and invalid binding are classified safely', async () => {
  const f = setup(); f.request.mockRejectedValueOnce(Error('offline')); expect(await f.run()).toEqual({ ok: false, error: 'transport_error' });
  f.request.mockResolvedValueOnce(new Response('{}', { status: 401 })); expect(await f.run()).toEqual({ ok: false, error: 'auth_required' });
});
test('cookie replacement after response denies result; nonobject payload never accepted', async () => {
  const f = setup(); f.host.getCookie.mockResolvedValueOnce('cookie').mockResolvedValueOnce('cookie').mockResolvedValueOnce('other');
  expect(await f.run()).toEqual({ ok: false, error: 'auth_required' });
  f.request.mockImplementation(async r => r.url.endsWith('/context') ? envelope(scope) : new Response('[]'));
  expect(await f.run()).toEqual({ ok: false, error: 'invalid_response' });
});
test('server errors preserve nonce validation and retry classifications', async () => {
  for (const [status, error, result] of [[500, 'unavailable', 'transport_error'], [400, 'invalid_cursor', 'invalid_cursor']] as const) {
    const f = setup(); f.request.mockImplementation(async r => r.url.endsWith('/context') ? envelope(scope) :
      new Response(JSON.stringify({ ok: false, error, readId: id(8) }), { status }));
    expect(await f.run()).toEqual({ ok: false, error: result });
  }
});
