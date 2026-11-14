import { createSharedDoingsController } from '../src/auth/shared-doings';
import type { SharedDoing } from '../src/auth/shared-doings-state';
import { ack, complete, context, declined, deferred, envelope, error, fixture, incoming, joined, list, own, settle, uuid, withdrawn } from './shared-doings-fixtures';
const replayCases: { label: string; before: SharedDoing | null; operation: 'propose' | 'join' | 'decline' | 'advance' | 'remove'; part?: number; wrong: SharedDoing; canonical: SharedDoing }[] = [
  { label: 'decline cannot acknowledge joined', before: incoming, operation: 'decline', wrong: joined, canonical: declined },
  { label: 'join cannot acknowledge withdrawal without joining', before: incoming, operation: 'join',
    wrong: { ...withdrawn, id: incoming.id, authorId: incoming.authorId, recipientId: incoming.recipientId },
    canonical: { ...withdrawn, id: incoming.id, authorId: incoming.authorId, recipientId: incoming.recipientId, decisionState: 'joined', version: 3 } },
  { label: 'author advance cannot acknowledge a smaller position', before: own, operation: 'advance', part: 2,
    wrong: { ...own, authorAt: 1, version: 2 }, canonical: { ...own, authorAt: 2, version: 2 } },
  { label: 'recipient advance cannot acknowledge withdrawal before that advance', before: joined, operation: 'advance', part: 2,
    wrong: { ...incoming, decisionState: 'declined', version: 3 }, canonical: { ...incoming, decisionState: 'declined', version: 4 } },
  { label: 'removed proposal replay must respect the original total', before: null, operation: 'propose',
    wrong: { ...withdrawn, version: 1002 }, canonical: withdrawn },
  { label: 'removed proposal replay rejects even one step over its own total bound', before: null, operation: 'propose',
    wrong: { ...withdrawn, version: 5 }, canonical: withdrawn },
  { label: 'removal cannot acknowledge an active advanced record', before: own, operation: 'remove',
    wrong: { ...own, authorAt: 1, version: 2 }, canonical: withdrawn },
];
it.each(replayCases)('replay proves the original operation happened: $label', async c => {
  const f = fixture(); await f.load(c.before ? [c.before] : []); f.operation.mockRejectedValueOnce(Error('Synthetic unknown ACK'));
  if (c.operation === 'propose') await f.api.propose(true);
  else if (c.operation === 'advance') await f.api.advance(c.before!.id, c.part!, true);
  else await f.api[c.operation](c.before!.id, true);
  expect(f.api.getSnapshot().status).toBe('retry');
  f.operation.mockResolvedValueOnce(ack(c.wrong, true)); await f.api.retry();
  expect(f.api.getSnapshot().status).toBe('retry'); expect(f.api.getSnapshot().pending).toBe(true);
  expect(f.api.getSnapshot().doings).toEqual(c.before ? [c.before] : []);
  f.operation.mockResolvedValueOnce(ack(c.canonical, true)); await f.api.retry();
  expect(f.api.getSnapshot().status).toBe('saved'); expect(f.api.getSnapshot().pending).toBe(false);
  expect(f.api.getSnapshot().doings[0]).toEqual(c.canonical);
});
it('requires confirmed creation and complete manual history; sends normalized immutable title/kind/parts without URL content', async () => {
  const f = fixture(); expect(f.operation).not.toHaveBeenCalled(); await f.api.propose(false); expect(f.operation).not.toHaveBeenCalled();
  await f.api.propose(true); expect(f.api.getSnapshot().requiresRefresh).toBe(true); await f.load();
  f.api.setTitle(' e\u0301 '); f.operation.mockResolvedValueOnce(ack({ ...own, title: 'é' })); await f.api.propose(true);
  expect(f.api.getSnapshot().status).toBe('saved'); expect(f.api.getSnapshot().draft).toEqual({ title: '', kind: 'book', parts: '10' });
  const r = f.operation.mock.calls[1][0]; expect(r.url).not.toContain('é'); expect(r.headers.get('idempotency-key')).toBe(uuid(3));
  expect(r.headers.has('authorization')).toBe(false); expect(await r.json()).toEqual({ membership_epoch: 1, command_id: uuid(3), confirm: true, title: 'é', kind: 'course', parts: 2 });
  await f.load([{ ...own, title: 'é' }]); f.api.setTitle('x'.repeat(801)); expect(f.api.getSnapshot().draft.title).toHaveLength(800);
  await f.api.propose(true); expect(f.api.getSnapshot().status).toBe('invalid'); f.api.setTitle('valid'); f.api.setParts('0'); await f.api.propose(true); expect(f.api.getSnapshot().status).toBe('invalid');
  f.api.setParts('2'); f.command.mockReturnValueOnce('bad'); await f.api.propose(true); expect(f.api.getSnapshot().status).toBe('invalid');
});
it('retains unknown create command and newer RAM across clear/edit/retry; no automatic resend', async () => {
  const f = fixture(); await f.load(); f.operation.mockRejectedValueOnce(Error('offline')); await f.api.propose(true);
  expect(f.api.getSnapshot().pending).toBe(true); f.api.cancelDraft(); f.api.setTitle('Synthetic newer'); f.api.setKind('series'); f.api.setParts('9');
  const n = f.operation.mock.calls.length; await f.api.propose(true); expect(f.operation).toHaveBeenCalledTimes(n);
  f.operation.mockResolvedValueOnce(ack(own, true)); await f.api.retry();
  expect(await f.operation.mock.calls[1][0].json()).toEqual(await f.operation.mock.calls[2][0].json());
  expect(f.api.getSnapshot().draft).toEqual({ title: 'Synthetic newer', kind: 'series', parts: '9' }); expect(f.api.getSnapshot().pending).toBe(false);
  await f.api.retry(); expect(f.operation).toHaveBeenCalledTimes(3);
});
it('enforces recipient choice and own-only positive progress, including withdrawal after completion and canonical removed retry', async () => {
  const f = fixture(); await f.load([own]); f.operation.mockClear(); await f.api.join(own.id, true); await f.api.decline(own.id, true); await f.api.remove(own.id, false);
  await f.api.advance(own.id, 1, false); await f.api.advance(uuid(999), 1, true); expect(f.operation).not.toHaveBeenCalled();
  await f.api.advance(own.id, 0, true); expect(f.api.getSnapshot().status).toBe('invalid');
  f.operation.mockResolvedValueOnce(ack({ ...own, authorAt: 1, version: 2 })); await f.api.advance(own.id, 1, true);
  expect(f.api.getSnapshot().doings[0]).toMatchObject({ authorAt: 1, decisionState: 'invited' });
  const g = fixture(); await g.load([incoming]); g.operation.mockClear(); await g.api.advance(incoming.id, 1, true); await g.api.remove(incoming.id, true); await g.api.join(incoming.id, false); expect(g.operation).not.toHaveBeenCalled();
  g.operation.mockResolvedValueOnce(ack(joined)); await g.api.join(incoming.id, true); expect(g.api.getSnapshot().doings[0]).toEqual(joined);
  g.operation.mockResolvedValueOnce(ack({ ...joined, recipientAt: 1, version: 3 })); await g.api.advance(incoming.id, 1, true);
  expect(await g.operation.mock.calls[1][0].json()).toEqual({ membership_epoch: 1, command_id: uuid(3), confirm: true, expected_version: 2, part: 1 });
  await g.load([{ ...complete, version: 5 }]); g.operation.mockResolvedValueOnce(ack({ ...incoming, authorAt: 2, decisionState: 'declined', version: 6 })); await g.api.decline(incoming.id, true);
  expect(g.api.getSnapshot().doings[0]).not.toHaveProperty('recipientAt');
  const h = fixture(); await h.load([own]); h.operation.mockRejectedValueOnce(Error('lost ACK')); await h.api.advance(own.id, 1, true);
  const removed = { ...withdrawn, version: 3 }; await h.load([removed]); h.operation.mockResolvedValueOnce(ack(removed, true)); await h.api.retry();
  expect(h.api.getSnapshot().doings[0]).toEqual(removed); expect(h.api.getSnapshot().pending).toBe(false);
});
it('refresh with unknown outcome preserves command and latest tombstone prevents stale ACK revival', async () => {
  const f = fixture(); await f.load(); f.operation.mockRejectedValueOnce(Error('lost ACK')); await f.api.propose(true);
  await f.load([withdrawn]); f.operation.mockResolvedValueOnce(ack(own, true)); await f.api.retry();
  expect(f.api.getSnapshot().pending).toBe(true); expect(f.api.getSnapshot().doings[0]).toEqual(withdrawn);
  f.operation.mockResolvedValueOnce(ack(withdrawn, true)); await f.api.retry(); expect(f.api.getSnapshot().pending).toBe(false);
  const g = fixture(); await g.load([incoming]); g.operation.mockResolvedValueOnce(ack(declined)); await g.api.decline(incoming.id, true);
  expect(g.api.getSnapshot().doings[0]).toEqual(declined);
  const h = fixture(); await h.load([own]); h.operation.mockResolvedValueOnce(ack(withdrawn)); await h.api.remove(own.id, true);
  expect(h.operation.mock.calls[1][0].method).toBe('DELETE'); expect(h.api.getSnapshot().doings[0]).toEqual(withdrawn);
});
it('checks exact wire shape, reachable snapshots, clock, order, complete contiguous history, immutable fields and byte bounds', async () => {
  const second = { ...own, id: uuid(10), sequence: 2 };
  for (const response of [list([own, own]), list([{ ...own, sequence: 2 }]), list([own, second]), list([{ ...own, version: 2004 }]),
    list([{ ...own, recipientAt: 0 }]), list([{ ...own, extra: 1 }]), list([own], '2020-01-01T00:00:00.000Z'),
    envelope({ doings: [], checkedAt: 'bad', capacity: 100, used: 0 }), envelope({ doings: [], checkedAt: '2026-11-11T00:00:00.000Z', capacity: 99, used: 0 }),
    new Response('x'.repeat(262145))]) {
    const f = fixture(); f.operation.mockResolvedValueOnce(response); await f.api.load(); expect(f.api.getSnapshot().checked).toBe(false); expect(f.api.getSnapshot().error).toBe(true);
  }
  for (const response of [ack({ ...own, title: 'wrong payload' }), ack(own, false, uuid(99)), ack({ ...own, version: 2, authorAt: 1 }),
    envelope({ doing: own, replay: 'yes', commandId: uuid(3) }), envelope({ doing: own, replay: false, commandId: uuid(3), extra: 1 }),
    new Response('x'.repeat(16385)), error('other', 200), envelope(null)]) {
    const f = fixture(); await f.load(); f.operation.mockResolvedValueOnce(response); await f.api.propose(true); expect(f.api.getSnapshot().status).toBe('retry'); expect(f.api.getSnapshot().pending).toBe(true);
  }
  const f = fixture(); await f.load([own]); f.operation.mockResolvedValueOnce(list([own], '2026-11-10T00:00:00.000Z')); await f.api.load(); expect(f.api.getSnapshot().error).toBe(true);
  f.operation.mockResolvedValueOnce(list([{ ...own, title: 'changed' }])); await f.api.load(); expect(f.api.getSnapshot().doings[0]).toEqual(own);
});
it('ACK can leave sequence gaps, but only a complete GET certifies history; cap blocks only new proposals', async () => {
  const f = fixture(); await f.load([own]); const third = { ...own, id: uuid(10), sequence: 3 };
  f.operation.mockResolvedValueOnce(ack(third)); await f.api.propose(true); expect(f.api.getSnapshot().used).toBe(3); expect(f.api.getSnapshot().checked).toBe(false);
  await f.load([third, own]); expect(f.api.getSnapshot().checked).toBe(false);
  await f.load([third, { ...own, id: uuid(11), sequence: 2 }, own]); expect(f.api.getSnapshot().checked).toBe(true);
  const g = fixture(), hundred = Array.from({ length: 100 }, (_, n) => ({ ...own, id: uuid(300 + n), sequence: n + 1 })).reverse();
  await g.load(hundred); g.operation.mockClear(); await g.api.propose(true); expect(g.api.getSnapshot().status).toBe('limit'); expect(g.operation).not.toHaveBeenCalled();
  g.operation.mockResolvedValueOnce(ack({ ...withdrawn, id: hundred[0].id, sequence: 100 })); await g.api.remove(hundred[0].id, true); expect(g.api.getSnapshot().status).toBe('saved');
});
it('clears private RAM/pending on scope reset and fences late ACK across reset/rebind, account, epoch and cookie changes', async () => {
  for (const rebound of [true, false]) {
    const f = fixture(); await f.load(); const late = deferred(); f.operation.mockImplementationOnce(() => late.promise); const work = f.api.propose(true); await settle();
    if (rebound) { f.controller.reset(); f.controller.sync(); f.api.setTitle('Synthetic new binding'); }
    else { f.set({ generation: 2, identity: { userId: 'other', sessionId: 'other' }, context: { ...context, membershipEpoch: 2 } }); f.controller.sync(); }
    late.resolve(ack()); await work; expect(f.api.getSnapshot().doings).toEqual([]); expect(f.api.getSnapshot().pending).toBe(false);
    expect(f.api.getSnapshot().draft.title).toBe(rebound ? 'Synthetic new binding' : '');
    f.set(null); f.controller.sync(); expect(f.api.getSnapshot().available).toBe(false); f.api.setTitle('cannot retain'); expect(f.api.getSnapshot().draft.title).toBe('');
  }
  const f = fixture(); f.host.getCookie.mockResolvedValueOnce('synthetic=cookie').mockResolvedValueOnce('changed'); await f.api.load(); expect(f.api.getSnapshot().available).toBe(false); expect(f.host.block).toHaveBeenCalledWith('auth_required');
  const g = fixture(); g.operation.mockImplementationOnce(async () => { g.set(null); return list([own]); }); await g.api.load(); expect(g.api.getSnapshot().doings).toEqual([]);
});
it('honestly handles discovery/auth/conflict/unavailable/transport outcomes and never retries automatically', async () => {
  for (const code of [401, 403]) { const f = fixture(); f.operation.mockResolvedValueOnce(error('unavailable', code)); await f.api.load(); expect(f.api.getSnapshot().available).toBe(false); }
  const f = fixture(); f.discovery.mockRejectedValueOnce(Error('offline')); await f.api.load(); expect(f.api.getSnapshot().error).toBe(true);
  f.discovery.mockResolvedValueOnce(error('unauthenticated', 401)); await f.api.load(); expect(f.api.getSnapshot().available).toBe(false);
  const changed = fixture(); changed.discovery.mockResolvedValueOnce(envelope({ ...context, membershipEpoch: 2 })); await changed.api.load(); expect(changed.host.refresh).toHaveBeenCalled();
  for (const code of ['version_conflict', 'idempotency_conflict', 'capacity_reached']) {
    const g = fixture(); await g.load(); g.operation.mockResolvedValueOnce(error(code, 409)); await g.api.propose(true); expect(g.api.getSnapshot().requiresRefresh).toBe(true); expect(g.api.getSnapshot().pending).toBe(false);
    const calls = g.operation.mock.calls.length; await g.api.propose(true); expect(g.operation).toHaveBeenCalledTimes(calls);
  }
  for (const code of [400, 404, 503]) { const g = fixture(); await g.load(); g.operation.mockResolvedValueOnce(error(code === 400 ? 'invalid_request' : 'unavailable', code)); await g.api.propose(true); expect(g.api.getSnapshot().status).toBe(code === 400 ? 'invalid' : 'retry'); }
  const absent = fixture(); absent.operation.mockResolvedValueOnce(error('not_found', 404)); await absent.api.load(); expect(absent.api.getSnapshot().status).toBe('unavailable');
  const stale = fixture(); stale.operation.mockResolvedValueOnce(error('stale_membership', 409)); await stale.api.load(); expect(stale.api.getSnapshot().available).toBe(false);
  expect(() => createSharedDoingsController({ mode: 'synthetic-loopback', baseURL: 'https://remote.invalid' }, fixture().host, async () => list(), () => uuid(3))).toThrow();
});
