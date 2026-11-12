import type { ChatMessage } from './transport';

export type HistoryView = Readonly<{
  status: 'loading' | 'ready' | 'error';
  nextBeforeSeq: number | null;
  windowReset?: boolean;
  nextAfterSeq?: number | null;
  boundedWindow?: boolean;
}>;

/** A bounded, deterministic union. Reject identity/content conflicts atomically. */
export function mergeHistory(existing: readonly ChatMessage[], page: readonly ChatMessage[]): readonly ChatMessage[] | null {
  const ids = new Map<string, ChatMessage>();
  const sequences = new Map<number, string>();
  const commands = new Map<string, string>();
  for (const message of [...existing, ...page]) {
    const previous = ids.get(message.id);
    const command = `${message.senderId}\u0000${message.clientId}`;
    if (previous) {
      if (previous.seq !== message.seq || previous.coupleId !== message.coupleId
        || previous.senderId !== message.senderId || previous.clientId !== message.clientId
        || previous.body !== message.body || previous.version !== message.version
        || previous.createdAt !== message.createdAt) return null;
      continue;
    }
    if (sequences.has(message.seq) || commands.has(command)) return null;
    ids.set(message.id, message); sequences.set(message.seq, message.id); commands.set(command, message.id);
    if (ids.size > 200) return null;
  }
  return Object.freeze([...ids.values()].sort((a, b) => a.seq - b.seq));
}
