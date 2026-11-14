import { createVisibilityFence } from '../src/chat/visibility-fence';
const scope = { userId: 'user', coupleId: 'pair', membershipEpoch: 1, sessionId: 'session' };
const request = (path = 'reply-window', nonce = 'nonce') => new Request(`https://example.test/v1/couples/pair/chat/${path}?read_id=${nonce}`, { headers: { Cookie: 'sid=one' } });
const response = (revision: string | null, value: unknown = { readId: 'nonce', messages: [] }, status = 200) =>
  Response.json({ ok: true, value }, { status, headers: revision === null ? {} : { 'X-Chat-Visibility-Revision': revision } });
function setup() {
  let current: { generation: number; scope: typeof scope } | null = { generation: 1, scope: { ...scope } };
  const cookie = jest.fn(async () => 'sid=one' as string | null), advance = jest.fn();
  const fence = createVisibilityFence({ capture: () => current, cookie, advance });
  return { fence, cookie, advance, set: (value: typeof current) => { current = value; } };
}
describe('visibility scope fence', () => {
  test('missing/malformed revision and wrong nonce never advance or publish', async () => {
    const { fence, advance } = setup();
    for (const revision of [null, '-1', '01', '1.0', '9007199254740992']) {
      await expect(fence.exchange(request(), async () => response(revision))).rejects.toThrow('invalid_visibility_revision');
    }
    await expect(fence.exchange(request(), async () => response('1', { readId: 'wrong' }))).rejects.toThrow('invalid_read_identity');
    expect(fence.revision()).toBeNull(); expect(advance).not.toHaveBeenCalled();
  });
  test('higher body revision and lower revision require conservative refresh', async () => {
    const { fence, advance } = setup();
    expect((await fence.exchange(request(), async () => response('1'))).status).toBe(200);
    const higher = await fence.exchange(request(), async () => response('2', { readId: 'nonce', body: 'secret' }));
    expect(higher.status).toBe(409); expect(await higher.json()).toEqual({ ok: false, error: 'visibility_changed', readId: 'nonce' });
    expect(fence.revision()).toBe(2); expect(advance).toHaveBeenCalledTimes(1);
    const lower = await fence.exchange(request(), async () => response('1'));
    expect(lower.status).toBe(409); expect(fence.revision()).toBe(2);
    expect((await fence.exchange(request(), async () => response('2'))).status).toBe(200);
    fence.reset(); expect(fence.revision()).toBeNull();
  });
  test('over 500 metadata toggles retain a single revision without exhaustion', async () => {
    const { fence, advance } = setup();
    for (let revision = 0; revision <= 510; revision++) {
      const result = await fence.exchange(request('messages/message/hidden'), async req => {
        expect(req.headers.get('X-Chat-Visibility')).toBe('1'); return response(String(revision));
      });
      expect(result.status).toBe(200);
    }
    expect(fence.revision()).toBe(510); expect(advance).toHaveBeenCalledTimes(510);
  });
  test('same-generation auth denials pass through before revision checks', async () => {
    const { fence, cookie } = setup();
    for (const status of [401, 403]) {
      const denied = Response.json({ ok: false, error: 'unavailable', readId: 'nonce' }, { status });
      expect(await fence.exchange(request(), async () => denied)).toBe(denied);
    }
    expect(cookie).not.toHaveBeenCalled(); expect(fence.revision()).toBeNull();
  });
  test('old account response cannot change revision, changed cookie yields opaque denial', async () => {
    const h = setup();
    const old = response('5');
    expect(await h.fence.exchange(request(), async () => { h.set({ generation: 2, scope: { ...scope, userId: 'other' } }); return old; })).toBe(old);
    expect(h.fence.revision()).toBeNull();
    await h.fence.exchange(request(), async () => response('1'));
    h.cookie.mockResolvedValueOnce('sid=other');
    const denied = await h.fence.exchange(request(), async () => response('2'));
    expect(denied.status).toBe(403); expect(await denied.json()).toEqual({ ok: false, error: 'unavailable', readId: 'nonce' });
    expect(h.fence.revision()).toBe(1);
  });
  test('late cookie scope change and overlapping page do not publish obsolete body', async () => {
    const h = setup(); await h.fence.exchange(request(), async () => response('1'));
    let finish!: (response: Response) => void;
    const late = h.fence.exchange(request(), () => new Promise(resolve => { finish = resolve; }));
    await h.fence.exchange(request('messages/message/visibility'), async () => response('2'));
    finish(response('2', { readId: 'nonce', body: 'old view' }));
    expect((await late).status).toBe(409);
    h.cookie.mockImplementationOnce(async () => { h.set(null); return 'sid=one'; });
    const old = response('3'); expect(await h.fence.exchange(request(), async () => old)).toBe(old);
    expect(h.fence.revision()).toBe(2);
  });
  test('committed hidden metadata remains metadata, nonchat and no-scope bypass unchanged', async () => {
    const h = setup(); await h.fence.exchange(request(), async () => response('0'));
    const metadata = { readId: 'nonce', replay: true, hiddenMessage: { id: 'id', deletedAt: null } };
    const result = await h.fence.exchange(request(), async () => response('1', metadata));
    expect(result.status).toBe(200); expect(await result.json()).toEqual({ ok: true, value: metadata });
    expect(JSON.stringify(metadata)).not.toContain('body');
    const untouched = response(null); expect(await h.fence.exchange(new Request('https://example.test/other'), async () => untouched)).toBe(untouched);
    h.set(null); expect(await h.fence.exchange(request(), async () => untouched)).toBe(untouched);
  });
});
