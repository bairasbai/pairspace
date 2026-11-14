import type { AuthorizedDatabase, Principal, Result } from './contracts.ts';
import { authorizeChat } from './chat.ts';
import { activeSession, validPrincipal } from './session.ts';
import { isEpoch, isUuid } from './validation.ts';
import { visibleChatPredicate } from './chat-visibility-scope.ts';
import { convert, type Row, type ReplyMessage } from './chat-replies.ts';

export type ChatReconciliation = {
  readId: string;
  messages: ReplyMessage[];
  unavailableIds: string[];
  detail: { id: string; message: ReplyMessage | null } | null;
  replyTarget: { id: string; message: ReplyMessage | null } | null;
  latestVisible: { id: string; seq: number } | null;
};

/** Bounded canonical refresh, never a history expansion or an existence oracle. */
export async function reconcileChat(db: AuthorizedDatabase, principal: Principal, input: unknown): Promise<Result<ChatReconciliation>> {
  if (!validPrincipal(principal)) return { ok: false, error: 'unavailable' };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'invalid_request' };
  const f = input as Record<string, unknown>;
  const keys = ['coupleId', 'membershipEpoch', 'readId', 'messageIds', ...(Object.hasOwn(f, 'detailId') ? ['detailId'] : []), ...(Object.hasOwn(f, 'replyTargetId') ? ['replyTargetId'] : [])];
  if (Object.keys(f).sort().join(',') !== keys.sort().join(',') || !isUuid(f.coupleId)
    || !isEpoch(f.membershipEpoch) || !isUuid(f.readId) || !Array.isArray(f.messageIds)
    || f.messageIds.length > 50 || !f.messageIds.every(isUuid)
    || (Object.hasOwn(f, 'detailId') && !isUuid(f.detailId))
    || (Object.hasOwn(f, 'replyTargetId') && !isUuid(f.replyTargetId))) return { ok: false, error: 'invalid_request' };
  const ids = (f.messageIds as string[]).map(id => id.toLowerCase());
  if (new Set(ids).size !== ids.length) return { ok: false, error: 'invalid_request' };
  const coupleId = f.coupleId.toLowerCase(), epoch = f.membershipEpoch;
  const detailId = typeof f.detailId === 'string' ? f.detailId.toLowerCase() : null;
  const replyTargetId = typeof f.replyTargetId === 'string' ? f.replyTargetId.toLowerCase() : null;
  const requested = [...new Set([...ids, ...(detailId ? [detailId] : []), ...(replyTargetId ? [replyTargetId] : [])])];
  return db.transaction(async tx => {
    if (!await activeSession(tx, db, principal)) return { ok: false, error: 'unavailable' };
    const denied = await authorizeChat(tx, principal, coupleId, epoch, false);
    if (denied) return { ok: false, error: denied };
    if (!await activeSession(tx, db, principal)) return { ok: false, error: 'unavailable' };
    const scope = `m.couple_id=$1 AND EXISTS(SELECT 1 FROM couple_members cm
      WHERE cm.couple_id=m.couple_id AND cm.user_id=m.sender_id AND cm.status='active')
      AND ${await visibleChatPredicate(tx, 'm')}`;
    // The visibility predicate is inside the body SELECT, not an after-read redaction.
    const rows = requested.length ? (await tx.query<Row>(`SELECT m.id,m.couple_id,m.sender_id,
      m.client_message_id,m.seq::text AS seq,m.body,m.version,m.created_at::text AS created_at,
      m.reply_to_id,m.deleted_at::text AS deleted_at FROM chat_messages m
      WHERE ${scope} AND m.id=ANY($2::uuid[])`, [coupleId, requested])).rows : [];
    const byId = new Map(rows.map(row => [row.id, convert(row)]));
    const latest = (await tx.query<{ id: string; seq: string }>(`SELECT m.id,m.seq::text AS seq
      FROM chat_messages m WHERE ${scope} ORDER BY m.seq DESC LIMIT 1`, [coupleId])).rows[0];
    const messages = ids.flatMap(id => byId.has(id) ? [byId.get(id)!] : []);
    return { ok: true, value: {
      readId: String(f.readId).toLowerCase(), messages,
      unavailableIds: ids.filter(id => !byId.has(id)),
      detail: detailId ? { id: detailId, message: byId.get(detailId) ?? null } : null,
      replyTarget: replyTargetId ? { id: replyTargetId, message: byId.get(replyTargetId) ?? null } : null,
      latestVisible: latest ? { id: latest.id, seq: Number(latest.seq) } : null,
    } };
  });
}
