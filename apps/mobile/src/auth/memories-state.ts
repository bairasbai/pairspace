import { isLocalDate } from '../../../../packages/domain/dates/calendar';
import { normalizeTaskTitle } from '../../../../packages/domain/tasks/title';
import { normalizeMemoryBody } from '../../../../packages/domain/memories/text';
import type { SessionContext } from './context';
export type SharedMemory = Readonly<{ id: string; coupleId: string; creatorId: string;
  membershipEpoch: number; title: string; body: string; localDate: string; createdAt: string }>;
export type MemoriesView = Readonly<{ available: boolean; busy: boolean; draft: string; body: string; localDate: string; consent: boolean;
  status: 'idle' | 'saving' | 'retry' | 'saved' | 'invalid' | 'conflict' | 'unavailable';
  memories: readonly SharedMemory[]; checked: boolean; error: boolean; requiresRefresh: boolean;
  pending: Readonly<{ title: string; body: string; localDate: string }> | null }>;
export const emptyMemories: MemoriesView = { available: false, busy: false, draft: '', body: '', localDate: '', consent: false,
  status: 'idle', memories: [], checked: false, error: false, requiresRefresh: false, pending: null };
export const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export function sameMemoryContext(a: SessionContext, b: SessionContext) {
  return a.state === 'ready' && b.state === 'ready' && a.sessionId === b.sessionId
    && a.userId === b.userId && a.coupleId === b.coupleId && a.membershipEpoch === b.membershipEpoch;
}
function instant(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const date = new Date(v);
  return Number.isFinite(date.getTime()) && date.toISOString() === v;
}
export function validMemory(v: unknown, context: SessionContext): v is SharedMemory {
  if (!record(v) || context.state !== 'ready'
    || Object.keys(v).sort().join(',') !== 'body,coupleId,createdAt,creatorId,id,localDate,membershipEpoch,title') return false;
  const title = normalizeTaskTitle(v.title), body = normalizeMemoryBody(v.body);
  return uuid(v.id) && uuid(v.creatorId) && v.coupleId === context.coupleId
    && v.membershipEpoch === context.membershipEpoch && title.ok && title.text === v.title
    && body.ok && body.text === v.body && isLocalDate(v.localDate) && instant(v.createdAt);
}
export function memoryOrder(a: SharedMemory, b: SharedMemory) {
  return a.createdAt === b.createdAt ? (a.id > b.id ? -1 : a.id < b.id ? 1 : 0)
    : a.createdAt > b.createdAt ? -1 : 1;
}
