import { reconcileVisible } from '../src/chat/reconcile-visible';
import { selectReply } from '../src/chat/reply-view';
import { row } from './chat-window.fixture';
it('retains unchanged refs and refreshes live selected preview, then clears terminal preview', () => {
    const m = row(1), rows = [m], target = selectReply(m);
    expect(reconcileVisible(rows, m, target, [m])).toEqual({ messages: rows, replyDetail: m, replyTarget: target });
    expect(reconcileVisible(rows, m, target, [m]).messages).toBe(rows);
    const edited = { ...m, body: 'new text', version: 2 };
    const changed = reconcileVisible(rows, m, target, [edited]);
    expect(changed.replyTarget?.preview).toBe('new text');
    expect(changed.replyDetail).toBe(edited);
    const dead = { ...edited, body: null, version: 3, deletedAt: '2026-11-12T00:00:00.000Z' };
    expect(reconcileVisible(changed.messages, edited, changed.replyTarget, [dead]).replyTarget).toBeUndefined();
    expect(reconcileVisible(rows, undefined, undefined, [row(2)]).messages).toBe(rows);
});
