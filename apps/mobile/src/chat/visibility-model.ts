import { keys, positive, record, uuid } from './reply-model';
export type MessageVisibility = Readonly<{ messageId: string; hidden: boolean; version: number }>;
export type HiddenMessage = Readonly<{ id: string; coupleId: string; senderId: string; clientId: string;
  seq: number; version: number; createdAt: string; replyToId: string | null; deletedAt: string | null }>;
export type HiddenRow = HiddenMessage & Readonly<{ visibilityVersion: number }>;
export type HiddenWindow = Readonly<{ messages: readonly HiddenRow[]; readId: string; hasOlder: boolean; hasNewer: boolean;
  olderCursor: Readonly<{ id: string; seq: number }> | null; newerCursor: Readonly<{ id: string; seq: number }> | null }>;
export const nonnegative = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
function timestamp(v: unknown): v is string { return typeof v === 'string' && v.length <= 64 && Number.isFinite(Date.parse(v)); }
function deleted(v: unknown) { return v === null || (timestamp(v) && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && new Date(v).toISOString() === v); }
export function parseMessageVisibility(value: unknown, messageId: string): MessageVisibility | null {
  return record(value) && keys(value, 'messageId,hidden,version') && uuid(messageId) && value.messageId === messageId
    && typeof value.hidden === 'boolean' && nonnegative(value.version) && (value.version !== 0 || !value.hidden)
    ? Object.freeze({ ...value }) as MessageVisibility : null;
}
export function parseHiddenMessage(value: unknown, coupleId: string): HiddenMessage | null {
  if (!record(value) || !keys(value, 'id,coupleId,senderId,clientId,seq,version,createdAt,replyToId,deletedAt')
    || !uuid(value.id) || !uuid(value.coupleId) || value.coupleId !== coupleId || !uuid(value.senderId) || !uuid(value.clientId)
    || !positive(value.seq) || !positive(value.version) || !timestamp(value.createdAt) || !deleted(value.deletedAt)
    || (value.replyToId !== null && (!uuid(value.replyToId) || value.replyToId === value.id))) return null;
  return Object.freeze({ ...value }) as HiddenMessage;
}
export type HiddenWindowOptions = Readonly<{ direction: 'latest' | 'oldest' | 'before' | 'after'; readId: string;
  anchorId?: string; anchorSeq?: number; visibilityRevision?: number; allowHttpLoopbackForTests?: boolean }>;
export function parseHiddenWindow(value: unknown, options: HiddenWindowOptions, coupleId: string): HiddenWindow | null {
  if (!record(value) || !keys(value, 'messages,readId,hasOlder,hasNewer,olderCursor,newerCursor') || value.readId !== options.readId
    || !Array.isArray(value.messages) || value.messages.length > 50 || typeof value.hasOlder !== 'boolean' || typeof value.hasNewer !== 'boolean'
    || (options.direction === 'latest' && value.hasNewer) || (options.direction === 'oldest' && value.hasOlder)
    || (!value.messages.length && (value.hasOlder || value.hasNewer))) return null;
  const rows: HiddenRow[] = [], ids = new Set<string>();
  for (const row of value.messages) {
    if (!record(row) || !keys(row, 'id,coupleId,senderId,clientId,seq,version,createdAt,replyToId,deletedAt,visibilityVersion')
      || !positive(row.visibilityVersion)) return null;
    const metadata = { ...row };
    delete metadata.visibilityVersion;
    const parsed = parseHiddenMessage(metadata, coupleId);
    if (!parsed || ids.has(parsed.id)
      || (rows.length > 0 && parsed.seq <= rows[rows.length - 1].seq)
      || (options.direction === 'before' && parsed.seq >= options.anchorSeq!)
      || (options.direction === 'after' && parsed.seq <= options.anchorSeq!)) return null;
    ids.add(parsed.id); rows.push(Object.freeze({ ...row }) as HiddenRow);
  }
  const cursor = (v: unknown, row: HiddenRow | undefined, enabled: boolean) => enabled
    ? record(v) && keys(v, 'id,seq') && !!row && v.id === row.id && v.seq === row.seq : v === null;
  if (!cursor(value.olderCursor, rows[0], value.hasOlder) || !cursor(value.newerCursor, rows.at(-1), value.hasNewer)) return null;
  return Object.freeze({ ...value, messages: Object.freeze(rows) }) as HiddenWindow;
}
