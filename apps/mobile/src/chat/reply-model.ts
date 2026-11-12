import type { ChatMessage } from './transport';
import type { HistoryWindowOptions } from './history-window';
import { normalizeMessageText } from './text';
export type ReplyMessage = Omit<ChatMessage, 'body'> & Readonly<{ body: string | null; replyToId: string | null; deletedAt: string | null }>;
export type ReplyWindow = Readonly<{
  messages: readonly ReplyMessage[]; readId: string; hasOlder: boolean; hasNewer: boolean;
  olderCursor: Readonly<{ id: string; seq: number }> | null;
  newerCursor: Readonly<{ id: string; seq: number }> | null;
}>;
export const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const keys = (v: Record<string, unknown>, names: string) => Object.keys(v).sort().join(',') === names.split(',').sort().join(',');
export const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
export const positive = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
export function parseReplyMessage(value: unknown, coupleId: string): ReplyMessage | null {
  if (!record(value) || !keys(value, 'id,coupleId,senderId,clientId,seq,body,version,createdAt,replyToId,deletedAt')
    || !uuid(value.id) || !uuid(value.coupleId) || value.coupleId !== coupleId || !uuid(value.senderId) || !uuid(value.clientId)
    || (value.replyToId !== null && (!uuid(value.replyToId) || value.replyToId.toLowerCase() === String(value.id).toLowerCase()))
    || !positive(value.seq) || !positive(value.version)
    || typeof value.createdAt !== 'string' || value.createdAt.length > 64 || !Number.isFinite(Date.parse(value.createdAt))) return null;
  if (value.deletedAt === null) {
    const body = normalizeMessageText(value.body);
    if (!body.ok || body.text !== value.body) return null;
  } else if (value.body !== null || typeof value.deletedAt !== 'string'
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.deletedAt)
    || !Number.isFinite(Date.parse(value.deletedAt)) || new Date(value.deletedAt).toISOString() !== value.deletedAt) return null;
  return Object.freeze({ ...value }) as ReplyMessage;
}
export function parseReplyWindow(value: unknown, coupleId: string, options: HistoryWindowOptions): ReplyWindow | null {
  if (!record(value) || !keys(value, 'messages,readId,hasOlder,hasNewer,olderCursor,newerCursor')
    || value.readId !== options.readId || !Array.isArray(value.messages) || value.messages.length > 50
    || typeof value.hasOlder !== 'boolean' || typeof value.hasNewer !== 'boolean'
    || (options.direction === 'latest' && value.hasNewer) || (options.direction === 'oldest' && value.hasOlder)
    || (!value.messages.length && (value.hasOlder || value.hasNewer))) return null;
  const messages: ReplyMessage[] = [], ids = new Set<string>(), commands = new Set<string>();
  let previousSeq = 0;
  for (const raw of value.messages) {
    const item = parseReplyMessage(raw, coupleId);
    if (!item || item.seq <= previousSeq || ids.has(item.id.toLowerCase())
      || commands.has(`${item.senderId.toLowerCase()}/${item.clientId.toLowerCase()}`)
      || (options.direction === 'before' && item.seq >= options.anchorSeq!)
      || (options.direction === 'after' && item.seq <= options.anchorSeq!)) return null;
    previousSeq = item.seq; ids.add(item.id.toLowerCase());
    commands.add(`${item.senderId.toLowerCase()}/${item.clientId.toLowerCase()}`); messages.push(item);
  }
  const cursor = (v: unknown, expected: ReplyMessage | undefined, enabled: boolean) => enabled
    ? record(v) && keys(v, 'id,seq') && v.id === expected?.id && v.seq === expected?.seq : v === null;
  if (!cursor(value.olderCursor, messages[0], value.hasOlder)
    || !cursor(value.newerCursor, messages.at(-1), value.hasNewer)) return null;
  return Object.freeze({ messages: Object.freeze(messages), readId: options.readId,
    hasOlder: value.hasOlder, hasNewer: value.hasNewer,
    olderCursor: value.hasOlder ? Object.freeze({ id: messages[0].id, seq: messages[0].seq }) : null,
    newerCursor: value.hasNewer ? Object.freeze({ id: messages[messages.length - 1].id, seq: messages[messages.length - 1].seq }) : null });
}
