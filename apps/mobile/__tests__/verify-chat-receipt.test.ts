import { createReceiptVerifier } from '../src/auth/verify-chat-receipt';
const metadata = { id: 'id', coupleId: 'pair', senderId: 'user', clientId: 'command', seq: 1, version: 2,
  createdAt: '2026-11-12T00:00:00.000Z', replyToId: null, deletedAt: null };
describe('verified hidden committed receipt', () => {
  test('terminal metadata installs true tombstone, live hidden does not invent one', async () => {
    const accept = jest.fn(async () => true);
    const verify = createReceiptVerifier(() => ({ generation: 1, revision: 2 }), async () => 'cookie', accept);
    expect(await verify('cookie', 2, metadata)).toBe(true); expect(accept).not.toHaveBeenCalled();
    const terminal = { ...metadata, deletedAt: '2026-11-13T00:00:00.000Z' };
    expect(await verify('cookie', 2, terminal)).toBe(true);
    expect(accept).toHaveBeenCalledWith({ id: 'id', coupleId: 'pair', senderId: 'user', clientId: 'command', seq: 1,
      version: 2, createdAt: metadata.createdAt, deletedAt: terminal.deletedAt, body: null }, 'cookie', 2, expect.any(Function));
    expect(await verify('cookie', 2, { ...terminal, replyToId: 'parent' })).toBe(true);
    expect(accept.mock.calls[1]).toBeDefined();
  });
  test('missing/stale revision or changed cookie cannot verify', async () => {
    const cookie = jest.fn(async () => 'cookie'); const accept = jest.fn(async () => true);
    const verify = createReceiptVerifier(() => ({ generation: 1, revision: 2 }), cookie, accept);
    expect(await verify('cookie', undefined, metadata)).toBe(false);
    expect(await verify('cookie', 1, metadata)).toBe(false); expect(cookie).not.toHaveBeenCalled();
    expect(await verify('other', 2, metadata)).toBe(false); expect(accept).not.toHaveBeenCalled();
  });
  test('post-cookie generation and revision mismatch reject before terminal acceptance', async () => {
    for (const changed of [{ generation: 2, revision: 2 }, { generation: 1, revision: 3 }]) {
      let current = { generation: 1, revision: 2 };
      const accept = jest.fn(async () => true);
      const verify = createReceiptVerifier(() => current, async () => { current = changed; return 'cookie'; }, accept);
      expect(await verify('cookie', 2, { ...metadata, deletedAt: '2026-11-13T00:00:00.000Z' })).toBe(false);
      expect(accept).not.toHaveBeenCalled();
    }
  });
  test('terminal acceptance failure propagates and optional metadata stays text-free', async () => {
    const verify = createReceiptVerifier(() => ({ generation: 1, revision: 2 }), async () => 'cookie', async () => false);
    expect(await verify('cookie', 2, { ...metadata, deletedAt: '2026-11-13T00:00:00.000Z' })).toBe(false);
    expect(await verify('cookie', 2)).toBe(true);
    const withoutSink = createReceiptVerifier(() => ({ generation: 1, revision: 2 }), async () => 'cookie');
    expect(await withoutSink('cookie', 2, metadata)).toBe(true);
  });
});
