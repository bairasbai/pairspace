import { canReadDisputeMetadata, followsDisputeMetadata, latestDisputeEvent, validDisputeMetadata,
  type DisputeMetadata } from '../../../../packages/domain/disputes/metadata';
import { instant } from '../../../../packages/domain/disputes/validation';
export { canReadDisputeMetadata, createDisputeMetadata, declineDisputeMetadata, followsDisputeMetadata,
  joinDisputeMetadata, latestDisputeEvent, removeDisputeMetadata, resolveDisputeMetadata,
  validDisputeMetadata } from '../../../../packages/domain/disputes/metadata';
export { exact, instant, localDay, normalizeDisputeClaim, normalizeDisputeCondition, parseDisputeSchedule,
  record, uuid } from '../../../../packages/domain/disputes/validation';
export type { DisputeMetadata };
export type DisputeView = Readonly<{
  generation: number; revision: number; available: boolean; userId: string | null; busy: boolean;
  checked: boolean; checkedAt: string | null; disputes: readonly DisputeMetadata[]; used: number; capacity: 100;
  draftClaim: string; draftCondition: string; judgeDate: string; timezone: string;
  reader: Readonly<{ dispute: DisputeMetadata; claim: string; condition: string | null; checkedAt: string; generation: number }> | null;
  readerStatus: 'closed' | 'loading' | 'opened' | 'changed' | 'error';
  pending: boolean; requiresRefresh: boolean; error: boolean;
  status: 'idle' | 'saving' | 'retry' | 'saved' | 'invalid' | 'conflict' | 'unavailable' | 'limit' | 'not_due';
}>;
export const emptyDisputes: DisputeView = Object.freeze({
  generation: 0, revision: 0, available: false, userId: null, busy: false, checked: false, checkedAt: null,
  disputes: Object.freeze([]), used: 0, capacity: 100, draftClaim: '', draftCondition: '', judgeDate: '', timezone: '',
  reader: null, readerStatus: 'closed', pending: false, requiresRefresh: false, error: false, status: 'idle',
});
export const disputeOrder = (a: DisputeMetadata, b: DisputeMetadata) => a.createdAt === b.createdAt
  ? (a.id === b.id ? 0 : a.id > b.id ? -1 : 1) : a.createdAt > b.createdAt ? -1 : 1;
/** A detail or ACK establishes one record, never completeness of a bounded history. */
export function mergeDispute(view: DisputeView, next: DisputeMetadata, checkedAt: string): Pick<DisputeView, 'disputes' | 'used' | 'reader'> {
  const scope = { coupleId: next.coupleId, membershipEpoch: next.membershipEpoch, userId: view.userId! };
  const old = view.disputes.find(q => q.id === next.id);
  if (!instant(checkedAt) || (view.checkedAt !== null && checkedAt < view.checkedAt)
    || !validDisputeMetadata(next, scope) || latestDisputeEvent(next) > checkedAt
    || (old && !followsDisputeMetadata(old, next, scope)) || (!old && view.disputes.length >= 100)) throw Error('invalid_dispute_revision');
  const disputes = [...view.disputes.filter(q => q.id !== next.id), next].sort(disputeOrder);
  const reader = view.reader && (view.reader.generation !== view.generation
    || !canReadDisputeMetadata(view.reader.dispute, scope, checkedAt)
    || (view.reader.dispute.id === next.id && view.reader.dispute.version !== next.version)) ? null : view.reader;
  return { disputes, used: Math.max(view.used, disputes.length), reader };
}
