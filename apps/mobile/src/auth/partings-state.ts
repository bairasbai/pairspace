import { partingRange } from '../../../../packages/domain/partings/range';
import { isLocalDate, validatedTimezone } from '../../../../packages/domain/dates/calendar';
import { zonedLocalDate } from '../../../../packages/domain/dates/recurrence';
import { normalizeTaskTitle } from '../../../../packages/domain/tasks/title';
import type { SessionContext } from './context';
import { record, uuid, sameDateContext } from './dates-state';
export { record, uuid, sameDateContext };
export type Parting = Readonly<{ id: string; coupleId: string; creatorId: string; membershipEpoch: number;
  title: string; startDate: string; endDate: string; timezone: string; startsAt: string; endsAt: string; createdAt: string; version: number }>;
export type PartingsView = Readonly<{ available: boolean; busy: boolean; draft: string; startDate: string; endDate: string; timezone: string;
  editing: Readonly<{ id: string; version: number }> | null;
  status: 'idle' | 'saving' | 'retry' | 'saved' | 'invalid' | 'conflict' | 'unavailable';
  partings: readonly Parting[]; asOf: string | null; checked: boolean; error: boolean; requiresRefresh: boolean;
  pending: Readonly<{ title: string; startDate: string; endDate: string; timezone: string }> | null }>;
export const emptyPartings: PartingsView = { available: false, busy: false, draft: '', startDate: '', endDate: '', timezone: '',
  editing: null, status: 'idle', partings: [], asOf: null, checked: false, error: false, requiresRefresh: false, pending: null };
export function instant(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const d = new Date(v); return Number.isFinite(d.getTime()) && d.toISOString() === v;
}
export function isPartingDates(start: unknown, end: unknown): start is string {
  return isLocalDate(start) && isLocalDate(end) && start >= '2000-01-01' && end <= '2100-12-31' && start <= end;
}
export function nextDay(value: string) { return new Date(Date.parse(value + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10); }
export function validParting(v: unknown, c: SessionContext): v is Parting {
  if (!record(v) || c.state !== 'ready' || Object.keys(v).sort().join(',') !== 'coupleId,createdAt,creatorId,endDate,endsAt,id,membershipEpoch,startDate,startsAt,timezone,title,version') return false;
  const title = normalizeTaskTitle(v.title);
  const valid = uuid(v.id) && uuid(v.creatorId) && v.coupleId === c.coupleId && v.membershipEpoch === c.membershipEpoch
    && Number.isSafeInteger(v.version) && (v.version as number) > 0 && (v.version as number) <= 2147483647
    && title.ok && title.text === v.title && isPartingDates(v.startDate, v.endDate) && validatedTimezone(v.timezone) !== null
    && instant(v.createdAt) && instant(v.startsAt) && instant(v.endsAt) && v.startsAt < v.endsAt
    && zonedLocalDate(new Date(v.startsAt), v.timezone as string) === v.startDate
    && zonedLocalDate(new Date(v.endsAt), v.timezone as string) === nextDay(v.endDate as string);
  if (!valid) return false;
  // Validate once at the response boundary, never in render or on keystrokes.
  const range = partingRange(v.startDate, v.endDate, v.timezone);
  return range !== null && range.startsAt === v.startsAt && range.endsAt === v.endsAt;
}
export function partingOrder(a: Parting, b: Parting) { return a.startsAt === b.startsAt ? a.id.localeCompare(b.id) : a.startsAt.localeCompare(b.startsAt); }
export function partingProgress(p: Parting, asOf: string): { state: 'upcoming' | 'current' | 'past'; days: number } {
  const today = zonedLocalDate(new Date(asOf), p.timezone)!;
  const days = (target: string) => Math.round((Date.parse(target + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000);
  return asOf < p.startsAt ? { state: 'upcoming', days: days(p.startDate) }
    : asOf >= p.endsAt ? { state: 'past', days: 0 } : { state: 'current', days: days(nextDay(p.endDate)) };
}
