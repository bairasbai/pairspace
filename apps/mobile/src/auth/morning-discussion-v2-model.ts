import { normalizeMessageText } from '../chat/text';
import { parseMorningSlot, type MorningScope, type MorningSlot } from './morning-model';
export type V2DiscussionCursor = { id: string; seq: number };
export type V2DiscussionMessage = {
  id: string; slotId: string; coupleId: string; membershipEpoch: number; authorId: string;
  clientId: string; seq: number; body: string | null; createdAt: string; version: number; editedAt: string | null; deletedAt: string | null;
};
export type V2DiscussionPage = {
  readId: string; slotId: string; messages: V2DiscussionMessage[]; hasPrevious: boolean; hasNext: boolean;
  previousCursor: V2DiscussionCursor | null; nextCursor: V2DiscussionCursor | null;
};
type RecordValue = Record<string, unknown>;
function object(v: unknown): v is RecordValue { return !!v && typeof v === 'object' && !Array.isArray(v); }
function exact(v: RecordValue, keys: string[]): boolean {
  return Object.keys(v).length === keys.length && keys.every(key => Object.hasOwn(v, key));
}
function uuid(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
}
function positive(v: unknown): v is number { return typeof v === 'number' && Number.isSafeInteger(v) && v > 0; }
function iso(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)
    && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
}
export function parseV2Message(raw: unknown, scope: MorningScope, slot: MorningSlot): V2DiscussionMessage | null {
  if (!parseMorningSlot(slot, scope) || !object(raw)
    || !exact(raw, ['id', 'slotId', 'coupleId', 'membershipEpoch', 'authorId', 'clientId', 'seq', 'body', 'createdAt', 'version', 'editedAt', 'deletedAt'])
    || !uuid(raw.id) || !uuid(raw.clientId) || raw.slotId !== slot.id || raw.coupleId !== scope.coupleId
    || raw.membershipEpoch !== scope.membershipEpoch || !uuid(raw.authorId)
    || (raw.authorId !== slot.senderId && raw.authorId !== slot.recipientId) || !positive(raw.seq)
    || !iso(raw.createdAt) || !positive(raw.version)
    || (raw.editedAt !== null && !iso(raw.editedAt))
    || (raw.deletedAt !== null && !iso(raw.deletedAt))
    || (typeof raw.editedAt === 'string' && raw.editedAt < raw.createdAt)
    || (typeof raw.deletedAt === 'string' && (raw.deletedAt < raw.createdAt
      || (typeof raw.editedAt === 'string' && raw.deletedAt < raw.editedAt)))) return null;
  if (raw.deletedAt !== null) return raw.body === null && raw.version >= 2 ? raw as V2DiscussionMessage : null;
  if ((raw.version === 1) !== (raw.editedAt === null)) return null;
  const body = normalizeMessageText(raw.body);
  return body.ok && body.text === raw.body ? raw as V2DiscussionMessage : null;
}
function validCursor(raw: unknown): raw is V2DiscussionCursor {
  return object(raw) && exact(raw, ['id', 'seq']) && uuid(raw.id) && positive(raw.seq);
}
function edge(raw: unknown, message: V2DiscussionMessage | undefined, present: boolean): boolean {
  return present ? !!message && validCursor(raw) && raw.id === message.id && raw.seq === message.seq : raw === null;
}
export function parseV2Page(raw: unknown, scope: MorningScope, slot: MorningSlot, readId: string,
  direction: 'first' | 'last' | 'before' | 'after', anchor?: V2DiscussionCursor): V2DiscussionPage | null {
  if (!parseMorningSlot(slot, scope) || !object(raw)
    || !exact(raw, ['readId', 'slotId', 'messages', 'hasPrevious', 'hasNext', 'previousCursor', 'nextCursor'])
    || !uuid(readId) || raw.readId !== readId || raw.slotId !== slot.id || !Array.isArray(raw.messages)
    || raw.messages.length > 30 || typeof raw.hasPrevious !== 'boolean' || typeof raw.hasNext !== 'boolean'
    || !['first', 'last', 'before', 'after'].includes(direction)
    || (direction === 'first' && raw.hasPrevious) || (direction === 'last' && raw.hasNext)) return null;
  const anchored = direction === 'before' || direction === 'after';
  if (anchored && !validCursor(anchor)) return null;
  const messages = raw.messages.map(message => parseV2Message(message, scope, slot));
  if (messages.some(message => !message)) return null;
  const parsed = messages as V2DiscussionMessage[];
  const ids = new Set<string>(), clients = new Set<string>();
  for (let i = 0; i < parsed.length; i++) {
    const message = parsed[i];
    if (ids.has(message.id) || clients.has(`${message.authorId}:${message.clientId}`) || (i > 0 && parsed[i - 1].seq >= message.seq)
      || (anchored && anchor && (message.id === anchor.id
        || (direction === 'before' ? message.seq >= anchor.seq : message.seq <= anchor.seq)))) return null;
    ids.add(message.id); clients.add(`${message.authorId}:${message.clientId}`);
  }
  if (!edge(raw.previousCursor, parsed[0], raw.hasPrevious)
    || !edge(raw.nextCursor, parsed.at(-1), raw.hasNext)) return null;
  return raw as V2DiscussionPage;
}
