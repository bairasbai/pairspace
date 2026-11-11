import { normalizeWishExplanation } from '../../../../packages/domain/wishes/text';
import { normalizeTaskTitle } from '../../../../packages/domain/tasks/title';
import type { SessionContext } from './context';
export type SharedWish = Readonly<{ id: string; coupleId: string; creatorId: string;
  membershipEpoch: number; title: string; explanation: string; state: 'open' | 'fulfilled'; version: number;
  createdAt: string; updatedAt: string }>;
export type WishesView = Readonly<{ available: boolean; busy: boolean; draft: string; explanation: string; consent: boolean;
  status: 'idle' | 'saving' | 'retry' | 'saved' | 'invalid' | 'conflict' | 'unavailable';
  wishes: readonly SharedWish[]; checked: boolean; error: boolean; requiresRefresh: boolean;
  pending: Readonly<{ operation: 'create' | 'fulfill' | 'reopen'; title: string; explanation: string }> | null }>;
export const emptyWishes: WishesView = { available: false, busy: false, draft: '', explanation: '', consent: false, status: 'idle',
  wishes: [], checked: false, error: false, requiresRefresh: false, pending: null };
export const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export function sameWishContext(a: SessionContext, b: SessionContext) {
  return a.state === 'ready' && b.state === 'ready' && a.sessionId === b.sessionId
    && a.userId === b.userId && a.coupleId === b.coupleId && a.membershipEpoch === b.membershipEpoch;
}
function instant(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const date = new Date(v);
  return Number.isFinite(date.getTime()) && date.toISOString() === v;
}
export function validWish(v: unknown, context: SessionContext): v is SharedWish {
  if (!record(v) || context.state !== 'ready'
    || Object.keys(v).sort().join(',') !== 'coupleId,createdAt,creatorId,explanation,id,membershipEpoch,state,title,updatedAt,version') return false;
  const title = normalizeTaskTitle(v.title);
  const explanation = normalizeWishExplanation(v.explanation);
  return uuid(v.id) && uuid(v.creatorId) && v.coupleId === context.coupleId
    && v.membershipEpoch === context.membershipEpoch && title.ok && title.text === v.title
    && explanation.ok && explanation.text === v.explanation
    && (v.state === 'open' || v.state === 'fulfilled') && Number.isSafeInteger(v.version) && Number(v.version) > 0 && Number(v.version) <= 2147483647
    && instant(v.createdAt) && instant(v.updatedAt) && v.updatedAt >= v.createdAt;
}
export function wishOrder(a: SharedWish, b: SharedWish) {
  return a.createdAt === b.createdAt ? (a.id > b.id ? -1 : a.id < b.id ? 1 : 0)
    : a.createdAt > b.createdAt ? -1 : 1;
}
