import { normalizeMessageText } from '../chat/text';
import { parseMorningSlot, type MorningScope, type MorningSlot } from './morning-model';
export type DiscussionCursor = { id: string; seq: number };
export type DiscussionMessage = {
  id: string; slotId: string; coupleId: string; membershipEpoch: number; authorId: string;
  clientId: string; seq: number; body: string; createdAt: string;
};
export type DiscussionPage = {
  readId: string; slotId: string; messages: DiscussionMessage[]; hasPrevious: boolean; hasNext: boolean;
  previousCursor: DiscussionCursor | null; nextCursor: DiscussionCursor | null;
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
export function parseDiscussionMessage(raw: unknown, scope: MorningScope, slot: MorningSlot): DiscussionMessage | null {
  if (!parseMorningSlot(slot, scope) || !object(raw)
    || !exact(raw, ['id', 'slotId', 'coupleId', 'membershipEpoch', 'authorId', 'clientId', 'seq', 'body', 'createdAt'])
    || !uuid(raw.id) || !uuid(raw.clientId) || raw.slotId !== slot.id || raw.coupleId !== scope.coupleId
    || raw.membershipEpoch !== scope.membershipEpoch || !uuid(raw.authorId)
    || (raw.authorId !== slot.senderId && raw.authorId !== slot.recipientId) || !positive(raw.seq)
    || !iso(raw.createdAt)) return null;
  const body = normalizeMessageText(raw.body);
  return body.ok && body.text === raw.body ? raw as DiscussionMessage : null;
}
function validCursor(raw: unknown): raw is DiscussionCursor {
  return object(raw) && exact(raw, ['id', 'seq']) && uuid(raw.id) && positive(raw.seq);
}
function edge(raw: unknown, message: DiscussionMessage | undefined, present: boolean): boolean {
  return present ? !!message && validCursor(raw) && raw.id === message.id && raw.seq === message.seq : raw === null;
}
export function parseDiscussionPage(raw: unknown, scope: MorningScope, slot: MorningSlot, readId: string,
  direction: 'first' | 'last' | 'before' | 'after', anchor?: DiscussionCursor): DiscussionPage | null {
  if (!parseMorningSlot(slot, scope) || !object(raw)
    || !exact(raw, ['readId', 'slotId', 'messages', 'hasPrevious', 'hasNext', 'previousCursor', 'nextCursor'])
    || !uuid(readId) || raw.readId !== readId || raw.slotId !== slot.id || !Array.isArray(raw.messages)
    || raw.messages.length > 30 || typeof raw.hasPrevious !== 'boolean' || typeof raw.hasNext !== 'boolean'
    || !['first', 'last', 'before', 'after'].includes(direction)
    || (direction === 'first' && raw.hasPrevious) || (direction === 'last' && raw.hasNext)) return null;
  const anchored = direction === 'before' || direction === 'after';
  if (anchored && !validCursor(anchor)) return null;
  const messages = raw.messages.map(message => parseDiscussionMessage(message, scope, slot));
  if (messages.some(message => !message)) return null;
  const parsed = messages as DiscussionMessage[];
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
  return raw as DiscussionPage;
}
