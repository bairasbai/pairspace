import { exchangeReply, type ReplyTransportResult } from './reply-transport';
import { record, keys, uuid, positive, parseReplyMessage, type ReplyMessage } from './reply-model';
import type { TransportSession } from './transport';
import type { DisplayMessage } from './reply-view';
export type Reconciliation = Readonly<{
  messages: readonly ReplyMessage[]; unavailableIds: readonly string[];
  detail: Readonly<{ id: string; message: ReplyMessage | null }> | null;
  replyTarget: Readonly<{ id: string; message: ReplyMessage | null }> | null;
  latestVisible: Readonly<{ id: string; seq: number }> | null;
}>;
export type ReplyAnchor = Pick<DisplayMessage, 'id' | 'seq' | 'clientId' | 'senderId' | 'coupleId' | 'createdAt' | 'replyToId'>;
export const replyAnchor = (m: DisplayMessage): ReplyAnchor => ({ id: m.id, seq: m.seq, clientId: m.clientId, senderId: m.senderId, coupleId: m.coupleId, createdAt: m.createdAt, replyToId: m.replyToId });
export type ReconcileSelection = Readonly<{ messages: readonly DisplayMessage[]; detail?: DisplayMessage; replyTarget?: ReplyAnchor }>;
const identity = (old: ReplyAnchor, next: ReplyMessage) => old.id === next.id
  && old.seq === next.seq && old.clientId === next.clientId && old.senderId === next.senderId
  && old.coupleId === next.coupleId && old.createdAt === next.createdAt
  && (old.replyToId ?? null) === next.replyToId;
export function parseReconciliation(raw: unknown, coupleId: string, readId: string, selected: ReconcileSelection): Reconciliation | null {
  if (!record(raw) || !keys(raw, 'readId,messages,unavailableIds,detail,replyTarget,latestVisible') || raw.readId !== readId
    || !Array.isArray(raw.messages) || !Array.isArray(raw.unavailableIds)
    || raw.messages.length + raw.unavailableIds.length !== selected.messages.length) return null;
  const messages: ReplyMessage[] = [], unavailableIds: string[] = [];
  let liveIndex = 0, missingIndex = 0;
  for (const old of selected.messages) {
    if (raw.unavailableIds[missingIndex] === old.id) {
      unavailableIds.push(old.id); missingIndex++; continue;
    }
    const next = parseReplyMessage(raw.messages[liveIndex++], coupleId);
    if (!next || !identity(old, next)) return null;
    messages.push(next);
  }
  if (liveIndex !== raw.messages.length || missingIndex !== raw.unavailableIds.length) return null;
  const role = (rawRole: unknown, old: ReplyAnchor | undefined): Reconciliation['detail'] | false => {
    if (!old) return rawRole === null ? null : false;
    if (!record(rawRole) || !keys(rawRole, 'id,message') || rawRole.id !== old.id) return false;
    const next = rawRole.message === null ? null : parseReplyMessage(rawRole.message, coupleId);
    if (rawRole.message !== null && (!next || !identity(old, next))) return false;
    const row = messages.find(item => item.id === old.id);
    if (selected.messages.some(item => item.id === old.id)
      && (unavailableIds.includes(old.id) ? next !== null : JSON.stringify(row) !== JSON.stringify(next))) return false;
    return { id: old.id, message: next };
  };
  const detail = role(raw.detail, selected.detail), replyTarget = role(raw.replyTarget, selected.replyTarget);
  if (detail === false || replyTarget === false || (detail && replyTarget && detail.id === replyTarget.id
    && JSON.stringify(detail.message) !== JSON.stringify(replyTarget.message))) return null;
  let latestVisible: Reconciliation['latestVisible'] = null;
  if (raw.latestVisible !== null) {
    if (!record(raw.latestVisible) || !keys(raw.latestVisible, 'id,seq')
      || !uuid(raw.latestVisible.id) || !positive(raw.latestVisible.seq)) return null;
    latestVisible = { id: raw.latestVisible.id, seq: raw.latestVisible.seq };
  }
  for (const message of [...messages, ...(detail?.message ? [detail.message] : []), ...(replyTarget?.message ? [replyTarget.message] : [])]) {
    if (!latestVisible || latestVisible.seq < message.seq
      || (latestVisible.seq === message.seq) !== (latestVisible.id === message.id)) return null;
  }
  return { messages, unavailableIds, detail, replyTarget, latestVisible };
}
export async function readReconciliation(baseURL: string, credential: TransportSession, selected: ReconcileSelection,
  readId: string, request: (input: Request) => Promise<Response>): Promise<ReplyTransportResult<Reconciliation>> {
  const snapshot = { messages: selected.messages.map(message => ({ ...message })),
    ...(selected.detail ? { detail: { ...selected.detail } } : {}),
    ...(selected.replyTarget ? { replyTarget: { ...selected.replyTarget } } : {}) };
  if (!uuid(readId) || snapshot.messages.length > 50 || new Set(snapshot.messages.map(m => m.id)).size !== snapshot.messages.length
    || snapshot.messages.some(m => !uuid(m.id)) || (snapshot.detail && !uuid(snapshot.detail.id)) || (snapshot.replyTarget && !uuid(snapshot.replyTarget.id))) return { ok: false, error: 'invalid_request' };
  const params: Record<string, string> = { message_ids: snapshot.messages.map(message => message.id).join(',') };
  if (snapshot.detail) params.detail_id = snapshot.detail.id;
  if (snapshot.replyTarget) params.reply_target_id = snapshot.replyTarget.id;
  const result = await exchangeReply(baseURL, credential, 'reconcile', request,
    { readId, params, allowHttpLoopbackForTests: true });
  if (!result.ok) return result;
  const value = parseReconciliation(result.value, credential.scope.coupleId, readId, snapshot);
  return value ? { ok: true, value, visibilityRevision: result.visibilityRevision } : { ok: false, error: 'invalid_response' };
}
