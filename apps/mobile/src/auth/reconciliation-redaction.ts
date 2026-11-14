import type { AuthView } from './auth-view';
import type { QueueState } from '../chat/types';
/** Unavailable is not a tombstone. Only source-derived text is removed. */
export function redactUnavailable(view: AuthView, queue: QueueState | null, ids: readonly string[],
  pending: { id: string | null; revision: number; redacted?: boolean } | null, draftRevision: number,
  outgoingClientId: string | null) {
  const missing = new Set(ids), affected = queue?.messages.filter(item => item.serverId && missing.has(item.serverId)) ?? [];
  const clients = new Set(affected.map(item => item.clientId));
  if (pending?.id && clients.has(pending.id)) pending.redacted = true;
  const nextQueue = queue ? { ...queue, messages: queue.messages.map(item => clients.has(item.clientId)
    ? { ...item, canonicalBody: undefined, ...(item.status === 'accepted' ? { body: null } : {}) } : item) } : null;
  return { queue: nextQueue, view: { ...view,
    messages: view.messages.filter(item => !missing.has(item.id)),
    ...(view.replyDetail && missing.has(view.replyDetail.id) ? { replyDetail: undefined } : {}),
    ...(view.replyTarget && missing.has(view.replyTarget.id) ? { replyTarget: undefined } : {}),
    ...(outgoingClientId && clients.has(outgoingClientId) ? { outgoing: undefined } : {}),
    ...(pending?.id && clients.has(pending.id) && pending.revision === draftRevision ? { draft: '' } : {}),
  } };
}
