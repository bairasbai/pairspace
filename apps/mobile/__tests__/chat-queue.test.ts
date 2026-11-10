import { acknowledge, beginSend, createQueue, deleteConfirmed, enqueue, failSend, login, logout,
  MAX_OUTGOING_RECORDS, pause, resume, retry, revoke } from '../src/chat/queue';
import type { Ack, QueueResult, Scope } from '../src/chat/types';

const scope: Scope = { userId: 'u1', coupleId: 'c1', membershipEpoch: 1, sessionId: 's1' };
const ack: Ack = { clientId: 'm1', serverId: 'server1', senderId: 'u1', body: 'hello', seq: 1, version: 1 };
const value = (result: QueueResult) => { if (!result.ok) throw new Error(result.error); return result.state; };
const queued = () => value(enqueue(createQueue(scope), scope, 'm1', 'hello'));
const sending = () => value(beginSend(queued(), scope, 'm1'));
const accepted = () => value(acknowledge(sending(), scope, ack));
const error = (result: QueueResult, expected: string) => { expect(result.ok).toBe(false); if (!result.ok) expect(result.error).toBe(expected); };

it('creates immutable copied context and records', () => {
  const context = { ...scope };
  const initial = createQueue(context);
  context.coupleId = 'changed';
  const next = value(enqueue(initial, scope, 'm1', 'hello'));
  expect(initial.messages).toHaveLength(0);
  expect(initial.scope.coupleId).toBe('c1');
  expect(Object.isFrozen(next)).toBe(true);
  expect(Object.isFrozen(next.scope)).toBe(true);
  expect(Object.isFrozen(next.messages)).toBe(true);
  expect(Object.isFrozen(next.messages[0])).toBe(true);
});
it.each([{ userId: '' }, { coupleId: 'x y' }, { sessionId: '' }, { membershipEpoch: 0 }, { membershipEpoch: NaN }])('validates scope %p', patch => {
  expect(() => createQueue({ ...scope, ...patch })).toThrow('invalid_scope');
});
it('normalizes idempotent enqueue and rejects ID reuse', () => {
  const initial = value(enqueue(createQueue(scope), scope, 'm1', 'e\u0301\r\n'));
  expect(enqueue(initial, scope, 'm1', 'é\n').state).toBe(initial);
  error(enqueue(initial, scope, 'm1', 'changed'), 'id_conflict');
  error(enqueue(initial, scope, '', 'hello'), 'invalid_id');
  error(enqueue(initial, scope, 'm2', ''), 'empty_text');
});
it('bounded queue rejects overflow including dedup tombstones', () => {
  let state = createQueue(scope);
  for (let i = 0; i < MAX_OUTGOING_RECORDS; i++) state = value(enqueue(state, scope, `m${i}`, 'hello'));
  error(enqueue(state, scope, 'overflow', 'hello'), 'queue_full');
  expect(enqueue(state, scope, 'm1', 'hello').state).toBe(state);
});
it('moves queued to sending to accepted and deduplicates ACK', () => {
  const state = accepted();
  expect(state.messages[0]).toMatchObject({ status: 'accepted', attempt: 1, serverId: 'server1', seq: 1 });
  const repeated = value(acknowledge(state, scope, ack));
  expect(repeated.messages).toHaveLength(1);
  expect(repeated).toEqual(state);
  error(beginSend(state, scope, 'm1'), 'invalid_transition');
  error(retry(state, scope, 'm1'), 'invalid_transition');
});
it('retries without changing ID and ignores failures of old attempts', () => {
  let state = sending();
  state = value(failSend(state, scope, 'm1', 1, true));
  expect(state.messages[0].status).toBe('queued');
  state = value(beginSend(state, scope, 'm1'));
  expect(failSend(state, scope, 'm1', 1, false).state).toBe(state);
  state = value(failSend(state, scope, 'm1', 2, false));
  expect(state.messages[0]).toMatchObject({ status: 'failed', error: 'rejected' });
  state = value(retry(state, scope, 'm1'));
  expect(state.messages[0]).toMatchObject({ status: 'queued', clientId: 'm1', error: null });
  state = value(acknowledge(state, scope, ack)); // earlier request committed despite timeout
  expect(failSend(state, scope, 'm1', 2, true).state).toBe(state);
});
it.each(['userId', 'coupleId', 'sessionId', 'membershipEpoch'] as const)('rejects mismatched %s for every operation', key => {
  const foreign: Scope = { ...scope, [key]: key === 'membershipEpoch' ? 2 : 'foreign' };
  const state = sending();
  const results = [enqueue(state, foreign, 'm2', 'x'), beginSend(state, foreign, 'm1'), retry(state, foreign, 'm1'),
    failSend(state, foreign, 'm1', 1, true), acknowledge(state, foreign, ack), deleteConfirmed(state, foreign, 'm1', 'server1', 2),
    pause(state, foreign), resume(state, foreign), revoke(state, foreign)];
  for (const result of results) { error(result, 'scope_mismatch'); expect(result.state).toBe(state); }
});
it('unknown IDs never invent outgoing records', () => {
  const state = createQueue(scope);
  for (const result of [beginSend(state, scope, 'missing'), retry(state, scope, 'missing'),
    failSend(state, scope, 'missing', 1, false), acknowledge(state, scope, ack), deleteConfirmed(state, scope, 'missing', 'server1', 2)]) {
    error(result, 'unknown_message');
  }
});
it.each([null, [], 1, { clientId: '' }, { serverId: '' }, { senderId: 'foreign' },
  { seq: 0 }, { seq: '1' }, { version: NaN }, { version: 0 }, { version: '1' }, { body: null },
  { body: 'different' }, { body: 'x'.repeat(8001) }])('rejects malformed ACK %p', patch => {
  const input = patch && typeof patch === 'object' && !Array.isArray(patch) ? { ...ack, ...patch } : patch;
  error(acknowledge(sending(), scope, input), 'invalid_ack');
});
it('rejects unsolicited ACK before first attempt and inconsistent server identity', () => {
  error(acknowledge(queued(), scope, ack), 'invalid_transition');
  const state = accepted();
  error(acknowledge(state, scope, { ...ack, serverId: 'other' }), 'invalid_ack');
  error(acknowledge(state, scope, { ...ack, seq: 2 }), 'invalid_ack');
  let two = value(enqueue(state, scope, 'm2', 'hello'));
  two = value(beginSend(two, scope, 'm2'));
  error(acknowledge(two, scope, { ...ack, clientId: 'm2' }), 'invalid_ack');
  error(acknowledge(two, scope, { ...ack, clientId: 'm2', serverId: 'other' }), 'invalid_ack');
});
it('ignores older ACK version', () => {
  const state = value(acknowledge(sending(), scope, { ...ack, version: 2 }));
  expect(acknowledge(state, scope, ack).state).toBe(state);
});
it('deletion wins replay and removes content, even before the first ACK', () => {
  for (const initial of [sending(), accepted()]) {
    const state = value(deleteConfirmed(initial, scope, 'm1', 'server1', 2));
    expect(state.messages[0]).toMatchObject({ body: null, deleted: true, status: 'accepted' });
    expect(acknowledge(state, scope, { ...ack, version: 99 }).state).toBe(state);
    expect(deleteConfirmed(state, scope, 'm1', 'server1', 2).state).toBe(state);
    expect(failSend(state, scope, 'm1', 1, false).state).toBe(state);
    error(enqueue(state, scope, 'm1', 'hello'), 'deleted');
    error(beginSend(state, scope, 'm1'), 'deleted');
    error(retry(state, scope, 'm1'), 'deleted');
  }
});
it('rejects invalid deletion identity/version/unsent and server ID reuse', () => {
  error(deleteConfirmed(queued(), scope, 'm1', 'server1', 2), 'invalid_ack');
  for (const [server, version] of [['other', 2], ['server1', 0], ['', 2]] as const)
    error(deleteConfirmed(accepted(), scope, 'm1', server, version), 'invalid_ack');
  let state = value(enqueue(accepted(), scope, 'm2', 'hello'));
  state = value(beginSend(state, scope, 'm2'));
  error(deleteConfirmed(state, scope, 'm2', 'server1', 2), 'invalid_ack');
});
it('pause preserves queued drafts but disallows send/ACK; resume requires same scope', () => {
  const state = value(pause(sending(), scope));
  expect(state.messages[0].status).toBe('queued');
  expect(value(enqueue(state, scope, 'm2', 'hello')).messages).toHaveLength(2);
  error(beginSend(state, scope, 'm1'), 'inactive');
  error(acknowledge(state, scope, ack), 'inactive');
  expect(value(pause(state, scope)).phase).toBe('paused');
  expect(value(resume(state, scope)).phase).toBe('active');
  expect(value(resume(queued(), scope)).phase).toBe('active');
});
it('logout and revoke clear content; stale session and delayed commands cannot restore it', () => {
  for (const state of [logout(sending()), value(revoke(sending(), scope))]) {
    expect(state.messages).toEqual([]);
    for (const result of [enqueue(state, scope, 'm2', 'secret'), acknowledge(state, scope, ack),
      beginSend(state, scope, 'm1'), retry(state, scope, 'm1'), failSend(state, scope, 'm1', 1, true),
      deleteConfirmed(state, scope, 'm1', 'server1', 2), pause(state, scope), resume(state, scope)]) error(result, 'inactive');
    error(login(state, scope), 'stale_session');
    const fresh = value(login(state, { ...scope, coupleId: 'new-couple', sessionId: 's2', membershipEpoch: 2 }));
    expect(fresh.messages).toEqual([]);
    error(acknowledge(fresh, scope, ack), 'scope_mismatch');
  }
});
it('switching account clears previous account messages', () => {
  const state = value(login(accepted(), { ...scope, userId: 'u2', sessionId: 's2' }));
  expect(state.messages).toEqual([]);
  expect(state.scope.userId).toBe('u2');
});

it('rejects an empty ACK object at runtime', () => {
  error(acknowledge(sending(), scope, {}), 'invalid_ack');
});
