import type { AuthorizedDatabase, Message, Principal, Result } from './contracts.ts';
import { authorizeChat } from './chat.ts';
import { activeSession, validPrincipal } from './session.ts';
import { isEpoch, isUuid } from './validation.ts';

export type ChatWindow = Readonly<{
  messages: Message[]; readId: string; hasOlder: boolean; hasNewer: boolean;
  olderCursor: { id: string; seq: number } | null; newerCursor: { id: string; seq: number } | null;
}>;
export type ReplyMessage = Omit<Message, 'body'> & { body: string | null; replyToId: string | null; deletedAt: string | null };
export type ReplyWindow = Omit<ChatWindow, 'messages'> & { messages: ReplyMessage[] };
type Row = { deleted_at?: string | null; reply_to_id?: string | null; id: string; couple_id: string; sender_id: string; client_message_id: string;
  seq: string; body: string | null; version: number; created_at: string };
const participantScope = `m.couple_id=$1 AND EXISTS(SELECT 1 FROM couple_members member
  WHERE member.couple_id=m.couple_id AND member.user_id=m.sender_id AND member.status='active')`;
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

/** Sequence is a scoped anchor, not a row count or an authority token. */
export function readChatWindow(db: AuthorizedDatabase, principal: Principal, input: unknown, replyAware?: false): Promise<Result<ChatWindow>>;
export function readChatWindow(db: AuthorizedDatabase, principal: Principal, input: unknown, replyAware: true): Promise<Result<ReplyWindow>>;
export function readChatWindow(db: AuthorizedDatabase, principal: Principal, input: unknown, replyAware: boolean): Promise<Result<ChatWindow | ReplyWindow>>;
export async function readChatWindow(db: AuthorizedDatabase, principal: Principal, input: unknown, replyAware = false): Promise<Result<ChatWindow | ReplyWindow>> {
  if (!validPrincipal(principal)) return { ok: false, error: 'unavailable' };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'invalid_request' };
  const f = input as Record<string, unknown>;
  const anchored = f.direction === 'before' || f.direction === 'after';
  const keys = ['coupleId', 'membershipEpoch', 'readId', 'direction', ...(anchored ? ['anchorId', 'anchorSeq'] : [])].sort();
  if (Object.keys(f).sort().join(',') !== keys.join(',') || !isUuid(f.coupleId)
    || !isEpoch(f.membershipEpoch) || !isUuid(f.readId)
    || !['latest', 'oldest', 'before', 'after'].includes(String(f.direction))) return { ok: false, error: 'invalid_request' };
  if (anchored && (!positive(f.anchorSeq) || !isUuid(f.anchorId))) return { ok: false, error: 'invalid_cursor' };
  const scoped = participantScope + (replyAware ? '' : " AND to_jsonb(m)->>'deleted_at' IS NULL");
  const coupleId = f.coupleId.toLowerCase(), epoch = f.membershipEpoch, readId = f.readId.toLowerCase();
  return db.transaction(async tx => {
    if (!await activeSession(tx, db, principal)) return { ok: false, error: 'unavailable' };
    const denied = await authorizeChat(tx, principal, coupleId, epoch, false);
    if (denied) return { ok: false, error: denied };
    if (!await activeSession(tx, db, principal)) return { ok: false, error: 'unavailable' };
    if (anchored && !(await tx.query(`SELECT m.seq FROM chat_messages m WHERE ${scoped} AND m.seq=$2 AND m.id=$3`, [coupleId, f.anchorSeq, f.anchorId])).rows.length) {
      return { ok: false, error: 'invalid_cursor' };
    }
    const ascending = f.direction === 'oldest' || f.direction === 'after';
    const rows = (await tx.query<Row>(`SELECT ${replyAware ? 'm.reply_to_id,m.deleted_at::text AS deleted_at,' : ''} m.id,m.couple_id,m.sender_id,m.client_message_id,
      m.seq::text AS seq,m.body,m.version,m.created_at::text AS created_at FROM chat_messages m
      WHERE ${scoped} ${anchored ? `AND m.seq ${ascending ? '>' : '<'} $2` : ''}
      ORDER BY m.seq ${ascending ? 'ASC' : 'DESC'} LIMIT 50`, [coupleId, ...(anchored ? [f.anchorSeq] : [])])).rows;
    if (!ascending) rows.reverse();
    let hasOlder = false, hasNewer = false;
    if (rows.length) {
      const flags = (await tx.query<{ older: boolean; newer: boolean }>(`SELECT
        EXISTS(SELECT 1 FROM chat_messages m WHERE ${scoped} AND m.seq<$2) older,
        EXISTS(SELECT 1 FROM chat_messages m WHERE ${scoped} AND m.seq>$3) newer`, [coupleId, rows[0].seq, rows[rows.length - 1].seq])).rows[0];
      hasOlder = flags.older; hasNewer = flags.newer;
    }
    const messages = rows.map((row): Message | ReplyMessage => {
      const common = { id: row.id, coupleId: row.couple_id, senderId: row.sender_id,
        clientId: row.client_message_id, seq: Number(row.seq), version: row.version, createdAt: row.created_at };
      if (replyAware) return { ...common, body: row.body, replyToId: row.reply_to_id ?? null,
        deletedAt: row.deleted_at ? new Date(row.deleted_at).toISOString() : null };
      if (row.body === null) throw new Error('legacy_tombstone_projection');
      return { ...common, body: row.body };
    });
    return { ok: true, value: { messages, readId, hasOlder, hasNewer,
      olderCursor: hasOlder ? { id: messages[0].id, seq: messages[0].seq } : null,
      newerCursor: hasNewer ? { id: messages[messages.length - 1].id, seq: messages[messages.length - 1].seq } : null } as ChatWindow | ReplyWindow };
  });
}
