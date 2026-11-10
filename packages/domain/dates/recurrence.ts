import { isLocalDate } from './calendar.ts';

export type Recurrence = 'once' | 'annual';
export type LeapDayPolicy = 'leap_years_only' | 'feb28' | 'mar1' | null;

/** A policy is meaningful only for an annually recurring February 29 anchor. */
export function isDateSchedule(localDate: unknown, recurrence: unknown, leapDayPolicy: unknown): boolean {
  if (!isLocalDate(localDate) || (recurrence !== 'once' && recurrence !== 'annual')) return false;
  if (recurrence === 'annual' && localDate.slice(5) === '02-29') {
    return leapDayPolicy === 'leap_years_only' || leapDayPolicy === 'feb28' || leapDayPolicy === 'mar1';
  }
  return leapDayPolicy === null;
}

/** Date-only Gregorian arithmetic. Same-day inclusive, never before the original anchor. */
export function nextOccurrence(localDate: string, recurrence: Recurrence, leapDayPolicy: LeapDayPolicy,
  asOfLocalDate: string): string | null {
  if (!isDateSchedule(localDate, recurrence, leapDayPolicy) || !isLocalDate(asOfLocalDate)) return null;
  if (recurrence === 'once') return localDate >= asOfLocalDate ? localDate : null;
  const start = Math.max(Number(localDate.slice(0, 4)), Number(asOfLocalDate.slice(0, 4)));
  for (let year = start; year <= 9999; year++) {
    const prefix = String(year).padStart(4, '0');
    let candidate = `${prefix}-${localDate.slice(5)}`;
    if (!isLocalDate(candidate)) {
      if (leapDayPolicy === 'leap_years_only') continue;
      candidate = `${prefix}-${leapDayPolicy === 'feb28' ? '02-28' : '03-01'}`;
    }
    if (candidate >= localDate && candidate >= asOfLocalDate) return candidate;
  }
  return null;
}

/** Only the server supplies this instant. Intl obtains today's label, never performs recurrence arithmetic. */
export function zonedLocalDate(now: Date, timezone: string): string | null {
  if (!Number.isFinite(now.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, calendar: 'gregory',
      numberingSystem: 'latn', year: 'numeric', month: '2-digit', day: '2-digit', era: 'short' }).formatToParts(now);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value;
    if (part('era') !== 'AD') return null;
    const label = `${(part('year') ?? '').padStart(4, '0')}-${part('month')}-${part('day')}`;
    return isLocalDate(label) ? label : null;
  } catch { return null; }
}
