import type { ChatMessage } from './transport';
import type { ReplyMessage } from './reply-model';
export type DisplayMessage = Omit<ChatMessage, 'body'> & Readonly<{
  body: string | null; replyToId?: string; deletedAt?: string;
}>;
export type ReplySelection = Readonly<{ id: string; senderId: string; preview: string }>;
/** Plain live rows retain their old local shape after strict new-wire validation. */
export function displayMessage(message: ReplyMessage): DisplayMessage {
  const { replyToId, deletedAt, ...plain } = message;
  return Object.freeze({ ...plain, ...(replyToId === null ? {} : { replyToId }), ...(deletedAt === null ? {} : { deletedAt }) });
}
function sameIdentity(a: DisplayMessage, b: DisplayMessage) {
  return a.id === b.id && a.coupleId === b.coupleId && a.seq === b.seq && a.senderId === b.senderId
    && a.clientId === b.clientId && a.createdAt === b.createdAt && a.replyToId === b.replyToId;
}
export function consistentReply(old: DisplayMessage, next: DisplayMessage) {
  if (!sameIdentity(old, next) || next.version < old.version) return false;
  if (old.deletedAt) return next.body === null && next.deletedAt === old.deletedAt;
  if (next.deletedAt) return next.body === null && next.version > old.version;
  return old.version === next.version && old.body === next.body;
}
export function selectReply(message: DisplayMessage): ReplySelection {
  if (message.body === null) throw Error('deleted_target');
  return Object.freeze({ id: message.id, senderId: message.senderId, preview: [...message.body].slice(0, 90).join('') });
}
/** Non-evicting terminal knowledge. Limit handling belongs to the session host:
 * it must suspend chat, preserve drafts/pending, and require explicit re-login. */
export function createReplyKnowledge(limit = 500) {
  const deleted = new Map<string, DisplayMessage>();
  return {
    reset() { deleted.clear(); },
    accept(incoming: readonly DisplayMessage[], visible: readonly DisplayMessage[]): boolean {
      const staged = new Map(deleted);
      for (const next of incoming) {
        const prior = deleted.get(next.id);
        if (prior && !consistentReply(prior, next)) return false;
        for (const old of visible) {
          if (old.id === next.id && !consistentReply(old, next)) return false;
          if (old.id !== next.id && (old.seq === next.seq || (old.senderId === next.senderId && old.clientId === next.clientId))) return false;
        }
        if (next.deletedAt) staged.set(next.id, next);
      }
      if (staged.size > limit) throw Error('tombstone_limit');
      deleted.clear(); for (const [id, value] of staged) deleted.set(id, value);
      return true;
    },
    tombstone(id: string) { return deleted.get(id); },
  };
}
