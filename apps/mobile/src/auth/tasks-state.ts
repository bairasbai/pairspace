import { normalizeTaskTitle } from '../../../../packages/domain/tasks/title';
import type { SessionContext } from './context';
export type SharedTask = Readonly<{ id: string; coupleId: string; creatorId: string;
  membershipEpoch: number; title: string; state: 'open' | 'completed'; version: number;
  createdAt: string; updatedAt: string }>;
export type TasksView = Readonly<{ available: boolean; busy: boolean; draft: string;
  status: 'idle' | 'saving' | 'retry' | 'saved' | 'invalid' | 'conflict' | 'unavailable';
  tasks: readonly SharedTask[]; checked: boolean; error: boolean; requiresRefresh: boolean;
  pending: Readonly<{ operation: 'create' | 'complete' | 'reopen'; title: string }> | null }>;
export const emptyTasks: TasksView = { available: false, busy: false, draft: '', status: 'idle',
  tasks: [], checked: false, error: false, requiresRefresh: false, pending: null };
export const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export function sameTaskContext(a: SessionContext, b: SessionContext) {
  return a.state === 'ready' && b.state === 'ready' && a.sessionId === b.sessionId
    && a.userId === b.userId && a.coupleId === b.coupleId && a.membershipEpoch === b.membershipEpoch;
}
function instant(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const date = new Date(v);
  return Number.isFinite(date.getTime()) && date.toISOString() === v;
}
export function validTask(v: unknown, context: SessionContext): v is SharedTask {
  if (!record(v) || context.state !== 'ready'
    || Object.keys(v).sort().join(',') !== 'coupleId,createdAt,creatorId,id,membershipEpoch,state,title,updatedAt,version') return false;
  const title = normalizeTaskTitle(v.title);
  return uuid(v.id) && uuid(v.creatorId) && v.coupleId === context.coupleId
    && v.membershipEpoch === context.membershipEpoch && title.ok && title.text === v.title
    && (v.state === 'open' || v.state === 'completed') && Number.isSafeInteger(v.version) && Number(v.version) > 0
    && instant(v.createdAt) && instant(v.updatedAt) && v.updatedAt >= v.createdAt;
}
export function taskOrder(a: SharedTask, b: SharedTask) {
  return a.createdAt === b.createdAt ? (a.id > b.id ? -1 : a.id < b.id ? 1 : 0)
    : a.createdAt > b.createdAt ? -1 : 1;
}
