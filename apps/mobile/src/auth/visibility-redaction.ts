import type { AuthView } from './controller';
import type { QueueState } from '../chat/types';
/** Redaction is not deletion. The one unresolved wire command is retained privately. */
export function redactQueue(state: QueueState, pendingId: string | null): QueueState {
    return Object.freeze({ ...state, messages: Object.freeze(state.messages.map(message => Object.freeze({
            ...message, ...(message.clientId === pendingId || message.status !== 'accepted' ? {} : { body: null }), canonicalBody: undefined,
        }))) });
}
export function redactChatView(view: AuthView, clearSubmittedDraft: boolean): AuthView {
    return { ...view, messages: [], replyDetail: undefined, replyDetailLoading: false, replyTarget: undefined,
        outgoing: undefined, draft: clearSubmittedDraft ? '' : view.draft, visibilityChanged: true,
        history: { status: 'error', nextBeforeSeq: null, nextAfterSeq: null, boundedWindow: true }, error: 'visibility_changed' };
}
