import { createSyntheticDraftContract, draftBytes, MAX_DRAFT_BYTES, type VerifiedDraftContext } from '../src/chat/draftContract';
import { createChatTransport } from '../src/chat/transport';
import { createQueue, enqueue } from '../src/chat/queue';
import type { QueueState } from '../src/chat/types';
const context: VerifiedDraftContext = { origin: 'https://synthetic.invalid', userId: '00000000-0000-4000-8000-000000000001', coupleId: '00000000-0000-4000-8000-000000000002', membershipEpoch: 1, sessionId: 'session-one' };
const binding = { origin: context.origin, userId: context.userId, coupleId: context.coupleId, membershipEpoch: 1 };
const encoded = (text = 'synthetic draft') => JSON.stringify({ version: 1, binding, text });
function setup(raw: string | null = null, scope = context) {
  let value = raw;
  let authorized = true;
  const store = { read: jest.fn(async () => value), write: jest.fn(async (next: string) => { value = next; }), remove: jest.fn(async () => { value = null; }) };
  const contract = createSyntheticDraftContract(store, scope, () => authorized);
  return { store, contract, value: () => value, revoke: () => { authorized = false; } };
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
it('normalizes, bounds UTF8 including envelope, contains no session/credential and restores new incarnation', async () => {
  const first = setup();
  expect(await first.contract.edit('e\u0301\r\n💚')).toEqual({ ok: true, text: 'é\n💚' });
  const raw = first.value()!;
  expect(raw).not.toContain('session-one');
  expect(draftBytes('aé界💚')).toBe(10);
  expect(draftBytes(raw)).toBeLessThanOrEqual(MAX_DRAFT_BYTES);
  const restarted = setup(raw, { ...context, sessionId: 'new-session' });
  expect(await restarted.contract.restore()).toEqual({ ok: true, text: 'é\n💚' });
});
it.each(['x'.repeat(8000), '💚'.repeat(8000), '界'.repeat(1000), '\u0001'.repeat(400)])('rejects oversized full envelope and clears older draft', async input => {
  const { contract, value } = setup(encoded());
  expect(await contract.edit(input)).toEqual({ ok: false, error: 'too_large' });
  expect(value()).toBeNull();
});
it.each([null, 12, '\uD800', '\u0000', 'x'.repeat(8001)])('rejects invalid edit and clears old data', async input => {
  const { contract, value } = setup(encoded());
  expect(await contract.edit(input)).toEqual({ ok: false, error: 'invalid' });
  expect(value()).toBeNull();
});
it('empty edits delete and empty store restores nothing', async () => {
  const { contract } = setup(encoded());
  expect(await contract.edit('  \n')).toEqual({ ok: true, text: null });
  expect(await contract.restore()).toEqual({ ok: true, text: null });
});
it.each(['bad json', 'null', '[]', '{}', 'x'.repeat(2049), encoded('e\u0301'), encoded(''), JSON.stringify({ version: 2, binding, text: 'x' }), JSON.stringify({ version: 1, binding, text: 'x', token: 'synthetic-only' }), JSON.stringify({ version: 1, binding: [], text: 'x' })])('rejects malformed untrusted data without echo %s', async raw => {
  const { contract, value } = setup(raw);
  expect(await contract.restore()).toEqual({ ok: false, error: 'invalid' });
  expect(value()).toBeNull();
});
it.each([{ userId: 'other' }, { coupleId: 'other' }, { membershipEpoch: 2 }, { origin: 'https://other.invalid' }])('refuses cross-scope restore %p', async patch => {
  expect(await setup(encoded(), { ...context, ...patch }).contract.restore()).toEqual({ ok: false, error: 'invalid' });
});
it.each([{ sessionId: '' }, { origin: 'bad origin' }, { membershipEpoch: 0 }, { membershipEpoch: 1.5 }])('rejects bad context %p', patch => {
  expect(() => setup(null, { ...context, ...patch })).toThrow('invalid_draft_context');
});
it('edited draft wins over inflight restore and queued older edit', async () => {
  const { store, contract, value } = setup(encoded());
  const pause = gate();
  store.read.mockImplementationOnce(async () => { await pause.promise; return encoded(); });
  const restore = contract.restore(); await flush();
  const old = contract.edit('old'); const fresh = contract.edit('fresh');
  pause.resolve();
  expect(await restore).toEqual({ ok: false, error: 'stale' });
  expect(await old).toEqual({ ok: false, error: 'stale' });
  expect(await fresh).toEqual({ ok: true, text: 'fresh' });
  expect(value()).toBe(encoded('fresh'));
});
it('queued restore is stale before starting', async () => {
  const { contract } = setup(encoded());
  const restore = contract.restore(); const edit = contract.edit('new');
  expect(await restore).toEqual({ ok: false, error: 'stale' }); await edit;
});
it.each(['restore', 'edit'] as const)('rechecks authorization after pending %s', async action => {
  const { store, contract, revoke } = setup(encoded());
  const pause = gate();
  store.read.mockImplementationOnce(async () => { await pause.promise; return encoded(); });
  const pending = action === 'restore' ? contract.restore() : contract.edit('synthetic draft');
  await flush(); revoke(); pause.resolve();
  expect(await pending).toEqual({ ok: false, error: 'stale' });
  expect(await contract.restore()).toEqual({ ok: false, error: 'inactive' });
  expect(await contract.edit('no')).toEqual({ ok: false, error: 'inactive' });
  expect(await contract.consume()).toEqual({ ok: false, error: 'inactive' });
  await contract.close();
});
it('close serializes after outstanding write, prevents resurrection, blocks competing owner', async () => {
  const { store, contract, value } = setup();
  const pause = gate();
  const write = store.write.getMockImplementation()!;
  store.write.mockImplementationOnce(async next => { await pause.promise; await write(next); });
  const pending = contract.edit('old'); await flush();
  expect(() => createSyntheticDraftContract(store, context, () => true)).toThrow('draft_store_owned');
  const close = contract.close(); expect(contract.close()).toBe(close);
  pause.resolve(); expect(await pending).toEqual({ ok: false, error: 'stale' });
  expect(await close).toEqual({ ok: true, text: null }); expect(value()).toBeNull();
  const next = createSyntheticDraftContract(store, context, () => true);
  await next.edit('new owner'); await contract.close(); expect(value()).toBe(encoded('new owner'));
});
it.each(['read', 'write', 'remove'] as const)('storage denial %s is sanitized and terminal', async method => {
  const { store, contract } = setup(encoded());
  store[method].mockRejectedValueOnce(new Error('synthetic private failure'));
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  const result = method === 'read' ? await contract.restore() : method === 'write' ? await contract.edit('x') : await contract.consume();
  expect(result).toEqual({ ok: false, error: 'storage' });
  expect(await contract.restore()).toEqual({ ok: false, error: 'inactive' }); expect(log).not.toHaveBeenCalled(); log.mockRestore();
});
it('unconfirmed write fails closed; unconfirmed purge prevents replacing owner', async () => {
  const { store, contract } = setup(encoded());
  store.write.mockResolvedValueOnce();
  expect(await contract.edit('different')).toEqual({ ok: false, error: 'storage' });
  store.remove.mockResolvedValueOnce();
  expect(await contract.close()).toEqual({ ok: false, error: 'storage' });
  expect(() => createSyntheticDraftContract(store, context, () => true)).toThrow('draft_store_owned');
});
it('consume is terminal, rechecks revocation and close while pending', async () => {
  for (const revokeByClose of [false, true]) {
    const { store, contract, revoke } = setup(); await contract.edit('draft');
    const pause = gate(); store.remove.mockImplementationOnce(async () => { await pause.promise; });
    store.read.mockResolvedValueOnce(null);
    const consume = contract.consume(); await flush();
    expect(await contract.edit('late')).toEqual({ ok: false, error: 'inactive' });
    const closing = revokeByClose ? contract.close() : null; if (!revokeByClose) revoke();
    pause.resolve(); expect(await consume).toEqual({ ok: false, error: 'stale' }); await closing;
  }
});
it('synthetic restart → verified restore → consume → real send adapter unknown ACK → restart has no new command', async () => {
  const before = setup(); await before.contract.edit('synthetic draft');
  // Distinct fake process/store objects: copies only persisted bytes, never runtime session/queue.
  const restarted = setup(before.value(), { ...context, sessionId: 'restarted' });
  expect(await restarted.contract.restore()).toEqual({ ok: true, text: 'synthetic draft' });
  const consumed = await restarted.contract.consume();
  if (!consumed.ok || !consumed.text) throw new Error('consume failed');
  const scope = { ...context, sessionId: 'restarted' };
  const id = '00000000-0000-4000-8000-000000000003';
  const enqueued = enqueue(createQueue(scope), scope, id, consumed.text);
  if (!enqueued.ok) throw new Error('enqueue failed');
  let queue: QueueState = enqueued.state;
  const request = jest.fn(async () => { expect(restarted.value()).toBeNull(); throw new Error('unknown ACK'); });
  const client = createChatTransport({ baseUrl: context.origin, getCredentialGeneration: () => 1, request, store: { get: () => queue, set: value => { queue = value; } } });
  expect(await client.send(id, { scope, token: 'synthetic-only-token', credentialGeneration: 1 })).toEqual({ ok: false, error: 'transport_error' });
  expect(queue.messages[0].clientId).toBe(id);
  const after = setup(restarted.value(), { ...context, sessionId: 'again' });
  expect(await after.contract.restore()).toEqual({ ok: true, text: null });
  expect((await after.contract.consume())).toEqual({ ok: true, text: null });
  expect(request).toHaveBeenCalledTimes(1);
});
it('failed consume blocks harness send and failed malformed-data purge is explicit', async () => {
  const { store, contract } = setup(); await contract.edit('draft');
  store.remove.mockRejectedValueOnce(new Error('denied'));
  const send = jest.fn(); const result = await contract.consume();
  if (result.ok && result.text) send(result.text);
  expect(result).toEqual({ ok: false, error: 'storage' }); expect(send).not.toHaveBeenCalled();
  const malformed = setup('{'); malformed.store.remove.mockRejectedValueOnce(new Error('denied'));
  expect(await malformed.contract.restore()).toEqual({ ok: false, error: 'storage' });
});
it('rejects a multibyte stored envelope over the byte bound before parsing', async () => {
  expect(await setup(encoded('界'.repeat(650))).contract.restore()).toEqual({ ok: false, error: 'invalid' });
});
