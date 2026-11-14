import { acknowledge, acknowledgeHidden, beginSend, createQueue, deleteConfirmed, discardOutgoing, enqueue, failSend, MAX_ACCEPTED_OUTGOING, pause } from '../src/chat/queue';
import type { QueueResult } from '../src/chat/types';
const scope = { userId: 'u', coupleId: 'c', sessionId: 's', membershipEpoch: 1 };
const value = (r: QueueResult) => { if (!r.ok)
    throw Error(r.error); return r.state; };
const ack = (i: number) => ({ clientId: `m${i}`, serverId: `server${i}`, senderId: 'u', seq: i + 1, version: 1, body: 'text' });
test('more than 500 sequential sends retain only newest 50 accepted commands', () => {
    let state = createQueue(scope);
    for (let i = 0; i < 550; i++) {
        state = value(enqueue(state, scope, `m${i}`, 'text'));
        state = value(beginSend(state, scope, `m${i}`));
        state = value(acknowledge(state, scope, ack(i)));
        expect(state.messages.length).toBeLessThanOrEqual(MAX_ACCEPTED_OUTGOING);
        expect(state.messages.at(-1)?.clientId).toBe(`m${i}`);
    }
    expect(state.messages[0].clientId).toBe('m500');
    expect(acknowledge(state, scope, ack(0))).toMatchObject({ ok: false, error: 'unknown_message' });
});
test('queued, sending, permanent failures and unknown outcomes are never automatically evicted', () => {
    let state = createQueue(scope);
    for (let i = 0; i < 500; i++)
        state = value(enqueue(state, scope, `m${i}`, 'text'));
    state = value(beginSend(state, scope, 'm0'));
    state = value(beginSend(state, scope, 'm1'));
    state = value(failSend(state, scope, 'm1', 1, false));
    state = value(beginSend(state, scope, 'm2'));
    state = value(failSend(state, scope, 'm2', 1, true));
    expect(enqueue(state, scope, 'overflow', 'text')).toMatchObject({ ok: false, error: 'queue_full' });
    state = value(discardOutgoing(state, scope, 'm1'));
    state = value(enqueue(state, scope, 'replacement', 'text'));
    expect(state.messages).toHaveLength(500);
    expect(state.messages.find(m => m.clientId === 'm0')?.status).toBe('sending');
    expect(state.messages.find(m => m.clientId === 'm2')?.status).toBe('queued');
});
test('explicit local discard is scope-bound, cannot discard accepted, and late ACK cannot recreate a row', () => {
    let state = value(enqueue(createQueue(scope), scope, 'm0', 'text'));
    state = value(beginSend(state, scope, 'm0'));
    expect(discardOutgoing(state, { ...scope, sessionId: 'other' }, 'm0')).toMatchObject({ ok: false, error: 'scope_mismatch' });
    expect(discardOutgoing(value(pause(state, scope)), scope, 'm0')).toMatchObject({ ok: false, error: 'inactive' });
    expect(discardOutgoing(state, scope, 'absent')).toMatchObject({ ok: false, error: 'unknown_message' });
    const accepted = value(acknowledge(state, scope, ack(0)));
    expect(discardOutgoing(accepted, scope, 'm0')).toMatchObject({ ok: false, error: 'invalid_transition' });
    state = value(discardOutgoing(state, scope, 'm0'));
    expect(state.messages).toHaveLength(0);
    expect(acknowledge(state, scope, ack(0))).toMatchObject({ ok: false, error: 'unknown_message' });
});
test('hidden and deleted accepted records compact without changing unresolved attempts', () => {
    let state = value(enqueue(createQueue(scope), scope, 'private', 'unsent'));
    for (let i = 0; i < 60; i++) {
        state = value(enqueue(state, scope, `m${i}`, 'text'));
        state = value(beginSend(state, scope, `m${i}`));
        if (i % 2)
            state = value(deleteConfirmed(state, scope, `m${i}`, `server${i}`, 2));
        else
            state = value(acknowledgeHidden(state, scope, { id: `server${i}`, clientId: `m${i}`, coupleId: 'c', senderId: 'u', seq: i + 1,
                version: 1, createdAt: '2026-01-01T00:00:00.000Z', replyToId: null, deletedAt: null }));
    }
    expect(state.messages).toHaveLength(51);
    expect(state.messages[0]).toMatchObject({ clientId: 'private', body: 'unsent', status: 'queued' });
    expect(state.messages.slice(1).every(m => m.body === null)).toBe(true);
});
