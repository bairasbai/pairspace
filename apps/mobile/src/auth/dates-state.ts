import { isLocalDate, validatedTimezone } from '../../../../packages/domain/dates/calendar';
import { isDateSchedule, nextOccurrence, type Recurrence, type LeapDayPolicy } from '../../../../packages/domain/dates/recurrence';
import { normalizeTaskTitle } from '../../../../packages/domain/tasks/title';
import type { SessionContext } from './context';
export type SharedDate = Readonly<{ id: string; coupleId: string; creatorId: string;
  membershipEpoch: number; title: string; localDate: string; timezone: string; recurrence: Recurrence; leapDayPolicy: LeapDayPolicy | null;
  asOfLocalDate: string | null; nextOccurrence: string | null; createdAt: string }>;
export type DatesView = Readonly<{ available: boolean; busy: boolean; draft: string; localDate: string; timezone: string;
  recurrence: Recurrence; leapDayPolicy: LeapDayPolicy | null;
  status: 'idle' | 'saving' | 'retry' | 'saved' | 'invalid' | 'conflict' | 'unavailable';
  dates: readonly SharedDate[]; checked: boolean; error: boolean; requiresRefresh: boolean;
  pending: Readonly<{ title: string; localDate: string; timezone: string; recurrence: Recurrence; leapDayPolicy: LeapDayPolicy | null }> | null }>;
export const emptyDates: DatesView = { available: false, busy: false, draft: '', localDate: '', timezone: '', recurrence: 'once', leapDayPolicy: null, status: 'idle',
  dates: [], checked: false, error: false, requiresRefresh: false, pending: null };
export const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export function sameDateContext(a: SessionContext, b: SessionContext) {
  return a.state === 'ready' && b.state === 'ready' && a.sessionId === b.sessionId
    && a.userId === b.userId && a.coupleId === b.coupleId && a.membershipEpoch === b.membershipEpoch;
}
function instant(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const date = new Date(v);
  return Number.isFinite(date.getTime()) && date.toISOString() === v;
}
export function validDate(v: unknown, context: SessionContext): v is SharedDate {
  if (!record(v) || context.state !== 'ready'
    || Object.keys(v).sort().join(',') !== 'asOfLocalDate,coupleId,createdAt,creatorId,id,leapDayPolicy,localDate,membershipEpoch,nextOccurrence,recurrence,timezone,title') return false;
  const title = normalizeTaskTitle(v.title);
  return uuid(v.id) && uuid(v.creatorId) && v.coupleId === context.coupleId
    && v.membershipEpoch === context.membershipEpoch && title.ok && title.text === v.title
    && isLocalDate(v.localDate) && validatedTimezone(v.timezone) !== null
    && instant(v.createdAt) && isDateSchedule(v.localDate, v.recurrence, v.leapDayPolicy)
    && (v.asOfLocalDate === null ? v.nextOccurrence === null
      : isLocalDate(v.asOfLocalDate) && v.nextOccurrence === nextOccurrence(v.localDate,
        v.recurrence as Recurrence, v.leapDayPolicy as LeapDayPolicy | null, v.asOfLocalDate));
}
export function dateOrder(a: SharedDate, b: SharedDate) {
  return a.createdAt === b.createdAt ? (a.id > b.id ? -1 : a.id < b.id ? 1 : 0)
    : a.createdAt > b.createdAt ? -1 : 1;
}
