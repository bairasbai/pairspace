import { followsDoing, orderDoings, type DoingKind, type SharedDoing } from '../../../../packages/domain/doings/state';
export { canAdvanceDoing, completeDoing, exact, followsDoing, instant, integer, kind, normalizeDoingTitle,
  orderDoings, record, uuid, validDoing } from '../../../../packages/domain/doings/state';
export type { DoingKind, SharedDoing };
export type DoingChoice = 'join' | 'decline' | 'remove';
export type DoingDraft = Readonly<{ title: string; kind: DoingKind; parts: string }>;
export const freshDoingDraft = (): DoingDraft => Object.freeze({ title: '', kind: 'book', parts: '10' });
export type DoingsView = Readonly<{ generation: number; available: boolean; userId: string | null; busy: boolean;
  checked: boolean; checkedAt: string | null; doings: readonly SharedDoing[]; used: number; capacity: 100;
  draft: DoingDraft; pending: boolean; requiresRefresh: boolean; error: boolean;
  status: 'idle' | 'saving' | 'retry' | 'saved' | 'invalid' | 'conflict' | 'unavailable' | 'limit' }>;
export const emptyDoings: DoingsView = Object.freeze({ generation: 0, available: false, userId: null, busy: false,
  checked: false, checkedAt: null, doings: [], used: 0, capacity: 100, draft: freshDoingDraft(),
  pending: false, requiresRefresh: false, error: false, status: 'idle' });
export function mayChooseDoing(d: SharedDoing, actor: string | null, choice: DoingChoice) {
  return d.contentState === 'active' && (choice === 'remove' ? d.authorId === actor : d.recipientId === actor
    && (choice === 'join' ? d.decisionState === 'invited' : d.decisionState !== 'declined'));
}
export function mergeDoing(view: DoingsView, next: SharedDoing): Pick<DoingsView, 'doings' | 'used'> {
  const old = view.doings.find(d => d.id === next.id);
  if ((old && !followsDoing(old, next)) || view.doings.some(d => d.id !== next.id && d.sequence === next.sequence)
    || (!old && view.doings.length >= 100)) throw Error('invalid_shared_doing_revision');
  return { doings: [...view.doings.filter(d => d.id !== next.id), next].sort(orderDoings), used: Math.max(view.used, next.sequence) };
}
